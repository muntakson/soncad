import { Entity, Point, PolylineEntity } from '../types';
import { store, nextId } from '../store';
import { entityBounds, polarPoint, bulgeArc } from '../geometry';
import { CommandEngine } from './engine';

const COLORS: Record<string, string> = {
  '1': '#ff0000', '2': '#ffff00', '3': '#00ff00', '4': '#00ffff',
  '5': '#0000ff', '6': '#ff00ff', '7': '#ffffff',
};

const LINETYPE_DASHES: Record<string, string> = {
  continuous: '',
  dashed: '8,4',
  hidden: '4,4',
  center: '12,4,4,4',
  dashdot: '8,4,2,4',
  phantom: '16,4,4,4,4,4',
  dot: '2,4',
  border: '8,4,8,4,2,4',
  divide: '8,4,2,4,2,4',
};

function resolveColor(e: Entity): string {
  if (e.color === 'bylayer') {
    const layer = store.layers.find(l => l.name === e.layer);
    return layer?.color || '#ffffff';
  }
  if (e.color === 'byblock') return '#ffffff';
  return COLORS[e.color] || e.color || '#ffffff';
}

function svgColor(hex: string): string {
  return hex === '#ffffff' ? '#000000' : hex;
}

function entityToSVG(e: Entity, scale: number): string {
  const color = svgColor(resolveColor(e));
  const lw = Math.max(0.25, e.lineweight * 0.3);
  const dash = LINETYPE_DASHES[e.linetype] || '';
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
  const base = `stroke="${color}" stroke-width="${lw}" fill="none"${dashAttr}`;

  switch (e.type) {
    case 'line':
      return `<line x1="${e.start.x}" y1="${e.start.y}" x2="${e.end.x}" y2="${e.end.y}" ${base}/>`;

    case 'circle':
      return `<circle cx="${e.center.x}" cy="${e.center.y}" r="${e.radius}" ${base}/>`;

    case 'arc': {
      const r = e.radius;
      const sp = polarPoint(e.center, r, e.startAngle);
      const ep = polarPoint(e.center, r, e.endAngle);
      let sweep = e.endAngle - e.startAngle;
      if (sweep < 0) sweep += Math.PI * 2;
      const largeArc = sweep > Math.PI ? 1 : 0;
      return `<path d="M ${sp.x} ${sp.y} A ${r} ${r} 0 ${largeArc} 0 ${ep.x} ${ep.y}" ${base}/>`;
    }

    case 'polyline': {
      if (e.points.length < 2) return '';
      const n = e.points.length;
      const segCount = e.closed ? n : n - 1;
      const parts: string[] = [`M ${e.points[0].x} ${e.points[0].y}`];
      for (let i = 0; i < segCount; i++) {
        const p1 = e.points[i];
        const p2 = e.points[(i + 1) % n];
        const bulge = e.bulges?.[i] || 0;
        if (Math.abs(bulge) < 1e-10) {
          parts.push(`L ${p2.x} ${p2.y}`);
        } else {
          const { radius } = bulgeArc(p1, p2, bulge);
          const includedAngle = 4 * Math.atan(Math.abs(bulge));
          const largeArcFlag = includedAngle > Math.PI ? 1 : 0;
          const sweepFlag = bulge > 0 ? 0 : 1;
          parts.push(`A ${radius} ${radius} 0 ${largeArcFlag} ${sweepFlag} ${p2.x} ${p2.y}`);
        }
      }
      if (e.closed) parts.push('Z');
      return `<path d="${parts.join(' ')}" ${base}/>`;
    }

    case 'rect': {
      const x = Math.min(e.corner1.x, e.corner2.x);
      const y = Math.min(e.corner1.y, e.corner2.y);
      const w = Math.abs(e.corner2.x - e.corner1.x);
      const h = Math.abs(e.corner2.y - e.corner1.y);
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${base}/>`;
    }

    case 'text': {
      const fontSize = e.height * scale;
      return `<text x="${e.position.x}" y="${e.position.y}" font-size="${e.height}" font-family="monospace" fill="${color}" transform="rotate(${-e.rotation} ${e.position.x} ${e.position.y})">${escapeXml(e.text)}</text>`;
    }

    case 'ellipse': {
      const mx = Math.sqrt(e.majorX * e.majorX + e.majorY * e.majorY);
      const my = mx * e.ratio;
      const rot = Math.atan2(e.majorY, e.majorX) * 180 / Math.PI;
      return `<ellipse cx="${e.center.x}" cy="${e.center.y}" rx="${mx}" ry="${my}" transform="rotate(${rot} ${e.center.x} ${e.center.y})" ${base}/>`;
    }

    case 'dimension': {
      const lines: string[] = [];
      lines.push(`<line x1="${e.p1.x}" y1="${e.p1.y}" x2="${e.p2.x}" y2="${e.p2.y}" ${base}/>`);
      const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
      const measurement = Math.sqrt(dx * dx + dy * dy);
      const label = e.textOverride || measurement.toFixed(store.unitPrecision);
      lines.push(`<text x="${e.textPos.x}" y="${e.textPos.y}" font-size="2.5" font-family="monospace" fill="${color}" text-anchor="middle">${escapeXml(label)}</text>`);
      return lines.join('\n    ');
    }

    case 'point':
      return `<circle cx="${e.position.x}" cy="${e.position.y}" r="0.5" fill="${color}" ${base}/>`;

    case 'hatch': {
      const paths = e.boundaries.map(b => {
        const d = b.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';
        return `<path d="${d}" fill="${color}" fill-opacity="0.3" stroke="none"/>`;
      });
      return paths.join('\n    ');
    }

    case 'region': {
      const outerD = e.outerBoundary.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';
      const holesD = e.holes.map(h => h.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z').join(' ');
      return `<path d="${outerD} ${holesD}" fill="${color}" fill-opacity="0.15" ${base} fill-rule="evenodd"/>`;
    }

    default:
      return '';
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getExtents(entities: Entity[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of entities) {
    const b = entityBounds(e);
    if (!b) continue;
    minX = Math.min(minX, b.min.x);
    minY = Math.min(minY, b.min.y);
    maxX = Math.max(maxX, b.max.x);
    maxY = Math.max(maxY, b.max.y);
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function filterPlottable(entities: Entity[]): Entity[] {
  const plottableLayers = new Set(store.layers.filter(l => l.plot !== false).map(l => l.name));
  return entities.filter(e => plottableLayers.has(e.layer));
}

function exportSVG(entities: Entity[], filename: string) {
  entities = filterPlottable(entities);
  const ext = getExtents(entities);
  if (!ext) return;
  const padding = 10;
  const { minX, minY, maxX, maxY } = ext;
  const w = maxX - minX + padding * 2;
  const h = maxY - minY + padding * 2;

  const svgParts = entities
    .filter(e => e.visible)
    .map(e => `    ${entityToSVG(e, 1)}`)
    .filter(s => s.trim() !== '');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${minX - padding} ${minY - padding} ${w} ${h}">
  <g transform="scale(1,-1) translate(0,${-(maxY + minY)})">
${svgParts.join('\n')}
  </g>
</svg>`;

  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), filename);
}

function exportPDF(entities: Entity[], filename: string) {
  entities = filterPlottable(entities);
  const ext = getExtents(entities);
  if (!ext) return;
  const padding = 20;
  const { minX, minY, maxX, maxY } = ext;
  const w = maxX - minX + padding * 2;
  const h = maxY - minY + padding * 2;

  const offCanvas = document.createElement('canvas');
  const scale = 4;
  offCanvas.width = w * scale;
  offCanvas.height = h * scale;
  const ctx = offCanvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, offCanvas.width, offCanvas.height);
  ctx.scale(scale, scale);
  ctx.translate(-minX + padding, maxY + padding);
  ctx.scale(1, -1);

  for (const e of entities) {
    if (!e.visible) continue;
    const color = resolveColor(e);
    const printColor = color === '#ffffff' ? '#000000' : color;
    ctx.strokeStyle = printColor;
    ctx.fillStyle = printColor;
    ctx.lineWidth = Math.max(0.25, e.lineweight * 0.3);
    const dash = LINETYPE_DASHES[e.linetype];
    ctx.setLineDash(dash ? dash.split(',').map(Number) : []);
    drawEntityToCtx(ctx, e);
    ctx.setLineDash([]);
  }

  offCanvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, filename.replace('.pdf', '.png'));
  }, 'image/png');
}

function drawEntityToCtx(ctx: CanvasRenderingContext2D, e: Entity) {
  switch (e.type) {
    case 'line':
      ctx.beginPath();
      ctx.moveTo(e.start.x, e.start.y);
      ctx.lineTo(e.end.x, e.end.y);
      ctx.stroke();
      break;
    case 'circle':
      ctx.beginPath();
      ctx.arc(e.center.x, e.center.y, e.radius, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'arc':
      ctx.beginPath();
      ctx.arc(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle);
      ctx.stroke();
      break;
    case 'polyline': {
      if (e.points.length < 2) break;
      const n = e.points.length;
      const segCount = e.closed ? n : n - 1;
      ctx.beginPath();
      ctx.moveTo(e.points[0].x, e.points[0].y);
      for (let i = 0; i < segCount; i++) {
        const p1 = e.points[i];
        const p2 = e.points[(i + 1) % n];
        const bulge = e.bulges?.[i] || 0;
        if (Math.abs(bulge) < 1e-10) {
          ctx.lineTo(p2.x, p2.y);
        } else {
          const arc = bulgeArc(p1, p2, bulge);
          const includedAngle = 4 * Math.atan(Math.abs(bulge));
          const steps = Math.max(8, Math.ceil(includedAngle * 180 / Math.PI));
          for (let j = 1; j <= steps; j++) {
            const t = j / steps;
            let ang: number;
            if (arc.ccw) {
              let sw = arc.endAngle - arc.startAngle;
              if (sw <= 1e-10) sw += Math.PI * 2;
              ang = arc.startAngle + sw * t;
            } else {
              let sw = arc.startAngle - arc.endAngle;
              if (sw <= 1e-10) sw += Math.PI * 2;
              ang = arc.startAngle - sw * t;
            }
            ctx.lineTo(
              arc.center.x + arc.radius * Math.cos(ang),
              arc.center.y + arc.radius * Math.sin(ang)
            );
          }
        }
      }
      if (e.closed) ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'rect':
      ctx.beginPath();
      ctx.rect(Math.min(e.corner1.x, e.corner2.x), Math.min(e.corner1.y, e.corner2.y),
        Math.abs(e.corner2.x - e.corner1.x), Math.abs(e.corner2.y - e.corner1.y));
      ctx.stroke();
      break;
    case 'text':
      ctx.save();
      ctx.translate(e.position.x, e.position.y);
      ctx.scale(1, -1);
      ctx.rotate(-e.rotation * Math.PI / 180);
      ctx.font = `${e.height}px monospace`;
      ctx.fillText(e.text, 0, 0);
      ctx.restore();
      break;
    case 'ellipse': {
      const mx = Math.sqrt(e.majorX * e.majorX + e.majorY * e.majorY);
      const my = mx * e.ratio;
      const rot = Math.atan2(e.majorY, e.majorX);
      ctx.save();
      ctx.translate(e.center.x, e.center.y);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.ellipse(0, 0, mx, my, 0, e.startParam, e.endParam);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'point':
      ctx.beginPath();
      ctx.arc(e.position.x, e.position.y, 0.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'region':
      if (e.outerBoundary.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(e.outerBoundary[0].x, e.outerBoundary[0].y);
        for (let i = 1; i < e.outerBoundary.length; i++) ctx.lineTo(e.outerBoundary[i].x, e.outerBoundary[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.globalAlpha = 0.15;
        ctx.fill();
        ctx.globalAlpha = 1;
        for (const hole of e.holes) {
          if (hole.length < 3) continue;
          ctx.beginPath();
          ctx.moveTo(hole[0].x, hole[0].y);
          for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x, hole[i].y);
          ctx.closePath();
          ctx.stroke();
        }
      }
      break;
  }
}

function boundsContain(outer: {min: Point; max: Point}, inner: {min: Point; max: Point}): boolean {
  return inner.min.x >= outer.min.x && inner.max.x <= outer.max.x &&
         inner.min.y >= outer.min.y && inner.max.y <= outer.max.y;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export { exportSVG };

export function registerOutputCommands(engine: CommandEngine) {

  (window as any).plotSVG = (filename: string) => exportSVG(store.entities, filename);

  engine.register('PLOT', ['PRINT', 'PP'], () => {
    store.tool = 'plot';
    engine.prompt('PLOT Enter output format [SVG/PDF/DXF] <SVG>:');
    engine.waitForInput('Format:', (formatInput) => {
      const format = formatInput.toLowerCase() || 'svg';

      if (format === 'dxf') {
        engine.prompt('Export layers [All/Select] <All>:');
        engine.waitForInput('Layers:', (layerInput) => {
          const layerChoice = layerInput.toLowerCase() || 'all';
          if (layerChoice === 'all' || layerChoice === 'a') {
            (window as any).dxfSave();
            engine.prompt('Exported DXF (all layers)');
          } else if (layerChoice === 'select' || layerChoice === 's') {
            const layerNames = store.layers.map(l => l.name);
            engine.prompt(`Available layers: ${layerNames.join(', ')}`);
            engine.prompt('Enter layer names to export (comma-separated):');
            engine.waitForInput('Layers:', (namesInput) => {
              const selectedLayers = namesInput.split(',').map(s => s.trim()).filter(Boolean);
              if (selectedLayers.length === 0) {
                engine.prompt('No layers selected, exporting all');
                (window as any).dxfSave();
              } else {
                (window as any).dxfSave(selectedLayers);
                engine.prompt(`Exported DXF (layers: ${selectedLayers.join(', ')})`);
              }
              store.tool = 'idle';
              engine.complete();
              return true;
            });
            return true;
          } else {
            engine.prompt('Unknown option. Use All or Select.');
          }
          store.tool = 'idle';
          engine.complete();
          return true;
        });
        return true;
      }

      if (format !== 'svg' && format !== 'pdf') {
        engine.prompt('Unknown format. Use SVG, PDF, or DXF.');
        store.tool = 'idle';
        engine.complete();
        return true;
      }

      engine.prompt('Include [All/Selection/Window] <All>:');
      engine.waitForInput('Scope:', (scopeInput) => {
        const scope = scopeInput.toLowerCase() || 'all';

        const doExport = (entities: Entity[]) => {
          if (entities.length === 0) {
            engine.prompt('No entities to export');
            store.tool = 'idle';
            engine.complete();
            return;
          }
          const filename = `drawing.${format === 'pdf' ? 'png' : format}`;
          if (format === 'svg') {
            exportSVG(entities, filename);
            engine.prompt(`Exported SVG: ${filename} (${entities.length} entities)`);
          } else {
            exportPDF(entities, filename);
            engine.prompt(`Exported PNG: ${filename} (${entities.length} entities)`);
          }
          store.tool = 'idle';
          engine.complete();
        };

        if (scope === 'all' || scope === 'a') {
          doExport(store.entities);
          return true;
        }

        if (scope === 'selection' || scope === 's') {
          const sel = store.selectedEntities();
          if (sel.length === 0) {
            engine.prompt('No objects selected. Select objects first.');
            store.tool = 'idle';
            engine.complete();
            return true;
          }
          doExport(sel);
          return true;
        }

        if (scope === 'window' || scope === 'w') {
          engine.prompt('Specify first corner:');
          engine.waitForClick((c1) => {
            engine.prompt('Specify opposite corner:');
            engine.onMove((p) => {
              engine.renderer.selectionBox = { p1: c1, p2: p };
            });
            engine.waitForClick((c2) => {
              engine.renderer.selectionBox = null;
              const bMinX = Math.min(c1.x, c2.x), bMaxX = Math.max(c1.x, c2.x);
              const bMinY = Math.min(c1.y, c2.y), bMaxY = Math.max(c1.y, c2.y);
              const filtered = store.entities.filter(e => {
                if (!e.visible) return false;
                const b = entityBounds(e);
                if (!b) return false;
                return b.min.x >= bMinX && b.max.x <= bMaxX && b.min.y >= bMinY && b.max.y <= bMaxY;
              });
              doExport(filtered);
            });
          });
          return true;
        }

        engine.prompt('Unknown scope. Use All, Selection, or Window.');
        store.tool = 'idle';
        engine.complete();
        return true;
      });
      return true;
    });
  });

  // === EXPORT ===
  engine.register('EXPORT', ['EXP'], () => {
    engine.prompt('EXPORT Enter format [SVG/PNG/DXF] <SVG>:');
    engine.waitForInput('Format:', (formatInput) => {
      const format = formatInput.toLowerCase() || 'svg';
      if (format === 'dxf') {
        engine.prompt('Export layers [All/Select] <All>:');
        engine.waitForInput('Layers:', (layerInput) => {
          const layerChoice = layerInput.toLowerCase() || 'all';
          if (layerChoice === 'all' || layerChoice === 'a') {
            (window as any).dxfSave();
            engine.prompt('Exported DXF (all layers)');
          } else if (layerChoice === 'select' || layerChoice === 's') {
            const layerNames = store.layers.map(l => l.name);
            engine.prompt(`Available layers: ${layerNames.join(', ')}`);
            engine.prompt('Enter layer names to export (comma-separated):');
            engine.waitForInput('Layers:', (namesInput) => {
              const selectedLayers = namesInput.split(',').map(s => s.trim()).filter(Boolean);
              if (selectedLayers.length === 0) {
                engine.prompt('No layers selected, exporting all');
                (window as any).dxfSave();
              } else {
                (window as any).dxfSave(selectedLayers);
                engine.prompt(`Exported DXF (layers: ${selectedLayers.join(', ')})`);
              }
              engine.complete();
              return true;
            });
            return true;
          } else {
            engine.prompt('Unknown option. Use All or Select.');
          }
          engine.complete();
          return true;
        });
        return true;
      }
      if (format === 'svg') {
        exportSVG(store.entities, 'drawing.svg');
        engine.prompt(`Exported SVG (${store.entities.length} entities)`);
        engine.complete();
        return true;
      }
      if (format === 'png') {
        exportPDF(store.entities, 'drawing.png');
        engine.prompt(`Exported PNG (${store.entities.length} entities)`);
        engine.complete();
        return true;
      }
      engine.prompt('Unknown format. Use SVG, PNG, or DXF.');
      engine.complete();
      return true;
    });
  });

  // === CUTORDER ===
  engine.register('CUTORDER', ['CUTO'], () => {
    const closed: Entity[] = [];
    const open: Entity[] = [];
    const other: Entity[] = [];

    for (const e of store.entities) {
      if (!e.visible) { other.push(e); continue; }
      const isClosed = e.type === 'circle' || e.type === 'rect' ||
        (e.type === 'polyline' && (e as PolylineEntity).closed);
      if (isClosed) {
        closed.push(e);
      } else if (['line', 'arc', 'polyline'].includes(e.type)) {
        open.push(e);
      } else {
        other.push(e);
      }
    }

    if (closed.length === 0) {
      engine.prompt('No closed profiles found to order');
      engine.complete();
      return;
    }

    const boxes = closed.map(e => ({ entity: e, bounds: entityBounds(e)!, depth: 0 }));

    for (const box of boxes) {
      let depth = 0;
      for (const otherBox of boxes) {
        if (otherBox === box) continue;
        if (boundsContain(otherBox.bounds, box.bounds)) depth++;
      }
      box.depth = depth;
    }

    boxes.sort((a, b) => b.depth - a.depth);

    store.pushUndo('CUTORDER');
    store.entities.length = 0;
    for (const box of boxes) store.entities.push(box.entity);
    for (const e of open) store.entities.push(e);
    for (const e of other) store.entities.push(e);
    store.emit();

    engine.prompt(`CUTORDER: Reordered ${closed.length} closed profiles (inner-before-outer), ${open.length} open entities`);
    engine.complete();
  });

  // === EXPORTLAYERS ===
  engine.register('EXPORTLAYERS', ['EXL'], () => {
    const layerNames = store.layers.map(l => l.name);
    engine.prompt(`Available layers: ${layerNames.join(', ')}`);
    engine.prompt('EXPORTLAYERS Enter layer names to export (comma-separated):');
    engine.waitForInput('Layers:', (input) => {
      const selectedLayers = input.split(',').map(s => s.trim()).filter(Boolean);
      if (selectedLayers.length === 0) {
        engine.prompt('No layers specified');
        engine.complete();
        return true;
      }
      (window as any).dxfSave(selectedLayers);
      engine.prompt(`Exporting DXF with layers: ${selectedLayers.join(', ')}`);
      engine.complete();
      return true;
    });
  });

  // === IMPORT ===
  engine.register('IMPORT', ['IMP'], () => {
    engine.prompt('IMPORT Enter format [DXF/SVG] <DXF>:');
    engine.waitForInput('Format:', (formatInput) => {
      const format = formatInput.toLowerCase() || 'dxf';
      if (format === 'dxf') {
        (window as any).dxfOpen();
        engine.complete();
        return true;
      }
      if (format === 'svg') {
        importSVGFile(engine);
        return true;
      }
      engine.prompt('Unknown format. Use DXF or SVG.');
      engine.complete();
      return true;
    });
  });
}

function importSVGFile(engine: CommandEngine) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.svg';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) { engine.complete(); return; }
    engine.prompt(`Importing ${file.name}...`);
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'image/svg+xml');
      const entities: Entity[] = [];

      function parseNumber(s: string | null): number {
        return s ? parseFloat(s) || 0 : 0;
      }

      function processElement(el: Element) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'line') {
          entities.push(makeImportEntity({
            type: 'line',
            start: { x: parseNumber(el.getAttribute('x1')), y: -parseNumber(el.getAttribute('y1')) },
            end: { x: parseNumber(el.getAttribute('x2')), y: -parseNumber(el.getAttribute('y2')) },
          }));
        } else if (tag === 'circle') {
          entities.push(makeImportEntity({
            type: 'circle',
            center: { x: parseNumber(el.getAttribute('cx')), y: -parseNumber(el.getAttribute('cy')) },
            radius: parseNumber(el.getAttribute('r')),
          }));
        } else if (tag === 'rect') {
          const x = parseNumber(el.getAttribute('x'));
          const y = parseNumber(el.getAttribute('y'));
          const w = parseNumber(el.getAttribute('width'));
          const h = parseNumber(el.getAttribute('height'));
          entities.push(makeImportEntity({
            type: 'rect',
            corner1: { x, y: -(y + h) },
            corner2: { x: x + w, y: -y },
          }));
        } else if (tag === 'polyline' || tag === 'polygon') {
          const raw = el.getAttribute('points') || '';
          const nums = raw.trim().split(/[\s,]+/).map(Number);
          const pts: Point[] = [];
          for (let i = 0; i < nums.length - 1; i += 2) {
            pts.push({ x: nums[i], y: -nums[i + 1] });
          }
          if (pts.length >= 2) {
            entities.push(makeImportEntity({
              type: 'polyline',
              points: pts,
              bulges: pts.map(() => 0),
              closed: tag === 'polygon',
            }));
          }
        } else if (tag === 'ellipse') {
          const cx = parseNumber(el.getAttribute('cx'));
          const cy = parseNumber(el.getAttribute('cy'));
          const rx = parseNumber(el.getAttribute('rx'));
          const ry = parseNumber(el.getAttribute('ry'));
          if (Math.abs(rx - ry) < 0.001) {
            entities.push(makeImportEntity({
              type: 'circle',
              center: { x: cx, y: -cy },
              radius: rx,
            }));
          } else {
            entities.push(makeImportEntity({
              type: 'ellipse',
              center: { x: cx, y: -cy },
              majorX: rx, majorY: 0,
              ratio: ry / rx,
              startParam: 0, endParam: Math.PI * 2,
            }));
          }
        } else if (tag === 'text') {
          const x = parseNumber(el.getAttribute('x'));
          const y = parseNumber(el.getAttribute('y'));
          const content = el.textContent || '';
          const fontSize = parseNumber(el.getAttribute('font-size')) || 2.5;
          if (content.trim()) {
            entities.push(makeImportEntity({
              type: 'text',
              position: { x, y: -y },
              text: content.trim(),
              height: fontSize,
              rotation: 0,
            }));
          }
        } else if (tag === 'g' || tag === 'svg') {
          for (const child of Array.from(el.children)) {
            processElement(child);
          }
        }
      }

      processElement(doc.documentElement);
      if (entities.length > 0) {
        store.pushUndo('IMPORT');
        for (const e of entities) store.addEntity(e);
        engine.prompt(`Imported ${entities.length} entities from ${file.name}`);
      } else {
        engine.prompt('No importable geometry found in SVG');
      }
      engine.complete();
    };
    reader.readAsText(file);
  };
  input.click();
}

function makeImportEntity(partial: Partial<Entity> & { type: Entity['type'] }): Entity {
  const layer = store.currentLayer();
  return {
    id: nextId(),
    layer: layer.name,
    color: 'bylayer',
    lineweight: 1,
    linetype: 'continuous',
    visible: true,
    selected: false,
    ...partial,
  } as Entity;
}
