import { Point, Entity, CircleEntity, ArcEntity, PolylineEntity, RectEntity, EllipseEntity } from '../types';
import { store } from '../store';
import { dist, closestPointOnLine, closestPointOnCircle, pointOnEntity, bulgeArc } from '../geometry';
import { CommandEngine } from './engine';
import { makeEntity, entityEndpoints } from './helpers';

interface PolySeg {
  p1: Point;
  p2: Point;
  len: number;
  bulge: number;
  center?: Point;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  ccw?: boolean;
}

function buildPolySegments(entity: PolylineEntity): { segs: PolySeg[]; totalLen: number } {
  const segs: PolySeg[] = [];
  let totalLen = 0;
  const count = entity.closed && entity.points.length > 2
    ? entity.points.length
    : entity.points.length - 1;
  for (let i = 0; i < count; i++) {
    const p1 = entity.points[i];
    const p2 = entity.points[(i + 1) % entity.points.length];
    const b = entity.bulges?.[i] || 0;
    if (b !== 0) {
      const arc = bulgeArc(p1, p2, b);
      const sweep = 4 * Math.atan(Math.abs(b));
      const arcLen = arc.radius * sweep;
      segs.push({
        p1, p2, len: arcLen, bulge: b,
        center: arc.center, radius: arc.radius,
        startAngle: arc.startAngle, endAngle: arc.endAngle, ccw: arc.ccw,
      });
      totalLen += arcLen;
    } else {
      const len = dist(p1, p2);
      segs.push({ p1, p2, len, bulge: 0 });
      totalLen += len;
    }
  }
  return { segs, totalLen };
}

function interpolateOnSeg(seg: PolySeg, d: number): Point {
  if (seg.bulge === 0 || !seg.center || !seg.radius) {
    const t = seg.len > 0 ? d / seg.len : 0;
    return {
      x: seg.p1.x + (seg.p2.x - seg.p1.x) * t,
      y: seg.p1.y + (seg.p2.y - seg.p1.y) * t,
    };
  }
  const t = seg.len > 0 ? d / seg.len : 0;
  let delta = seg.endAngle! - seg.startAngle!;
  if (seg.bulge > 0) {
    while (delta >= 0) delta -= 2 * Math.PI;
  } else {
    while (delta <= 0) delta += 2 * Math.PI;
  }
  const a = seg.startAngle! + delta * t;
  return {
    x: seg.center!.x + seg.radius! * Math.cos(a),
    y: seg.center!.y + seg.radius! * Math.sin(a),
  };
}

function getDivisionPoints(entity: Entity, n: number): Point[] {
  const pts: Point[] = [];
  if (entity.type === 'line') {
    for (let i = 1; i < n; i++) {
      const t = i / n;
      pts.push({
        x: entity.start.x + (entity.end.x - entity.start.x) * t,
        y: entity.start.y + (entity.end.y - entity.start.y) * t,
      });
    }
  } else if (entity.type === 'circle') {
    for (let i = 1; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      pts.push({
        x: entity.center.x + entity.radius * Math.cos(a),
        y: entity.center.y + entity.radius * Math.sin(a),
      });
    }
  } else if (entity.type === 'arc') {
    let start = entity.startAngle * Math.PI / 180;
    let end = entity.endAngle * Math.PI / 180;
    if (end <= start) end += 2 * Math.PI;
    for (let i = 1; i < n; i++) {
      const a = start + (end - start) * i / n;
      pts.push({
        x: entity.center.x + entity.radius * Math.cos(a),
        y: entity.center.y + entity.radius * Math.sin(a),
      });
    }
  } else if (entity.type === 'polyline') {
    const { segs, totalLen } = buildPolySegments(entity);
    const segLen = totalLen / n;
    for (let i = 1; i < n; i++) {
      let target = segLen * i;
      for (const seg of segs) {
        if (target <= seg.len + 1e-10) {
          pts.push(interpolateOnSeg(seg, Math.min(target, seg.len)));
          break;
        }
        target -= seg.len;
      }
    }
  }
  return pts;
}

function getMeasurePoints(entity: Entity, segLen: number): Point[] {
  const pts: Point[] = [];
  if (entity.type === 'line') {
    const totalLen = dist(entity.start, entity.end);
    const dx = entity.end.x - entity.start.x, dy = entity.end.y - entity.start.y;
    for (let d = segLen; d < totalLen; d += segLen) {
      const t = d / totalLen;
      pts.push({ x: entity.start.x + dx * t, y: entity.start.y + dy * t });
    }
  } else if (entity.type === 'circle') {
    const circumference = 2 * Math.PI * entity.radius;
    for (let d = segLen; d < circumference; d += segLen) {
      const a = (d / circumference) * 2 * Math.PI;
      pts.push({ x: entity.center.x + entity.radius * Math.cos(a), y: entity.center.y + entity.radius * Math.sin(a) });
    }
  } else if (entity.type === 'polyline') {
    const { segs, totalLen } = buildPolySegments(entity);
    for (let d = segLen; d < totalLen; d += segLen) {
      let remaining = d;
      for (const seg of segs) {
        if (remaining <= seg.len + 1e-10) {
          pts.push(interpolateOnSeg(seg, Math.min(remaining, seg.len)));
          break;
        }
        remaining -= seg.len;
      }
    }
  }
  return pts;
}

export function registerInquiryCommands(engine: CommandEngine) {

  // === DIST (DI) ===
  engine.register('DIST', ['DI'], () => {
    engine.prompt('DIST Specify first point:');
    engine.waitForClick((p1) => {
      engine.tempPoints = [p1];
      engine.prompt('Specify second point:');
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: p1, end: p };
      });
      engine.waitForClick((p2) => {
        engine.renderer.rubberBand = null;
        const d = dist(p1, p2);
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const ang = Math.atan2(dy, dx) * 180 / Math.PI;
        const prec = store.unitPrecision;
        engine.prompt(`Distance = ${d.toFixed(prec)}, Angle = ${ang.toFixed(1)}°, Delta X = ${dx.toFixed(prec)}, Delta Y = ${dy.toFixed(prec)}`);
        engine.complete();
      });
    });
  });

  // === LIST (LI) — enhanced ===
  engine.register('LIST', ['LI', 'LS'], () => {
    engine.requireSelection((sel) => {
      const prec = store.unitPrecision;
      for (const e of sel) {
        const base = `  ${e.type.toUpperCase()} Layer: "${e.layer}" Color: ${e.color}`;
        engine.prompt(base);
        switch (e.type) {
          case 'line': {
            const len = dist(e.start, e.end);
            engine.prompt(`    from (${e.start.x.toFixed(prec)}, ${e.start.y.toFixed(prec)}) to (${e.end.x.toFixed(prec)}, ${e.end.y.toFixed(prec)}) Length: ${len.toFixed(prec)}`);
            break;
          }
          case 'circle':
            engine.prompt(`    Center (${e.center.x.toFixed(prec)}, ${e.center.y.toFixed(prec)}) Radius: ${e.radius.toFixed(prec)} Circumference: ${(2 * Math.PI * e.radius).toFixed(prec)} Area: ${(Math.PI * e.radius * e.radius).toFixed(prec)}`);
            break;
          case 'arc':
            engine.prompt(`    Center (${e.center.x.toFixed(prec)}, ${e.center.y.toFixed(prec)}) Radius: ${e.radius.toFixed(prec)} Start: ${e.startAngle.toFixed(1)}° End: ${e.endAngle.toFixed(1)}°`);
            break;
          case 'polyline': {
            let len = 0;
            for (let i = 0; i < e.points.length - 1; i++) len += dist(e.points[i], e.points[i + 1]);
            if (e.closed && e.points.length > 2) len += dist(e.points[e.points.length - 1], e.points[0]);
            engine.prompt(`    ${e.points.length} vertices, ${e.closed ? 'Closed' : 'Open'}, Length: ${len.toFixed(prec)}`);
            if (e.closed && e.points.length >= 3) {
              let area = 0;
              for (let i = 0; i < e.points.length; i++) {
                const j = (i + 1) % e.points.length;
                area += e.points[i].x * e.points[j].y - e.points[j].x * e.points[i].y;
              }
              engine.prompt(`    Area: ${Math.abs(area / 2).toFixed(prec)}`);
            }
            break;
          }
          case 'rect':
            engine.prompt(`    Corner1 (${e.corner1.x.toFixed(prec)}, ${e.corner1.y.toFixed(prec)}) Corner2 (${e.corner2.x.toFixed(prec)}, ${e.corner2.y.toFixed(prec)})`);
            engine.prompt(`    Width: ${Math.abs(e.corner2.x - e.corner1.x).toFixed(prec)} Height: ${Math.abs(e.corner2.y - e.corner1.y).toFixed(prec)} Area: ${(Math.abs(e.corner2.x - e.corner1.x) * Math.abs(e.corner2.y - e.corner1.y)).toFixed(prec)}`);
            break;
          case 'text':
            engine.prompt(`    Position (${e.position.x.toFixed(prec)}, ${e.position.y.toFixed(prec)}) Height: ${e.height} Content: "${e.text}"`);
            break;
          case 'ellipse':
            engine.prompt(`    Center (${e.center.x.toFixed(prec)}, ${e.center.y.toFixed(prec)}) Major: (${e.majorX.toFixed(prec)}, ${e.majorY.toFixed(prec)}) Ratio: ${e.ratio.toFixed(prec)}`);
            break;
          case 'point':
            engine.prompt(`    Position (${e.position.x.toFixed(prec)}, ${e.position.y.toFixed(prec)})`);
            break;
        }
      }
      engine.prompt(`${sel.length} object(s) listed`);
      engine.complete();
    });
  });

  // === AREA (AA) ===
  engine.register('AREA', ['AA'], () => {
    store.tool = 'area';
    engine.prompt('AREA Specify first corner point or [Object]:');
    const pickedPts: Point[] = [];
    engine.inputHandler = (input) => {
      if (input === '') {
        if (pickedPts.length >= 3) {
          let area = 0;
          for (let i = 0; i < pickedPts.length; i++) {
            const j = (i + 1) % pickedPts.length;
            area += pickedPts[i].x * pickedPts[j].y - pickedPts[j].x * pickedPts[i].y;
          }
          area = Math.abs(area / 2);
          let perimeter = 0;
          for (let i = 0; i < pickedPts.length; i++) {
            perimeter += dist(pickedPts[i], pickedPts[(i + 1) % pickedPts.length]);
          }
          engine.prompt(`Area = ${area.toFixed(store.unitPrecision)}, Perimeter = ${perimeter.toFixed(store.unitPrecision)}`);
        }
        engine.renderer.rubberPolyline = null;
        engine.complete();
        return true;
      }
      const lower = input.toLowerCase();
      if (lower === 'o' || lower === 'object') {
        engine.inputHandler = null;
        engine.prompt('Select object:');
        engine.waitForClick((pt) => {
          const tol = 10 / store.view.zoom;
          const entity = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
          if (!entity) { engine.prompt('No object found'); engine.complete(); return; }
          const result = computeEntityArea(entity);
          if (result) {
            engine.prompt(`Area = ${result.area.toFixed(store.unitPrecision)}, Perimeter = ${result.perimeter.toFixed(store.unitPrecision)}`);
          } else {
            engine.prompt('Cannot compute area for this entity type');
          }
          engine.complete();
        });
        return true;
      }
      const pt = engine.parseCoordinate(input);
      if (pt) { engine.handleClick(pt); return true; }
      return false;
    };
    engine.waitForClick((pt) => {
      pickedPts.push(pt);
      engine.renderer.rubberPolyline = [...pickedPts];
      doAreaNextPoint(engine, pickedPts);
    });
    engine.onCancel(() => { engine.renderer.rubberPolyline = null; });
  });

  // === SELECT ===
  engine.register('SELECT', ['SEL'], () => {
    store.tool = 'select';
    engine.prompt('SELECT Select objects:');
    doSelectLoop(engine);
  });

  // === DIVIDE (DIV) ===
  engine.register('DIVIDE', ['DIV'], () => {
    engine.prompt('DIVIDE Select object to divide:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const entity = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
      if (!entity) { engine.prompt('No object found'); engine.complete(); return; }
      engine.prompt('Enter number of segments:');
      engine.waitForInput('Number of segments:', (input) => {
        const n = parseInt(input);
        if (isNaN(n) || n < 2) { engine.prompt('Must be >= 2'); engine.complete(); return true; }
        const pts = getDivisionPoints(entity, n);
        if (pts.length === 0) { engine.prompt('Cannot divide this entity type'); engine.complete(); return true; }
        store.pushUndo('DIVIDE');
        for (const p of pts) {
          store.addEntity(makeEntity({
            type: 'point', position: p, pdmode: store.pdmode, pdsize: store.pdsize,
          } as any));
        }
        engine.prompt(`${pts.length} point(s) placed`);
        engine.complete();
        return true;
      });
    });
  });

  // === ID ===
  engine.register('ID', [], () => {
    engine.prompt('ID Specify point:');
    engine.waitForClick((pt) => {
      const prec = store.unitPrecision;
      engine.prompt(`X = ${pt.x.toFixed(prec)}  Y = ${pt.y.toFixed(prec)}`);
      store.lastPoint = { ...pt };
      engine.complete();
    });
  });

  // === MEASURE (ME) ===
  engine.register('MEASURE', ['ME'], () => {
    engine.prompt('MEASURE Select object to measure:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const entity = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
      if (!entity) { engine.prompt('No object found'); engine.complete(); return; }
      engine.prompt('Specify length of segment:');
      engine.waitForInput('Segment length:', (input) => {
        const segLen = parseFloat(input);
        if (isNaN(segLen) || segLen <= 0) { engine.prompt('Must be a positive number'); engine.complete(); return true; }
        const pts = getMeasurePoints(entity, segLen);
        if (pts.length === 0) { engine.prompt('Cannot measure this entity type'); engine.complete(); return true; }
        store.pushUndo('MEASURE');
        for (const p of pts) {
          store.addEntity(makeEntity({
            type: 'point', position: p, pdmode: store.pdmode, pdsize: store.pdsize,
          } as any));
        }
        engine.prompt(`${pts.length} point(s) placed at intervals of ${segLen}`);
        engine.complete();
        return true;
      });
    });
  });

  // === QSELECT ===
  engine.register('QSELECT', ['QS', 'QUICKSELECT'], () => {
    engine.prompt('QSELECT Apply to: [Entire drawing/Current selection] <Entire drawing>:');
    engine.waitForInput('Apply to:', (scopeInput) => {
      const lower = scopeInput.toLowerCase();
      const source = (lower === 'c' || lower === 'current')
        ? store.selectedEntities()
        : store.entities;
      const sourceCount = source.length;

      engine.prompt('Object type [All/Line/Circle/Arc/Polyline/Rect/Text/Point/Dimension/Hatch/Blockref/Ellipse/Region] <All>:');
      engine.waitForInput('Type:', (typeInput) => {
        const typeLower = typeInput.toLowerCase();
        const typeFilter = (typeLower && typeLower !== 'all') ? typeLower : null;
        let candidates = typeFilter ? source.filter(e => e.type === typeFilter) : [...source];

        engine.prompt('Property [Layer/Color/Linetype] <Layer>:');
        engine.waitForInput('Property:', (propInput) => {
          const prop = propInput.toLowerCase() || 'layer';
          if (!['layer', 'color', 'linetype'].includes(prop)) {
            engine.prompt('Invalid property. Use Layer, Color, or Linetype.');
            engine.complete();
            return true;
          }

          engine.prompt('Operator [= Equals/!= Not equals] <=>:');
          engine.waitForInput('Operator:', (opInput) => {
            const op = opInput.trim() === '!=' ? '!=' : '=';

            engine.prompt('Value:');
            engine.waitForInput('Value:', (valInput) => {
              const val = valInput.trim();
              if (!val) { engine.prompt('No value specified'); engine.complete(); return true; }

              const matches = candidates.filter(e => {
                let entityVal = '';
                if (prop === 'layer') entityVal = e.layer;
                else if (prop === 'color') entityVal = e.color;
                else if (prop === 'linetype') entityVal = e.linetype;
                if (op === '=') return entityVal.toLowerCase() === val.toLowerCase();
                return entityVal.toLowerCase() !== val.toLowerCase();
              });

              store.clearSelection();
              for (const e of matches) e.selected = true;
              store.emit();
              engine.prompt(`${matches.length} object(s) selected out of ${sourceCount}`);
              engine.complete();
              return true;
            });
            return true;
          });
          return true;
        });
        return true;
      });
      return true;
    });
  });

  // === DBLIST ===
  engine.register('DBLIST', [], () => {
    const entities = store.entities;
    if (entities.length === 0) {
      engine.prompt('DBLIST: Drawing is empty');
      engine.complete();
      return;
    }
    const counts: Record<string, number> = {};
    const layerSet = new Set<string>();
    for (const e of entities) {
      counts[e.type] = (counts[e.type] || 0) + 1;
      layerSet.add(e.layer);
    }
    engine.prompt('--- Database Listing ---');
    for (const [type, count] of Object.entries(counts).sort()) {
      engine.prompt(`  ${type.toUpperCase()}: ${count}`);
    }
    engine.prompt(`Total: ${entities.length} entities on ${layerSet.size} layer(s)`);
    engine.complete();
  });

  // === MASSPROP ===
  engine.register('MASSPROP', [], () => {
    engine.requireSelection((sel) => {
      let totalLength = 0;
      let totalArea = 0;
      let count = 0;
      for (const e of sel) {
        count++;
        if (e.type === 'line') {
          const len = dist(e.start, e.end);
          totalLength += len;
          engine.prompt(`  LINE length: ${len.toFixed(4)}`);
        } else if (e.type === 'circle') {
          const area = Math.PI * e.radius * e.radius;
          const perim = 2 * Math.PI * e.radius;
          totalArea += area;
          totalLength += perim;
          engine.prompt(`  CIRCLE area: ${area.toFixed(4)}  circumference: ${perim.toFixed(4)}`);
        } else if (e.type === 'arc') {
          let sa = e.startAngle, ea = e.endAngle;
          if (ea <= sa) ea += 360;
          const span = (ea - sa) * Math.PI / 180;
          const len = e.radius * span;
          totalLength += len;
          engine.prompt(`  ARC length: ${len.toFixed(4)}`);
        } else if (e.type === 'rect') {
          const w = Math.abs(e.corner2.x - e.corner1.x);
          const h = Math.abs(e.corner2.y - e.corner1.y);
          const area = w * h;
          const perim = 2 * (w + h);
          totalArea += area;
          totalLength += perim;
          engine.prompt(`  RECT area: ${area.toFixed(4)}  perimeter: ${perim.toFixed(4)}`);
        } else if (e.type === 'polyline') {
          let perim = 0;
          for (let i = 0; i < e.points.length - 1; i++) {
            perim += dist(e.points[i], e.points[i + 1]);
          }
          if (e.closed && e.points.length > 1) {
            perim += dist(e.points[e.points.length - 1], e.points[0]);
          }
          totalLength += perim;
          if (e.closed && e.points.length >= 3) {
            let area = 0;
            for (let i = 0; i < e.points.length; i++) {
              const j = (i + 1) % e.points.length;
              area += e.points[i].x * e.points[j].y - e.points[j].x * e.points[i].y;
            }
            area = Math.abs(area / 2);
            totalArea += area;
            engine.prompt(`  POLYLINE perimeter: ${perim.toFixed(4)}  area: ${area.toFixed(4)}`);
          } else {
            engine.prompt(`  POLYLINE length: ${perim.toFixed(4)}`);
          }
        } else if (e.type === 'ellipse') {
          const a = Math.hypot(e.majorX, e.majorY);
          const b = a * e.ratio;
          const area = Math.PI * a * b;
          const perim = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
          totalArea += area;
          totalLength += perim;
          engine.prompt(`  ELLIPSE area: ${area.toFixed(4)}  perimeter: ${perim.toFixed(4)}`);
        }
      }
      engine.prompt(`MASSPROP: ${count} object(s) — Total length: ${totalLength.toFixed(4)}  Total area: ${totalArea.toFixed(4)}`);
      store.clearSelection();
      engine.complete();
    });
  });

  // === CHECKPROFILE (CHKP) ===
  engine.register('CHECKPROFILE', ['CHKP'], () => {
    const PROFILE_TOL = 0.01;

    function doCheck(ents: Entity[]) {
      const relevantTypes = ['line', 'arc', 'circle', 'polyline', 'rect'];
      const relevant = ents.filter(e => relevantTypes.includes(e.type));
      if (relevant.length === 0) {
        engine.prompt('CHECKPROFILE: No line, arc, circle, polyline, or rect entities found');
        engine.complete();
        return;
      }

      let closedCount = 0;
      const openEnts: Entity[] = [];

      for (const e of relevant) {
        if (e.type === 'circle' || e.type === 'rect') {
          closedCount++;
        } else if (e.type === 'polyline' && (e as PolylineEntity).closed) {
          closedCount++;
        } else {
          openEnts.push(e);
        }
      }

      let closedLoops = 0;
      const gapPoints: Point[] = [];

      if (openEnts.length > 0) {
        interface OpenEnt {
          entity: Entity;
          start: Point;
          end: Point;
          used: boolean;
        }
        const items: OpenEnt[] = [];
        for (const e of openEnts) {
          const ep = entityEndpoints(e);
          if (ep) {
            items.push({ entity: e, start: ep.start, end: ep.end, used: false });
          }
        }

        function ptsNear(a: Point, b: Point): boolean {
          return dist(a, b) < PROFILE_TOL;
        }

        while (true) {
          const startIdx = items.findIndex(it => !it.used);
          if (startIdx === -1) break;

          items[startIdx].used = true;
          const chainStart = items[startIdx].start;
          let chainEnd = items[startIdx].end;

          let extended = true;
          while (extended) {
            extended = false;
            for (const it of items) {
              if (it.used) continue;
              if (ptsNear(chainEnd, it.start)) {
                it.used = true;
                chainEnd = it.end;
                extended = true;
                break;
              } else if (ptsNear(chainEnd, it.end)) {
                it.used = true;
                chainEnd = it.start;
                extended = true;
                break;
              }
            }
          }

          if (ptsNear(chainStart, chainEnd)) {
            closedLoops++;
          } else {
            gapPoints.push(chainStart);
            gapPoints.push(chainEnd);
          }
        }
      }

      const totalClosed = closedCount + closedLoops;

      if (gapPoints.length > 0) {
        store.pushUndo('CHECKPROFILE');
        if (!store.layers.find(l => l.name === 'GAPS')) {
          store.layers.push({
            name: 'GAPS', color: '#ff0000', visible: true, locked: false,
            frozen: false, current: false, lineweight: 0, plot: true,
          });
        }
        for (const gp of gapPoints) {
          store.addEntity(makeEntity({
            type: 'point',
            position: gp,
            layer: 'GAPS',
            color: '#ff0000',
          } as any));
        }
      }

      engine.prompt('--- CHECKPROFILE Results ---');
      if (closedCount > 0) {
        engine.prompt(`  Inherently closed (circles/rects/closed polylines): ${closedCount}`);
      }
      if (closedLoops > 0) {
        engine.prompt(`  Closed chains found: ${closedLoops}`);
      }
      engine.prompt(`  Total closed profiles: ${totalClosed}`);
      if (gapPoints.length > 0) {
        engine.prompt(`  Open chains with gaps: ${gapPoints.length / 2}`);
        engine.prompt(`  Gap points marked: ${gapPoints.length} (on layer GAPS in red)`);
      } else if (openEnts.length === 0) {
        engine.prompt('  All profiles are closed');
      } else {
        engine.prompt('  All chains form closed loops');
      }
      store.clearSelection();
      engine.complete();
    }

    let ents = store.entities.filter(e => e.selected && e.visible);
    if (ents.length === 0) {
      engine.prompt('CHECKPROFILE Select objects:');
      engine.waitForClick((pt) => {
        const tol = 10 / store.view.zoom;
        for (const e of store.entities) {
          if (e.visible && pointOnEntity(pt, e, tol)) {
            e.selected = true;
            break;
          }
        }
        store.emit();
        engine.prompt(`${store.selectedEntities().length} found. Select objects or press Enter:`);
        doCheckSelectionLoop(engine, doCheck);
      });
      engine.inputHandler = (input: string) => {
        if (input === '') {
          ents = store.entities.filter(e => e.selected && e.visible);
          if (ents.length === 0) {
            engine.prompt('No entities selected');
            engine.complete();
            return true;
          }
          doCheck(ents);
          return true;
        }
        return false;
      };
      return;
    }
    doCheck(ents);
  });
}

function doCheckSelectionLoop(engine: CommandEngine, doCheck: (ents: Entity[]) => void) {
  engine.inputHandler = (input: string) => {
    if (input === '') {
      const ents = store.entities.filter(e => e.selected && e.visible);
      if (ents.length === 0) {
        engine.prompt('No entities selected');
        engine.complete();
        return true;
      }
      doCheck(ents);
      return true;
    }
    return false;
  };
  engine.waitForClick((pt) => {
    const tol = 10 / store.view.zoom;
    for (const e of store.entities) {
      if (e.visible && pointOnEntity(pt, e, tol)) {
        e.selected = true;
        break;
      }
    }
    store.emit();
    engine.prompt(`${store.selectedEntities().length} found. Select objects or press Enter:`);
    doCheckSelectionLoop(engine, doCheck);
  });
}

function doAreaNextPoint(engine: CommandEngine, pts: Point[]) {
  engine.prompt(`Specify next corner point (${pts.length} picked) or press Enter to compute:`);
  engine.onMove(() => {});
  engine.inputHandler = (input) => {
    if (input === '') {
      if (pts.length >= 3) {
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
          const j = (i + 1) % pts.length;
          area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        }
        area = Math.abs(area / 2);
        let perimeter = 0;
        for (let i = 0; i < pts.length; i++) {
          perimeter += dist(pts[i], pts[(i + 1) % pts.length]);
        }
        engine.prompt(`Area = ${area.toFixed(store.unitPrecision)}, Perimeter = ${perimeter.toFixed(store.unitPrecision)}`);
      } else {
        engine.prompt('Need at least 3 points');
      }
      engine.renderer.rubberPolyline = null;
      engine.complete();
      return true;
    }
    const pt = engine.parseCoordinate(input);
    if (pt) { engine.handleClick(pt); return true; }
    return false;
  };
  engine.waitForClick((pt) => {
    pts.push(pt);
    engine.renderer.rubberPolyline = [...pts];
    doAreaNextPoint(engine, pts);
  });
  engine.onCancel(() => { engine.renderer.rubberPolyline = null; });
}

function doSelectLoop(engine: CommandEngine) {
  engine.inputHandler = (input) => {
    if (input === '') {
      const count = store.selectedEntities().length;
      engine.prompt(`${count} object(s) selected`);
      engine.complete();
      return true;
    }
    return false;
  };
  engine.waitForClick((pt) => {
    const tol = 10 / store.view.zoom;
    for (const e of store.entities) {
      if (e.visible && pointOnEntity(pt, e, tol)) {
        e.selected = !e.selected;
        break;
      }
    }
    store.emit();
    engine.prompt(`${store.selectedEntities().length} found. Select more or press Enter:`);
    doSelectLoop(engine);
  });
}

function computeEntityArea(e: Entity): { area: number; perimeter: number } | null {
  switch (e.type) {
    case 'circle': {
      const c = e as CircleEntity;
      return { area: Math.PI * c.radius * c.radius, perimeter: 2 * Math.PI * c.radius };
    }
    case 'polyline': {
      const p = e as PolylineEntity;
      if (!p.closed || p.points.length < 3) return null;
      let area = 0;
      let perimeter = 0;
      for (let i = 0; i < p.points.length; i++) {
        const j = (i + 1) % p.points.length;
        area += p.points[i].x * p.points[j].y - p.points[j].x * p.points[i].y;
        perimeter += dist(p.points[i], p.points[j]);
      }
      return { area: Math.abs(area / 2), perimeter };
    }
    case 'rect': {
      const r = e as RectEntity;
      const w = Math.abs(r.corner2.x - r.corner1.x);
      const h = Math.abs(r.corner2.y - r.corner1.y);
      return { area: w * h, perimeter: 2 * (w + h) };
    }
    case 'ellipse': {
      const el = e as EllipseEntity;
      const a = Math.hypot(el.majorX, el.majorY);
      const b = a * el.ratio;
      return { area: Math.PI * a * b, perimeter: Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))) };
    }
    default:
      return null;
  }
}
