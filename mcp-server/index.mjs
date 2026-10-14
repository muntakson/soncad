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
    return { content: [{ type: 'text', text: `Dimension added (id=${e.id}): ${dim_type} (${x1},${y1})→(${x2},${y2})` }] };
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
      return { content: [{ type: 'text', text: `Entity ${id} mirrored (source deleted)` }] };
    }
    mirrored.id = String(nextId++);
    mirrored.selected = false;
    entities.push(mirrored);
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

server.tool('clear_drawing',
  'Clear all entities and reset layers',
  {},
  async () => {
    const count = entities.length;
    entities = [];
    nextId = 1;
    layers = [{ name: '0', color: '#ffffff', visible: true, locked: false, frozen: false, current: true, lineweight: 1, plot: true }];
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

// ── Start ──

const transport = new StdioServerTransport();
await server.connect(transport);
