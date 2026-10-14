import { Entity } from '../types';
import { store } from '../store';
import { CommandEngine } from './engine';
import { dist, angle } from '../geometry';

function segmentLength(ax: number, ay: number, bx: number, by: number, bulge: number): number {
  const chordLen = Math.hypot(bx - ax, by - ay);
  if (Math.abs(bulge) < 1e-10) return chordLen;
  const includedAngle = 4 * Math.atan(Math.abs(bulge));
  const sinHalf = Math.sin(includedAngle / 2);
  if (Math.abs(sinHalf) < 1e-10) return chordLen;
  const radius = chordLen / (2 * sinHalf);
  return Math.abs(radius * includedAngle);
}

function polylineLength(points: { x: number; y: number }[], bulges: number[], closed: boolean): number {
  let total = 0;
  const n = points.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const bulge = (bulges && i < bulges.length) ? bulges[i] : 0;
    total += segmentLength(a.x, a.y, b.x, b.y, bulge);
  }
  return total;
}

function polylineArea(points: { x: number; y: number }[]): number {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area) / 2;
}

export function registerPropertiesCommands(engine: CommandEngine) {

  engine.register('PROPERTIES', ['MO', 'PR', 'PROPS'], () => {
    store.tool = 'properties';
    engine.requireSelection((sel) => {
      if (sel.length > 1) engine.prompt(`${sel.length} objects selected, showing first`);
      const e = sel[0];
      showProps(e);
      promptChange(e);
    });
  });

  function showProps(e: Entity) {
    engine.prompt(`--- ${e.type.toUpperCase()} ---`);
    engine.prompt(`  Type: ${e.type.toUpperCase()}`);
    engine.prompt(`  Layer: ${e.layer}  Color: ${e.color}  Linetype: ${e.linetype}  Lineweight: ${e.lineweight}`);
    switch (e.type) {
      case 'line': {
        const len = dist(e.start, e.end);
        const ang = angle(e.start, e.end) * 180 / Math.PI;
        engine.prompt(`  Start: (${e.start.x.toFixed(4)}, ${e.start.y.toFixed(4)})`);
        engine.prompt(`  End: (${e.end.x.toFixed(4)}, ${e.end.y.toFixed(4)})`);
        engine.prompt(`  Length: ${len.toFixed(4)}`);
        engine.prompt(`  Angle: ${ang.toFixed(1)}`);
        break;
      }
      case 'circle': {
        const circumference = 2 * Math.PI * e.radius;
        const area = Math.PI * e.radius * e.radius;
        engine.prompt(`  Center: (${e.center.x.toFixed(4)}, ${e.center.y.toFixed(4)})`);
        engine.prompt(`  Radius: ${e.radius.toFixed(4)}`);
        engine.prompt(`  Circumference: ${circumference.toFixed(4)}`);
        engine.prompt(`  Area: ${area.toFixed(4)}`);
        break;
      }
      case 'arc': {
        let sweep = e.endAngle - e.startAngle;
        if (sweep < 0) sweep += 2 * Math.PI;
        const arcLen = e.radius * sweep;
        engine.prompt(`  Center: (${e.center.x.toFixed(4)}, ${e.center.y.toFixed(4)})`);
        engine.prompt(`  Radius: ${e.radius.toFixed(4)}`);
        engine.prompt(`  Start Angle: ${(e.startAngle * 180 / Math.PI).toFixed(1)}`);
        engine.prompt(`  End Angle: ${(e.endAngle * 180 / Math.PI).toFixed(1)}`);
        engine.prompt(`  Arc Length: ${arcLen.toFixed(4)}`);
        break;
      }
      case 'polyline': {
        const len = polylineLength(e.points, e.bulges, e.closed);
        engine.prompt(`  Vertices: ${e.points.length}`);
        engine.prompt(`  Closed: ${e.closed ? 'yes' : 'no'}`);
        engine.prompt(`  Total Length: ${len.toFixed(4)}`);
        if (e.closed && e.points.length >= 3) {
          const area = polylineArea(e.points);
          engine.prompt(`  Area: ${area.toFixed(4)}`);
        }
        break;
      }
      case 'rect': {
        const w = Math.abs(e.corner2.x - e.corner1.x);
        const h = Math.abs(e.corner2.y - e.corner1.y);
        const area = w * h;
        engine.prompt(`  Corner1: (${e.corner1.x.toFixed(4)}, ${e.corner1.y.toFixed(4)})`);
        engine.prompt(`  Corner2: (${e.corner2.x.toFixed(4)}, ${e.corner2.y.toFixed(4)})`);
        engine.prompt(`  Width: ${w.toFixed(4)}`);
        engine.prompt(`  Height: ${h.toFixed(4)}`);
        engine.prompt(`  Area: ${area.toFixed(4)}`);
        break;
      }
      case 'text':
        engine.prompt(`  Position: (${e.position.x.toFixed(4)}, ${e.position.y.toFixed(4)})`);
        engine.prompt(`  Content: "${e.text}"`);
        engine.prompt(`  Height: ${e.height}`);
        break;
      case 'ellipse': {
        const semiMajor = Math.hypot(e.majorX, e.majorY);
        const semiMinor = semiMajor * e.ratio;
        engine.prompt(`  Center: (${e.center.x.toFixed(4)}, ${e.center.y.toFixed(4)})`);
        engine.prompt(`  Semi-major: ${semiMajor.toFixed(4)}`);
        engine.prompt(`  Semi-minor: ${semiMinor.toFixed(4)}`);
        break;
      }
      case 'dimension':
        engine.prompt(`  Type: ${e.dimType}`);
        engine.prompt(`  P1: (${e.p1.x.toFixed(4)}, ${e.p1.y.toFixed(4)})`);
        engine.prompt(`  P2: (${e.p2.x.toFixed(4)}, ${e.p2.y.toFixed(4)})`);
        break;
      case 'point':
        engine.prompt(`  Position: (${e.position.x.toFixed(4)}, ${e.position.y.toFixed(4)})`);
        break;
    }
  }

  function promptChange(e: Entity) {
    engine.prompt('Enter property to modify [Layer/Color/Linetype/Lineweight] or Enter to exit:');
    engine.waitForInput('Property:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const prop = input.toUpperCase();
      if (prop === 'LAYER' || prop === 'LA') {
        const names = store.layers.map(l => l.name).join(', ');
        engine.prompt(`Available layers: ${names}`);
        engine.prompt('Enter new layer:');
        engine.waitForInput('Layer:', (val) => {
          if (!val.trim()) { promptChange(e); return true; }
          const layer = store.layers.find(l => l.name.toUpperCase() === val.toUpperCase());
          if (!layer) { engine.prompt('Layer not found: ' + val); promptChange(e); return true; }
          store.pushUndo('PROPERTIES');
          e.layer = layer.name;
          store.emit();
          engine.prompt(`Layer set to "${layer.name}"`);
          showProps(e);
          promptChange(e);
          return true;
        });
        return true;
      }
      if (prop === 'COLOR' || prop === 'COL') {
        engine.prompt('Enter new color (bylayer, 1-7, or hex #rrggbb):');
        engine.waitForInput('Color:', (val) => {
          if (!val.trim()) { promptChange(e); return true; }
          store.pushUndo('PROPERTIES');
          e.color = val.trim();
          store.emit();
          engine.prompt(`Color set to "${e.color}"`);
          showProps(e);
          promptChange(e);
          return true;
        });
        return true;
      }
      if (prop === 'LINETYPE' || prop === 'LT') {
        engine.prompt('Enter new linetype (continuous, dashed, hidden, center, dashdot, phantom, dot, border, divide):');
        engine.waitForInput('Linetype:', (val) => {
          if (!val.trim()) { promptChange(e); return true; }
          store.pushUndo('PROPERTIES');
          e.linetype = val.trim().toLowerCase();
          store.emit();
          engine.prompt(`Linetype set to "${e.linetype}"`);
          showProps(e);
          promptChange(e);
          return true;
        });
        return true;
      }
      if (prop === 'LINEWEIGHT' || prop === 'LW') {
        engine.prompt(`Current lineweight: ${e.lineweight}. Enter new lineweight:`);
        engine.waitForInput('Lineweight:', (val) => {
          const n = parseFloat(val);
          if (isNaN(n) || n < 0) { engine.prompt('Invalid lineweight'); promptChange(e); return true; }
          store.pushUndo('PROPERTIES');
          e.lineweight = n;
          store.emit();
          engine.prompt(`Lineweight set to ${n}`);
          showProps(e);
          promptChange(e);
          return true;
        });
        return true;
      }
      engine.prompt('Unknown property: ' + input);
      promptChange(e);
      return true;
    });
  }
}
