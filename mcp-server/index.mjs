#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BACKEND = process.env.SONCAD_BACKEND || 'http://localhost:3002';

// ── In-memory drawing state ──

let nextId = 1;
let entities = [];
let layers = [
  { name: '0', color: '#ffffff', visible: true, locked: false, frozen: false, current: true, lineweight: 1, plot: true },
];
let currentLayer = '0';

function makeEntity(type, props) {
  const layer = layers.find(l => l.current);
  return {
    id: String(nextId++),
    type,
    layer: layer?.name || '0',
    color: '#ffffff',
    lineweight: 1,
    linetype: 'Continuous',
    visible: true,
    selected: false,
    ...props,
  };
}

async function syncToBrowser() {
  try {
    await fetch(`${BACKEND}/api/mcp/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entities, layers }),
    });
  } catch (_) {
    // backend may be offline — not critical
  }
}

function findEntity(id) {
  return entities.find(e => e.id === String(id));
}

function getBounds() {
  if (entities.length === 0) return { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of entities) {
    const pts = entityPoints(e);
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } };
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

function entityPoints(e) {
  switch (e.type) {
    case 'line': return [e.start, e.end];
    case 'circle': return [
      { x: e.center.x - e.radius, y: e.center.y - e.radius },
      { x: e.center.x + e.radius, y: e.center.y + e.radius },
    ];
    case 'arc': return [e.center];
    case 'polyline': return e.points;
    case 'rect': return [e.corner1, e.corner2];
    case 'text': return [e.position];
    case 'dimension': return [e.p1, e.p2, e.textPos];
    case 'point': return [e.position];
    case 'ellipse': return [e.center];
    case 'hatch': return (e.boundaries || []).flat();
    default: return [];
  }
}

function movePoint(p, dx, dy) {
  return { x: p.x + dx, y: p.y + dy };
}

function rotatePoint(p, cx, cy, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

function scalePoint(p, cx, cy, factor) {
  return { x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor };
}

function mirrorPoint(p, p1, p2) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return p;
  const t = ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / len2;
  const projX = p1.x + t * dx, projY = p1.y + t * dy;
  return { x: 2 * projX - p.x, y: 2 * projY - p.y };
}

function transformEntity(e, fn) {
  const clone = JSON.parse(JSON.stringify(e));
  switch (clone.type) {
    case 'line':
      clone.start = fn(clone.start);
      clone.end = fn(clone.end);
      break;
    case 'circle':
      clone.center = fn(clone.center);
      break;
    case 'arc':
      clone.center = fn(clone.center);
      break;
    case 'polyline':
      clone.points = clone.points.map(fn);
      break;
    case 'rect':
      clone.corner1 = fn(clone.corner1);
      clone.corner2 = fn(clone.corner2);
      break;
    case 'text':
      clone.position = fn(clone.position);
      break;
    case 'point':
      clone.position = fn(clone.position);
      break;
    case 'dimension':
      clone.p1 = fn(clone.p1);
      clone.p2 = fn(clone.p2);
      clone.textPos = fn(clone.textPos);
      break;
    case 'ellipse':
      clone.center = fn(clone.center);
      break;
    case 'hatch':
      if (clone.boundaries) clone.boundaries = clone.boundaries.map(b => b.map(fn));
      break;
  }
  return clone;
}

// ── MCP Server ──

const server = new McpServer({
  name: 'soncad',
  version: '0.1.0',
});

const PointSchema = z.object({ x: z.number(), y: z.number() });

// ── Drawing tools ──

server.tool('add_line',
  'Draw a line from start to end point',
  { start_x: z.number(), start_y: z.number(), end_x: z.number(), end_y: z.number(), layer: z.string().optional() },
  async ({ start_x, start_y, end_x, end_y, layer }) => {
    const e = makeEntity('line', {
      start: { x: start_x, y: start_y },
      end: { x: end_x, y: end_y },
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Line added (id=${e.id}): (${start_x},${start_y}) → (${end_x},${end_y})` }] };
  }
);

server.tool('add_polyline',
  'Draw a polyline through a list of points. Set closed=true for a closed polygon.',
  { points: z.array(z.object({ x: z.number(), y: z.number() })).min(2), closed: z.boolean().default(false), layer: z.string().optional() },
  async ({ points, closed, layer }) => {
    const e = makeEntity('polyline', {
      points,
      bulges: new Array(points.length).fill(0),
      closed,
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Polyline added (id=${e.id}): ${points.length} points, closed=${closed}` }] };
  }
);

server.tool('add_rectangle',
  'Draw a rectangle from corner1 to corner2 (opposite corners)',
  { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), layer: z.string().optional() },
  async ({ x1, y1, x2, y2, layer }) => {
    const e = makeEntity('rect', {
      corner1: { x: x1, y: y1 },
      corner2: { x: x2, y: y2 },
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Rectangle added (id=${e.id}): (${x1},${y1}) → (${x2},${y2})` }] };
  }
);

server.tool('add_circle',
  'Draw a circle at center with radius',
  { center_x: z.number(), center_y: z.number(), radius: z.number().positive(), layer: z.string().optional() },
  async ({ center_x, center_y, radius, layer }) => {
    const e = makeEntity('circle', {
      center: { x: center_x, y: center_y },
      radius,
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Circle added (id=${e.id}): center=(${center_x},${center_y}), r=${radius}` }] };
  }
);

server.tool('add_arc',
  'Draw an arc at center with radius, from startAngle to endAngle (degrees, counterclockwise)',
  { center_x: z.number(), center_y: z.number(), radius: z.number().positive(), start_angle: z.number(), end_angle: z.number(), layer: z.string().optional() },
  async ({ center_x, center_y, radius, start_angle, end_angle, layer }) => {
    const e = makeEntity('arc', {
      center: { x: center_x, y: center_y },
      radius,
      startAngle: start_angle,
      endAngle: end_angle,
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Arc added (id=${e.id}): center=(${center_x},${center_y}), r=${radius}, ${start_angle}°→${end_angle}°` }] };
  }
);

server.tool('add_text',
  'Add a text label at position',
  { x: z.number(), y: z.number(), text: z.string(), height: z.number().positive().default(0.25), rotation: z.number().default(0), layer: z.string().optional() },
  async ({ x, y, text, height, rotation, layer }) => {
    const e = makeEntity('text', {
      position: { x, y },
      text,
      height,
      rotation,
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Text added (id=${e.id}): "${text}" at (${x},${y})` }] };
  }
);

server.tool('add_dimension',
  'Add a linear or aligned dimension between two points',
  {
    dim_type: z.enum(['linear', 'aligned']).default('linear'),
    x1: z.number(), y1: z.number(),
    x2: z.number(), y2: z.number(),
    text_x: z.number(), text_y: z.number(),
    text_override: z.string().optional(),
    layer: z.string().optional(),
  },
  async ({ dim_type, x1, y1, x2, y2, text_x, text_y, text_override, layer }) => {
    const e = makeEntity('dimension', {
      dimType: dim_type,
      p1: { x: x1, y: y1 },
      p2: { x: x2, y: y2 },
      textPos: { x: text_x, y: text_y },
      ...(text_override && { textOverride: text_override }),
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Dimension added (id=${e.id}): ${dim_type} (${x1},${y1})→(${x2},${y2})` }] };
  }
);

server.tool('add_ellipse',
  'Draw an ellipse. majorX/majorY define the major axis direction and length from center. ratio is minor/major (0-1). startParam/endParam (0 to 2π) for partial ellipse.',
  {
    center_x: z.number(), center_y: z.number(),
    major_axis_x: z.number().describe('X component of major axis vector from center'),
    major_axis_y: z.number().describe('Y component of major axis vector from center'),
    ratio: z.number().min(0).max(1).default(1).describe('Minor/major axis ratio (1 = circle)'),
    start_param: z.number().default(0).describe('Start parameter (0 = full ellipse)'),
    end_param: z.number().default(6.283185307).describe('End parameter (2π = full ellipse)'),
    layer: z.string().optional(),
  },
  async ({ center_x, center_y, major_axis_x, major_axis_y, ratio, start_param, end_param, layer }) => {
    const e = makeEntity('ellipse', {
      center: { x: center_x, y: center_y },
      majorX: major_axis_x,
      majorY: major_axis_y,
      ratio,
      startParam: start_param,
      endParam: end_param,
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    const majLen = Math.sqrt(major_axis_x ** 2 + major_axis_y ** 2).toFixed(2);
    return { content: [{ type: 'text', text: `Ellipse added (id=${e.id}): center=(${center_x},${center_y}), major=${majLen}, ratio=${ratio}` }] };
  }
);

server.tool('add_point',
  'Place a point marker at a position',
  { x: z.number(), y: z.number(), layer: z.string().optional() },
  async ({ x, y, layer }) => {
    const e = makeEntity('point', {
      position: { x, y },
      pdmode: 3,
      pdsize: 5,
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Point added (id=${e.id}): (${x},${y})` }] };
  }
);

server.tool('add_polygon',
  'Draw a regular polygon with N sides, centered at (cx, cy) with given radius. Inscribed in circle by default.',
  {
    cx: z.number(), cy: z.number(),
    sides: z.number().int().min(3).max(128).describe('Number of sides'),
    radius: z.number().positive(),
    rotation: z.number().default(0).describe('Rotation angle in degrees'),
    inscribed: z.boolean().default(true).describe('true = vertices on circle, false = edges tangent to circle'),
    layer: z.string().optional(),
  },
  async ({ cx, cy, sides, radius, rotation, inscribed, layer }) => {
    const r = inscribed ? radius : radius / Math.cos(Math.PI / sides);
    const points = [];
    for (let i = 0; i < sides; i++) {
      const angle = (2 * Math.PI * i / sides) + (rotation * Math.PI / 180);
      points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
    const e = makeEntity('polyline', {
      points,
      bulges: new Array(points.length).fill(0),
      closed: true,
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Polygon added (id=${e.id}): ${sides}-sided, center=(${cx},${cy}), r=${radius}` }] };
  }
);

server.tool('add_hatch',
  'Add a hatched/filled region defined by boundary points',
  {
    boundaries: z.array(z.array(z.object({ x: z.number(), y: z.number() })).min(3))
      .min(1).describe('Array of boundary loops (each is an array of points forming a closed polygon)'),
    pattern: z.string().default('SOLID').describe('Hatch pattern name (SOLID, ANSI31, etc.)'),
    scale: z.number().positive().default(1),
    angle: z.number().default(0),
    layer: z.string().optional(),
  },
  async ({ boundaries, pattern, scale, angle, layer }) => {
    const e = makeEntity('hatch', {
      boundaries,
      patternName: pattern,
      patternScale: scale,
      patternAngle: angle,
      ...(layer && { layer }),
    });
    entities.push(e);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Hatch added (id=${e.id}): ${boundaries.length} boundary loop(s), pattern=${pattern}` }] };
  }
);

// ── Modify tools ──

server.tool('move_entity',
  'Move an entity by dx, dy offset',
  { id: z.string(), dx: z.number(), dy: z.number() },
  async ({ id, dx, dy }) => {
    const e = findEntity(id);
    if (!e) return { content: [{ type: 'text', text: `Entity ${id} not found` }] };
    const moved = transformEntity(e, p => movePoint(p, dx, dy));
    Object.assign(e, moved);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Entity ${id} moved by (${dx},${dy})` }] };
  }
);

server.tool('copy_entity',
  'Copy an entity with dx, dy offset. Returns the new entity id.',
  { id: z.string(), dx: z.number(), dy: z.number() },
  async ({ id, dx, dy }) => {
    const e = findEntity(id);
    if (!e) return { content: [{ type: 'text', text: `Entity ${id} not found` }] };
    const copy = transformEntity(e, p => movePoint(p, dx, dy));
    copy.id = String(nextId++);
    copy.selected = false;
    entities.push(copy);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Entity ${id} copied to ${copy.id} with offset (${dx},${dy})` }] };
  }
);

server.tool('rotate_entity',
  'Rotate an entity around a base point by angle (degrees, counterclockwise)',
  { id: z.string(), center_x: z.number(), center_y: z.number(), angle: z.number() },
  async ({ id, center_x, center_y, angle }) => {
    const e = findEntity(id);
    if (!e) return { content: [{ type: 'text', text: `Entity ${id} not found` }] };
    const rotated = transformEntity(e, p => rotatePoint(p, center_x, center_y, angle));
    Object.assign(e, rotated);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Entity ${id} rotated ${angle}° around (${center_x},${center_y})` }] };
  }
);

server.tool('scale_entity',
  'Scale an entity from a base point by a factor',
  { id: z.string(), center_x: z.number(), center_y: z.number(), factor: z.number().positive() },
  async ({ id, center_x, center_y, factor }) => {
    const e = findEntity(id);
    if (!e) return { content: [{ type: 'text', text: `Entity ${id} not found` }] };
    const scaled = transformEntity(e, p => scalePoint(p, center_x, center_y, factor));
    if (scaled.type === 'circle' || scaled.type === 'arc') scaled.radius *= factor;
    if (scaled.type === 'text') scaled.height *= factor;
    Object.assign(e, scaled);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Entity ${id} scaled by ${factor}x from (${center_x},${center_y})` }] };
  }
);

server.tool('mirror_entity',
  'Mirror an entity across a line defined by two points. Creates a copy by default.',
  { id: z.string(), line_x1: z.number(), line_y1: z.number(), line_x2: z.number(), line_y2: z.number(), delete_source: z.boolean().default(false) },
  async ({ id, line_x1, line_y1, line_x2, line_y2, delete_source }) => {
    const e = findEntity(id);
    if (!e) return { content: [{ type: 'text', text: `Entity ${id} not found` }] };
    const p1 = { x: line_x1, y: line_y1 }, p2 = { x: line_x2, y: line_y2 };
    const mirrored = transformEntity(e, p => mirrorPoint(p, p1, p2));
    if (delete_source) {
      Object.assign(e, mirrored);
      await syncToBrowser();
      return { content: [{ type: 'text', text: `Entity ${id} mirrored (source deleted)` }] };
    }
    mirrored.id = String(nextId++);
    mirrored.selected = false;
    entities.push(mirrored);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Entity ${id} mirrored to ${mirrored.id}` }] };
  }
);

server.tool('erase_entity',
  'Delete an entity by id',
  { id: z.string() },
  async ({ id }) => {
    const idx = entities.findIndex(e => e.id === String(id));
    if (idx === -1) return { content: [{ type: 'text', text: `Entity ${id} not found` }] };
    entities.splice(idx, 1);
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Entity ${id} erased` }] };
  }
);

// ── Query tools ──

server.tool('list_entities',
  'List all entities in the drawing. Optionally filter by layer or type.',
  { layer: z.string().optional(), type: z.string().optional() },
  async ({ layer, type }) => {
    let result = entities;
    if (layer) result = result.filter(e => e.layer === layer);
    if (type) result = result.filter(e => e.type === type);
    const summary = result.map(e => {
      let desc = `id=${e.id} type=${e.type} layer=${e.layer}`;
      if (e.type === 'line') desc += ` (${e.start.x},${e.start.y})→(${e.end.x},${e.end.y})`;
      if (e.type === 'circle') desc += ` center=(${e.center.x},${e.center.y}) r=${e.radius}`;
      if (e.type === 'rect') desc += ` (${e.corner1.x},${e.corner1.y})→(${e.corner2.x},${e.corner2.y})`;
      if (e.type === 'text') desc += ` "${e.text}" at (${e.position.x},${e.position.y})`;
      if (e.type === 'polyline') desc += ` ${e.points.length}pts closed=${e.closed}`;
      return desc;
    });
    return { content: [{ type: 'text', text: `${result.length} entities:\n${summary.join('\n') || '(empty)'}` }] };
  }
);

server.tool('get_entity',
  'Get full details of an entity by id',
  { id: z.string() },
  async ({ id }) => {
    const e = findEntity(id);
    if (!e) return { content: [{ type: 'text', text: `Entity ${id} not found` }] };
    return { content: [{ type: 'text', text: JSON.stringify(e, null, 2) }] };
  }
);

server.tool('get_drawing_bounds',
  'Get the bounding box of all entities',
  {},
  async () => {
    const b = getBounds();
    const w = b.max.x - b.min.x, h = b.max.y - b.min.y;
    return { content: [{ type: 'text', text: `Bounds: (${b.min.x},${b.min.y}) → (${b.max.x},${b.max.y}), size=${w.toFixed(2)}×${h.toFixed(2)}, ${entities.length} entities` }] };
  }
);

// ── Layer tools ──

server.tool('list_layers',
  'List all layers in the drawing',
  {},
  async () => {
    const lines = layers.map(l => `${l.current ? '→ ' : '  '}${l.name} color=${l.color} visible=${l.visible}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool('create_layer',
  'Create a new layer (and optionally set it as current)',
  { name: z.string(), color: z.string().default('#ffffff'), set_current: z.boolean().default(false) },
  async ({ name, color, set_current }) => {
    if (layers.find(l => l.name === name)) {
      if (set_current) {
        layers.forEach(l => l.current = false);
        layers.find(l => l.name === name).current = true;
      }
      return { content: [{ type: 'text', text: `Layer "${name}" already exists${set_current ? ' (set as current)' : ''}` }] };
    }
    if (set_current) layers.forEach(l => l.current = false);
    layers.push({ name, color, visible: true, locked: false, frozen: false, current: set_current, lineweight: 1, plot: true });
    return { content: [{ type: 'text', text: `Layer "${name}" created${set_current ? ' (current)' : ''}` }] };
  }
);

server.tool('set_current_layer',
  'Set the current layer by name',
  { name: z.string() },
  async ({ name }) => {
    const l = layers.find(l => l.name === name);
    if (!l) return { content: [{ type: 'text', text: `Layer "${name}" not found` }] };
    layers.forEach(l => l.current = false);
    l.current = true;
    return { content: [{ type: 'text', text: `Current layer set to "${name}"` }] };
  }
);

// ── I/O tools ──

server.tool('export_dxf',
  'Export the current drawing as a DXF file via the SonCAD backend. Returns the file path.',
  { filename: z.string().default('drawing.dxf') },
  async ({ filename }) => {
    try {
      const res = await fetch(`${BACKEND}/api/dxf/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entities, layers, filename }),
      });
      if (!res.ok) throw new Error(`Backend returned ${res.status}: ${await res.text()}`);
      const blob = await res.arrayBuffer();
      const fs = await import('fs');
      const path = await import('path');
      const outPath = path.resolve(filename);
      fs.writeFileSync(outPath, Buffer.from(blob));
      return { content: [{ type: 'text', text: `DXF exported to ${outPath} (${entities.length} entities, ${blob.byteLength} bytes)` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Export failed: ${err.message}` }] };
    }
  }
);

server.tool('import_dxf',
  'Import a DXF file into the current drawing via the SonCAD backend. Merges with existing entities.',
  { filepath: z.string() },
  async ({ filepath }) => {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const absPath = path.resolve(filepath);
      const fileData = fs.readFileSync(absPath);
      const form = new FormData();
      form.append('file', new Blob([fileData]), path.basename(absPath));
      const res = await fetch(`${BACKEND}/api/dxf/import`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`Backend returned ${res.status}: ${await res.text()}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const imported = data.entities || [];
      for (const e of imported) {
        e.id = String(nextId++);
        entities.push(e);
      }
      if (data.layers) {
        for (const l of data.layers) {
          if (!layers.find(ll => ll.name === l.name)) {
            layers.push({ name: l.name, color: l.color || '#ffffff', visible: true, locked: false, frozen: false, current: false, lineweight: l.lineweight || 1, plot: true });
          }
        }
      }
      return { content: [{ type: 'text', text: `Imported ${imported.length} entities from ${filepath}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Import failed: ${err.message}` }] };
    }
  }
);

server.tool('batch_add_entities',
  'Add multiple entities at once. Use this to push an entire drawing in a single call. ' +
  'Each entity needs a "type" field and type-specific geometry. Supported types: ' +
  'line {start:{x,y}, end:{x,y}}, circle {center:{x,y}, radius}, ' +
  'arc {center:{x,y}, radius, startAngle, endAngle} (angles in degrees), ' +
  'polyline {points:[{x,y},...], closed, bulges?:[]}, ' +
  'text {position:{x,y}, text, height?, rotation?}, ' +
  'dimension {dimType, p1:{x,y}, p2:{x,y}, textPos:{x,y}, textOverride?}. ' +
  'Optionally set clear=true to replace the current drawing instead of appending.',
  {
    entities: z.array(z.record(z.any())).min(1).describe('Array of entity objects, each with "type" and geometry fields'),
    clear: z.boolean().default(true).describe('Clear existing drawing before adding (default true)'),
    layers: z.array(z.object({
      name: z.string(),
      color: z.string().default('#ffffff'),
    })).optional().describe('Layers to create'),
    filename: z.string().optional().describe('Optional filename for cloud save'),
  },
  async ({ entities: newEntities, clear: clearFirst, layers: newLayers, filename }) => {
    if (clearFirst) {
      entities = [];
      nextId = 1;
      layers = [{ name: '0', color: '#ffffff', visible: true, locked: false, frozen: false, current: true, lineweight: 1, plot: true }];
    }

    if (newLayers) {
      for (const l of newLayers) {
        if (!layers.find(ll => ll.name === l.name)) {
          layers.push({ name: l.name, color: l.color || '#ffffff', visible: true, locked: false, frozen: false, current: false, lineweight: 1, plot: true });
        }
      }
    }

    const added = [];
    for (const spec of newEntities) {
      const type = spec.type;
      if (!type) continue;

      let props = {};
      switch (type) {
        case 'line':
          props = { start: spec.start, end: spec.end };
          break;
        case 'circle':
          props = { center: spec.center, radius: spec.radius };
          break;
        case 'arc':
          props = {
            center: spec.center, radius: spec.radius,
            startAngle: spec.startAngle, endAngle: spec.endAngle,
          };
          break;
        case 'polyline':
          props = {
            points: spec.points,
            bulges: spec.bulges || new Array(spec.points.length).fill(0),
            closed: spec.closed || false,
          };
          break;
        case 'rect':
          props = { corner1: spec.corner1, corner2: spec.corner2 };
          break;
        case 'text':
          props = {
            position: spec.position, text: spec.text,
            height: spec.height || 2.5, rotation: spec.rotation || 0,
          };
          break;
        case 'dimension':
          props = {
            dimType: spec.dimType || 'linear',
            p1: spec.p1, p2: spec.p2,
            textPos: spec.textPos || spec.p1,
            ...(spec.textOverride && { textOverride: spec.textOverride }),
          };
          break;
        case 'point':
          props = { position: spec.position, pdmode: 3, pdsize: 5 };
          break;
        case 'ellipse':
          props = {
            center: spec.center, majorX: spec.majorX, majorY: spec.majorY,
            ratio: spec.ratio || 1, startParam: spec.startParam || 0,
            endParam: spec.endParam || 6.283185307,
          };
          break;
        case 'hatch':
          props = {
            boundaries: spec.boundaries, patternName: spec.patternName || 'SOLID',
            patternScale: spec.patternScale || 1, patternAngle: spec.patternAngle || 0,
          };
          break;
        default:
          continue;
      }

      const e = makeEntity(type, { ...props, ...(spec.layer && { layer: spec.layer }), ...(spec.color && { color: spec.color }) });
      entities.push(e);
      added.push(e.id);
    }

    await syncToBrowser();

    let cloudResult = '';
    if (filename) {
      try {
        const res = await fetch(`${BACKEND}/api/cloud/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entities, layers, filename }),
        });
        if (res.ok) {
          const data = await res.json();
          cloudResult = ` | Saved to cloud: id=${data.id}, filename=${data.filename}`;
        }
      } catch (_) {}
    }

    return { content: [{ type: 'text', text: `Added ${added.length} entities (ids: ${added.join(',')})${cloudResult}` }] };
  }
);

server.tool('clear_drawing',
  'Clear all entities and reset layers',
  {},
  async () => {
    const count = entities.length;
    entities = [];
    nextId = 1;
    layers = [{ name: '0', color: '#ffffff', visible: true, locked: false, frozen: false, current: true, lineweight: 1, plot: true }];
    await syncToBrowser();
    return { content: [{ type: 'text', text: `Drawing cleared (${count} entities removed)` }] };
  }
);

server.tool('get_entity_json',
  'Get the full entity JSON array for the current drawing (for loading into SonCAD browser)',
  {},
  async () => {
    return { content: [{ type: 'text', text: JSON.stringify({ entities, layers }, null, 2) }] };
  }
);

// ── Cloud storage tools ──

server.tool('cloud_list',
  'List all DXF files saved in cloud storage',
  {},
  async () => {
    try {
      const res = await fetch(`${BACKEND}/api/cloud/list`);
      const data = await res.json();
      if (!data.files || data.files.length === 0) {
        return { content: [{ type: 'text', text: 'No files in cloud storage.' }] };
      }
      const lines = data.files.map(f =>
        `id=${f.id}  ${f.filename}  ${f.entity_count} entities  ${f.file_size} bytes  ${f.uploaded_at}`
      );
      return { content: [{ type: 'text', text: `${data.files.length} files:\n${lines.join('\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed: ${err.message}` }] };
    }
  }
);

server.tool('cloud_open',
  'Open a DXF file from cloud storage by file_id. Replaces current drawing state.',
  { file_id: z.string() },
  async ({ file_id }) => {
    try {
      const res = await fetch(`${BACKEND}/api/cloud/open/${file_id}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      entities = data.entities || [];
      nextId = entities.reduce((max, e) => Math.max(max, parseInt(e.id, 10) || 0), 0) + 1;
      if (data.layers) {
        layers = data.layers.map(l => ({
          name: l.name, color: l.color || '#ffffff',
          visible: true, locked: false, frozen: false,
          current: l.name === '0', lineweight: l.lineweight || 1, plot: true,
        }));
      }
      return { content: [{ type: 'text', text: `Opened "${data.filename}": ${entities.length} entities, ${layers.length} layers` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed: ${err.message}` }] };
    }
  }
);

server.tool('cloud_save',
  'Save the current drawing to cloud storage',
  { filename: z.string().default('drawing.dxf') },
  async ({ filename }) => {
    try {
      const res = await fetch(`${BACKEND}/api/cloud/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entities, layers, filename }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      return { content: [{ type: 'text', text: `Saved "${data.filename}" (id=${data.id}, ${data.entity_count} entities)` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed: ${err.message}` }] };
    }
  }
);

// ── Floorplan generator ──

const FLOORPLAN_PY = process.env.FLOORPLAN_PY || '/home/jit/.claude/skills/floorplan/floorplan.py';
const PLANS_DIR = process.env.PLANS_DIR || new URL('../plans', import.meta.url).pathname;

server.tool('generate_floorplan',
  'Generate an architectural floor plan from a JSON spec. Produces DXF + PNG and optionally uploads to cloud storage. ' +
  'The spec uses metres for all dimensions. See the floorplan skill for the full spec format. ' +
  'Minimal example: {"name":"my_plan","width":6.0,"height":4.0,"rooms":[{"name":"ROOM","x":0.15,"y":0.15,"w":5.7,"h":3.7}]}',
  {
    spec: z.object({
      name: z.string().describe('Plan name (used for filenames)'),
      title: z.string().optional().describe('Title drawn above the plan'),
      width: z.number().positive().describe('Outer width in metres'),
      height: z.number().positive().describe('Outer height in metres'),
      wall: z.number().positive().default(0.15).describe('Exterior wall thickness (m)'),
      inner_wall: z.number().positive().default(0.10).describe('Interior wall thickness (m)'),
      exterior: z.boolean().default(true).describe('Draw exterior wall outline'),
      dim_text: z.number().positive().optional(),
      dim_arrow: z.number().positive().optional(),
      label_h: z.number().positive().optional(),
      partitions: z.array(z.union([
        z.array(z.number()).length(4),
        z.object({ line: z.array(z.number()).length(4), t: z.number().optional() }),
      ])).optional().describe('Interior wall centre lines: [x1,y1,x2,y2] or {line:[...], t:thickness}'),
      doors: z.array(z.union([
        z.object({
          hinge: z.array(z.number()).length(2),
          width: z.number().positive(),
          start: z.number(),
          end: z.number(),
        }),
        z.object({
          sliding: z.literal(true),
          line: z.array(z.number()).length(4),
        }),
      ])).optional().describe('Swing doors (hinge+width+start/end angles) or sliding doors'),
      windows: z.array(z.array(z.number()).length(4)).optional()
        .describe('Windows on wall centre lines: [x1,y1,x2,y2]'),
      fixtures: z.array(z.record(z.any())).optional()
        .describe('Fixtures: each needs "kind" (bed/table/toilet/sink/stove/fridge/shower/closet/counter/washer/basin/bathtub/desk/sofa/stairs/rect/circle) plus kind-specific params'),
      rooms: z.array(z.object({
        name: z.string(),
        x: z.number(), y: z.number(), w: z.number(), h: z.number(),
        show_area: z.boolean().optional(),
        label_dx: z.number().optional(),
        label_dy: z.number().optional(),
      })).optional().describe('Room labels with interior rectangles'),
      texts: z.array(z.object({ x: z.number(), y: z.number(), text: z.string(), h: z.number().optional() })).optional(),
      dims: z.object({
        overall: z.boolean().optional(),
        overall_offset: z.number().optional(),
        chains: z.array(z.record(z.any())).optional(),
      }).optional().describe('Dimension annotations'),
      area: z.union([z.object({
        limit: z.number().optional(),
        mode: z.enum(['centerline', 'inner', 'outer']).optional(),
        dy: z.number().optional(),
        text: z.string().optional(),
      }), z.literal(false)]).optional().describe('Area label config, or false to omit'),
    }),
    upload_to_cloud: z.boolean().default(false).describe('Upload the DXF to SonCAD cloud storage after generation'),
    load_into_drawing: z.boolean().default(true).describe('Load the generated plan into the current MCP drawing state'),
    dark_png: z.boolean().default(false).describe('Dark background for the PNG preview'),
  },
  async ({ spec, upload_to_cloud, load_into_drawing, dark_png }) => {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const { execSync } = await import('child_process');

      // Ensure plans directory exists
      fs.mkdirSync(PLANS_DIR, { recursive: true });

      const name = spec.name || 'plan';
      const specPath = path.join(PLANS_DIR, `${name}.json`);
      const dxfPath = path.join(PLANS_DIR, `${name}.dxf`);
      const pngPath = path.join(PLANS_DIR, `${name}.png`);

      // Write the spec
      fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

      // Run floorplan.py
      const darkFlag = dark_png ? ' --dark' : '';
      const cmd = `python3 "${FLOORPLAN_PY}" "${specPath}" "${dxfPath}" --png "${pngPath}"${darkFlag}`;
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 30000, cwd: PLANS_DIR });

      const results = [`Spec written to ${specPath}`, output.trim()];

      // Optionally load into MCP drawing state via import
      if (load_into_drawing) {
        try {
          const form = new FormData();
          const fileData = fs.readFileSync(dxfPath);
          form.append('file', new Blob([fileData]), path.basename(dxfPath));
          const res = await fetch(`${BACKEND}/api/dxf/import`, { method: 'POST', body: form });
          if (res.ok) {
            const data = await res.json();
            if (!data.error) {
              const imported = data.entities || [];
              entities = [];
              nextId = 1;
              for (const e of imported) {
                e.id = String(nextId++);
                entities.push(e);
              }
              if (data.layers) {
                layers = [{ name: '0', color: '#ffffff', visible: true, locked: false, frozen: false, current: true, lineweight: 1, plot: true }];
                for (const l of data.layers) {
                  if (!layers.find(ll => ll.name === l.name)) {
                    layers.push({ name: l.name, color: l.color || '#ffffff', visible: true, locked: false, frozen: false, current: false, lineweight: l.lineweight || 1, plot: true });
                  }
                }
              }
              results.push(`Loaded ${imported.length} entities into MCP drawing state`);
            }
          }
        } catch (loadErr) {
          results.push(`Note: could not load into drawing state (backend may be offline): ${loadErr.message}`);
        }
      }

      // Optionally upload to cloud
      if (upload_to_cloud) {
        try {
          const fileData = fs.readFileSync(dxfPath);
          const form = new FormData();
          form.append('file', new Blob([fileData]), `${name}.dxf`);
          const res = await fetch(`${BACKEND}/api/cloud/upload`, { method: 'POST', body: form });
          if (res.ok) {
            const data = await res.json();
            results.push(`Uploaded to cloud: id=${data.id}, filename=${data.filename}`);
          } else {
            results.push(`Cloud upload failed: ${res.status}`);
          }
        } catch (uploadErr) {
          results.push(`Cloud upload failed: ${uploadErr.message}`);
        }
      }

      // Return text results + the PNG as an embedded image
      const content = [{ type: 'text', text: results.join('\n') }];
      try {
        const pngBuf = fs.readFileSync(pngPath);
        content.push({ type: 'image', data: pngBuf.toString('base64'), mimeType: 'image/png' });
      } catch (_) {
        // PNG generation may have failed, that's ok
      }

      return { content };
    } catch (err) {
      return { content: [{ type: 'text', text: `Floorplan generation failed: ${err.message}` }] };
    }
  }
);

// ── Screenshot tool ──

const SONCAD_URL = process.env.SONCAD_URL || 'http://localhost:3011';

server.tool('screenshot',
  'Open a cloud DXF file in the SonCAD browser UI and take a screenshot. Returns the image as base64.',
  { file_id: z.string().optional().describe('Cloud file ID to open before screenshot. If omitted, screenshots current view.'),
    output_path: z.string().optional().describe('Save screenshot to this file path instead of returning base64'),
    width: z.number().default(1280), height: z.number().default(800) },
  async ({ file_id, output_path, width, height }) => {
    let browser;
    try {
      const { chromium } = await import('playwright');
      const path = await import('path');
      const fs = await import('fs');

      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(SONCAD_URL, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(500);

      if (file_id) {
        // Load the cloud file via the app's store
        const loadResult = await page.evaluate(async (fid) => {
          const API = window.location.hostname === 'localhost' ? 'http://localhost:3002' : '';
          const res = await fetch(`${API}/api/cloud/open/${fid}`);
          const data = await res.json();
          if (data.error) return { error: data.error };
          const store = window.__store;
          if (!store) return { error: 'store not found' };
          store.entities = data.entities || [];
          if (data.layers) {
            store.layers = data.layers.map(l => ({
              name: l.name, color: l.color || '#ffffff',
              visible: true, locked: false, frozen: false,
              current: l.name === '0', lineweight: l.lineweight || 1, plot: true,
            }));
          }
          store.emit();
          if (window.__engine) {
            window.__engine.handleInput('ZOOM');
            window.__engine.handleInput('e');
          }
          return { count: store.entities.length, filename: data.filename };
        }, file_id);
        if (loadResult.error) throw new Error(loadResult.error);
        await page.waitForTimeout(300);
      }

      let result;
      if (output_path) {
        const absPath = path.resolve(output_path);
        await page.screenshot({ path: absPath });
        result = { content: [{ type: 'text', text: `Screenshot saved to ${absPath}` }] };
      } else {
        const buf = await page.screenshot();
        const b64 = buf.toString('base64');
        result = { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
      }

      await browser.close();
      browser = null;
      return result;
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      return { content: [{ type: 'text', text: `Screenshot failed: ${err.message}` }] };
    }
  }
);

// ── Start ──

const transport = new StdioServerTransport();
await server.connect(transport);
