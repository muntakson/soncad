import { Point, Entity, LineEntity, CircleEntity, ArcEntity, PolylineEntity } from '../types';
import { store } from '../store';
import { dist, angle, polarPoint, closestPointOnLine, lineCircleIntersections, lineCircleIntersectionsInf,
         circleCircleIntersections, angleInArc, normalizeAngle, pointOnEntity } from '../geometry';
import { CommandEngine } from './engine';
import { makeEntity, trimToIntersection, lineLineIntersectionInf, findIntersections } from './helpers';

export function registerTrimExtendCommands(engine: CommandEngine) {

  // === TRIM ===
  engine.register('TRIM', ['TR'], () => {
    const cuttingEdges: Entity[] = [];
    doTrimEdgeLoop(engine, cuttingEdges);
  });

  // === EXTEND ===
  engine.register('EXTEND', ['EX'], () => {
    const boundaries: Entity[] = [];
    doExtendEdgeLoop(engine, boundaries);
  });

  // === BREAK ===
  engine.register('BREAK', ['BR'], () => {
    engine.prompt('BREAK Select object:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const entity = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
      if (!entity) { engine.prompt('No object found'); engine.complete(); return; }
      const firstPt = pt;
      engine.prompt('Specify second break point or [First point]:');
      engine.inputHandler = (input) => {
        if (input === '') { engine.complete(); return true; }
        if (input.toLowerCase() === 'f') {
          engine.inputHandler = null;
          engine.prompt('Specify first break point:');
          engine.waitForClick((fp) => {
            engine.prompt('Specify second break point:');
            engine.waitForClick((sp) => {
              store.pushUndo('BREAK');
              breakEntity(entity, fp, sp);
              store.emit();
              engine.prompt('Broken');
              engine.complete();
            });
          });
          return true;
        }
        return false;
      };
      engine.waitForClick((secondPt) => {
        store.pushUndo('BREAK');
        breakEntity(entity, firstPt, secondPt);
        store.emit();
        engine.prompt('Broken');
        engine.complete();
      });
    });
  });

  // === FILLET ===
  engine.register('FILLET', ['F'], () => {
    let radius = 0;
    engine.prompt('FILLET Current radius = 0. Select first object or [Radius]:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      if (input.toLowerCase() === 'r') {
        engine.prompt('Specify fillet radius:');
        engine.waitForInput('Radius:', (rInput) => {
          radius = parseFloat(rInput) || 0;
          engine.prompt(`Fillet radius = ${radius}. Select first object:`);
          engine.inputHandler = null;
          doFilletSelect(engine, radius);
          return true;
        });
        return true;
      }
      return false;
    };
    doFilletSelect(engine, radius);
  });

  // === CHAMFER ===
  engine.register('CHAMFER', ['CHA'], () => {
    let d1 = 0, d2 = 0;
    let method: 'distance' | 'angle' = 'distance';
    let chamLength = 0, chamAngle = 0;

    function chamferPrompt() {
      if (method === 'distance') {
        engine.prompt(`CHAMFER (Distance) Dist1 = ${d1}, Dist2 = ${d2}. Select first line or [Distance/Angle/Method]:`);
      } else {
        engine.prompt(`CHAMFER (Angle) Length = ${chamLength}, Angle = ${chamAngle}. Select first line or [Distance/Angle/Method]:`);
      }
    }

    function chamferInputHandler(input: string): boolean {
      if (input === '') { engine.complete(); return true; }
      const lower = input.toLowerCase();
      if (lower === 'd' || lower === 'distance') {
        engine.prompt('Specify first chamfer distance:');
        engine.waitForInput('Dist1:', (i1) => {
          d1 = parseFloat(i1) || 0;
          engine.prompt('Specify second chamfer distance:');
          engine.waitForInput('Dist2:', (i2) => {
            d2 = parseFloat(i2) || d1;
            method = 'distance';
            engine.inputHandler = chamferInputHandler;
            chamferPrompt();
            doChamferSelect(engine, d1, d2);
            return true;
          });
          return true;
        });
        return true;
      }
      if (lower === 'a' || lower === 'angle') {
        engine.prompt('Specify chamfer length on the first line:');
        engine.waitForInput('Length:', (lInput) => {
          chamLength = parseFloat(lInput) || 0;
          engine.prompt('Specify chamfer angle from the first line:');
          engine.waitForInput('Angle:', (aInput) => {
            chamAngle = parseFloat(aInput) || 0;
            method = 'angle';
            d1 = chamLength;
            d2 = chamLength * Math.tan(chamAngle * Math.PI / 180);
            engine.inputHandler = chamferInputHandler;
            chamferPrompt();
            doChamferSelect(engine, d1, d2);
            return true;
          });
          return true;
        });
        return true;
      }
      if (lower === 'm' || lower === 'method') {
        engine.prompt(`Current method: ${method === 'distance' ? 'Distance' : 'Angle'}. Enter trim method [Distance/Angle] <${method === 'distance' ? 'Distance' : 'Angle'}>:`);
        engine.waitForInput('Method:', (mInput) => {
          const ml = mInput.toLowerCase();
          if (ml === 'a' || ml === 'angle') method = 'angle';
          else method = 'distance';
          engine.inputHandler = chamferInputHandler;
          chamferPrompt();
          doChamferSelect(engine, d1, d2);
          return true;
        });
        return true;
      }
      return false;
    }

    chamferPrompt();
    engine.inputHandler = chamferInputHandler;
    doChamferSelect(engine, d1, d2);
  });
}

// --- TRIM helpers ---

function doTrimEdgeLoop(engine: CommandEngine, cuttingEdges: Entity[]) {
  engine.prompt('TRIM Select cutting edges (Enter for all):');
  engine.inputHandler = (input) => {
    if (input === '') {
      const edges = cuttingEdges.length > 0 ? cuttingEdges : [...store.entities];
      doTrimSelect(engine, edges);
      return true;
    }
    return false;
  };
  engine.waitForClick((pt) => {
    const tol = 10 / store.view.zoom;
    const entity = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
    if (entity) {
      entity.selected = true;
      cuttingEdges.push(entity);
      store.emit();
      engine.prompt(`${cuttingEdges.length} edge(s) selected. Select more or Enter:`);
    }
    doTrimEdgeLoop(engine, cuttingEdges);
  });
}

function doTrimSelect(engine: CommandEngine, edges: Entity[]) {
  engine.prompt('Select object to trim or <exit>:');
  store.clearSelection();
  engine.inputHandler = (input) => {
    if (input === '') { engine.complete(); return true; }
    return false;
  };
  engine.waitForClick((pt) => {
    const tol = 10 / store.view.zoom;
    const target = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
    if (target) {
      let ok = false;
      store.pushUndo('TRIM');
      if (target.type === 'line') { trimLine(target as LineEntity, edges, pt); ok = true; }
      else if (target.type === 'arc') { ok = trimArc(target as ArcEntity, edges, pt); }
      else if (target.type === 'circle') { ok = trimCircle(target as CircleEntity, edges, pt); }
      else if (target.type === 'polyline') { ok = trimPolyline(target as PolylineEntity, edges, pt); }
      if (ok) { store.emit(); engine.prompt('Trimmed'); }
      else { store.undo(); engine.prompt('Cannot trim — no intersections found'); }
    } else {
      engine.prompt('No object found');
    }
    doTrimSelect(engine, edges);
  });
}

// --- EXTEND helpers ---

function doExtendEdgeLoop(engine: CommandEngine, boundaries: Entity[]) {
  engine.prompt('EXTEND Select boundary edges (Enter for all):');
  engine.inputHandler = (input) => {
    if (input === '') {
      const edges = boundaries.length > 0 ? boundaries : [...store.entities];
      doExtendSelect(engine, edges);
      return true;
    }
    return false;
  };
  engine.waitForClick((pt) => {
    const tol = 10 / store.view.zoom;
    const entity = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
    if (entity) {
      entity.selected = true;
      boundaries.push(entity);
      store.emit();
      engine.prompt(`${boundaries.length} edge(s) selected. Select more or Enter:`);
    }
    doExtendEdgeLoop(engine, boundaries);
  });
}

function doExtendSelect(engine: CommandEngine, boundaries: Entity[]) {
  engine.prompt('Select object to extend or <exit>:');
  store.clearSelection();
  engine.inputHandler = (input) => {
    if (input === '') { engine.complete(); return true; }
    return false;
  };
  engine.waitForClick((pt) => {
    const tol = 10 / store.view.zoom;
    const target = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
    if (target) {
      let ok = false;
      store.pushUndo('EXTEND');
      if (target.type === 'line') { extendLine(target as LineEntity, boundaries, pt); ok = true; }
      else if (target.type === 'arc') { ok = extendArc(target as ArcEntity, boundaries, pt); }
      else if (target.type === 'polyline') { ok = extendPolyline(target as PolylineEntity, boundaries, pt); }
      else if (target.type === 'circle') { engine.prompt('Cannot extend a circle'); }
      if (ok) { store.emit(); engine.prompt('Extended'); }
      else { store.undo(); engine.prompt('Cannot extend — no boundary found'); }
    } else {
      engine.prompt('No object found');
    }
    doExtendSelect(engine, boundaries);
  });
}

// --- FILLET helpers ---

function doFilletSelect(engine: CommandEngine, radius: number) {
  engine.waitForClick((pt1) => {
    const tol = 10 / store.view.zoom;
    const e1 = store.entities.find(e => e.visible && pointOnEntity(pt1, e, tol));
    if (!e1 || (e1.type !== 'line' && e1.type !== 'arc' && e1.type !== 'polyline')) {
      engine.prompt('Select a line, arc, or polyline'); engine.complete(); return;
    }
    engine.prompt('Select second object:');
    engine.waitForClick((pt2) => {
      // Handle polyline self-fillet (both clicks on same polyline)
      if (e1.type === 'polyline' && pointOnEntity(pt2, e1, tol)) {
        const pline = e1 as PolylineEntity;
        const seg1 = findPolylineSegment(pline, pt1);
        const seg2 = findPolylineSegment(pline, pt2);
        if (seg1 !== seg2) {
          store.pushUndo('FILLET');
          if (filletPolylineCorner(pline, seg1, seg2, radius)) {
            store.emit();
            engine.prompt(radius === 0 ? 'Corner cleaned' : `Fillet radius = ${radius}`);
          } else {
            store.undo();
            engine.prompt('Cannot fillet - segments not adjacent or radius too large');
          }
          engine.complete();
          return;
        }
      }

      // If e1 is a polyline but we didn't handle it above, polyline+other is not supported
      if (e1.type === 'polyline') {
        engine.prompt('Select two adjacent segments of the same polyline'); engine.complete(); return;
      }

      const e2 = store.entities.find(e => e.visible && e.id !== e1.id && pointOnEntity(pt2, e, tol));
      if (!e2 || (e2.type !== 'line' && e2.type !== 'arc')) {
        engine.prompt('Select a line or arc'); engine.complete(); return;
      }
      store.pushUndo('FILLET');
      if (e1.type === 'line' && e2.type === 'line') {
        filletLines(e1 as LineEntity, e2 as LineEntity, radius);
      } else if (e1.type === 'line' && e2.type === 'arc') {
        filletLineArc(e1 as LineEntity, e2 as ArcEntity, radius, pt1, pt2);
      } else if (e1.type === 'arc' && e2.type === 'line') {
        filletLineArc(e2 as LineEntity, e1 as ArcEntity, radius, pt2, pt1);
      } else {
        filletArcArc(e1 as ArcEntity, e2 as ArcEntity, radius, pt1, pt2);
      }
      store.emit();
      engine.prompt(radius === 0 ? 'Extended to intersection' : `Fillet radius = ${radius}`);
      engine.complete();
    });
  });
}

// --- CHAMFER helpers ---

function doChamferSelect(engine: CommandEngine, d1: number, d2: number) {
  engine.waitForClick((pt1) => {
    const tol = 10 / store.view.zoom;
    const e1 = store.entities.find(e => e.visible && pointOnEntity(pt1, e, tol));
    if (!e1 || (e1.type !== 'line' && e1.type !== 'polyline')) {
      engine.prompt('Select a line or polyline'); engine.complete(); return;
    }
    engine.prompt('Select second line:');
    engine.waitForClick((pt2) => {
      // Handle polyline self-chamfer (both clicks on same polyline)
      if (e1.type === 'polyline' && pointOnEntity(pt2, e1, tol)) {
        const pline = e1 as PolylineEntity;
        const seg1 = findPolylineSegment(pline, pt1);
        const seg2 = findPolylineSegment(pline, pt2);
        if (seg1 !== seg2) {
          store.pushUndo('CHAMFER');
          if (chamferPolylineCorner(pline, seg1, seg2, d1, d2)) {
            store.emit();
            engine.prompt('Chamfer complete');
          } else {
            store.undo();
            engine.prompt('Cannot chamfer - segments not adjacent or distances too large');
          }
          engine.complete();
          return;
        }
      }

      // If e1 is a polyline but we didn't handle it above, polyline+other is not supported
      if (e1.type === 'polyline') {
        engine.prompt('Select two adjacent segments of the same polyline'); engine.complete(); return;
      }

      const e2 = store.entities.find(e => e.visible && e.id !== e1.id && pointOnEntity(pt2, e, tol));
      if (!e2 || e2.type !== 'line') { engine.prompt('Select a line'); engine.complete(); return; }
      store.pushUndo('CHAMFER');
      chamferLines(e1 as LineEntity, e2 as LineEntity, d1, d2);
      store.emit();
      engine.prompt('Chamfer complete');
      engine.complete();
    });
  });
}

// --- Geometry operations ---

function trimLine(target: LineEntity, edges: Entity[], pickPt: Point) {
  const intersections: { t: number; pt: Point }[] = [];
  const dx = target.end.x - target.start.x, dy = target.end.y - target.start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;

  for (const edge of edges) {
    if (edge.id === target.id) continue;
    const pts = findIntersections(target, edge);
    for (const pt of pts) {
      const t = ((pt.x - target.start.x) * dx + (pt.y - target.start.y) * dy) / (len * len);
      if (t > 0.001 && t < 0.999) intersections.push({ t, pt });
    }
  }

  if (intersections.length === 0) return;
  intersections.sort((a, b) => a.t - b.t);

  const pickT = ((pickPt.x - target.start.x) * dx + (pickPt.y - target.start.y) * dy) / (len * len);

  if (intersections.length === 1) {
    if (pickT < intersections[0].t) {
      target.start = intersections[0].pt;
    } else {
      target.end = intersections[0].pt;
    }
  } else {
    let left = 0, right = 1;
    for (const ix of intersections) {
      if (ix.t < pickT) left = ix.t;
      if (ix.t > pickT && right === 1) right = ix.t;
    }
    const leftPt = intersections.find(i => Math.abs(i.t - left) < 0.001);
    const rightPt = intersections.find(i => Math.abs(i.t - right) < 0.001);
    if (left === 0 && rightPt) {
      target.start = rightPt.pt;
    } else if (right === 1 && leftPt) {
      target.end = leftPt.pt;
    } else if (leftPt && rightPt) {
      const newLine = makeEntity({
        type: 'line', start: rightPt.pt, end: { ...target.end },
      }) as LineEntity;
      target.end = leftPt.pt;
      store.addEntity(newLine);
    }
  }
}

function extendLine(target: LineEntity, boundaries: Entity[], pickPt: Point) {
  const closerToStart = dist(pickPt, target.start) < dist(pickPt, target.end);
  const dx = target.end.x - target.start.x, dy = target.end.y - target.start.y;

  let bestDist = Infinity;
  let bestPt: Point | null = null;

  for (const edge of boundaries) {
    if (edge.id === target.id) continue;
    const extStart = closerToStart
      ? { x: target.start.x - dx * 1000, y: target.start.y - dy * 1000 }
      : target.start;
    const extEnd = closerToStart
      ? target.end
      : { x: target.end.x + dx * 1000, y: target.end.y + dy * 1000 };

    const extLine: LineEntity = { ...target, start: extStart, end: extEnd };
    const pts = findIntersections(extLine, edge);
    for (const pt of pts) {
      const d = closerToStart ? dist(pt, target.start) : dist(pt, target.end);
      const t = ((pt.x - target.start.x) * dx + (pt.y - target.start.y) * dy) / (dx * dx + dy * dy);
      if ((closerToStart && t < 0 && d < bestDist) || (!closerToStart && t > 1 && d < bestDist)) {
        bestDist = d;
        bestPt = pt;
      }
    }
  }

  if (bestPt) {
    if (closerToStart) target.start = bestPt;
    else target.end = bestPt;
  }
}

function breakEntity(e: Entity, p1: Point, p2: Point) {
  if (e.type === 'line') {
    breakLine(e as LineEntity, p1, p2);
  } else if (e.type === 'circle') {
    breakCircle(e as CircleEntity, p1, p2);
  } else if (e.type === 'arc') {
    breakArc(e as ArcEntity, p1, p2);
  }
}

function breakLine(line: LineEntity, p1: Point, p2: Point) {
  const dx = line.end.x - line.start.x, dy = line.end.y - line.start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return;

  let t1 = ((p1.x - line.start.x) * dx + (p1.y - line.start.y) * dy) / len2;
  let t2 = ((p2.x - line.start.x) * dx + (p2.y - line.start.y) * dy) / len2;
  t1 = Math.max(0, Math.min(1, t1));
  t2 = Math.max(0, Math.min(1, t2));
  if (t1 > t2) [t1, t2] = [t2, t1];

  const bp1 = { x: line.start.x + t1 * dx, y: line.start.y + t1 * dy };
  const bp2 = { x: line.start.x + t2 * dx, y: line.start.y + t2 * dy };

  if (t1 > 0.001) {
    const origEnd = { ...line.end };
    line.end = bp1;
    if (t2 < 0.999) {
      store.addEntity(makeEntity({ type: 'line', start: bp2, end: origEnd } as any));
    }
  } else if (t2 < 0.999) {
    line.start = bp2;
  } else {
    store.removeEntity(line.id);
  }
}

function breakCircle(circ: CircleEntity, p1: Point, p2: Point) {
  const a1 = angle(circ.center, p1);
  const a2 = angle(circ.center, p2);
  store.removeEntity(circ.id);
  store.addEntity(makeEntity({
    type: 'arc', center: { ...circ.center }, radius: circ.radius,
    startAngle: a2, endAngle: a1,
  } as any));
}

function breakArc(arc: ArcEntity, p1: Point, p2: Point) {
  const a1 = angle(arc.center, p1);
  const a2 = angle(arc.center, p2);
  if (!angleInArc(a1, arc.startAngle, arc.endAngle) || !angleInArc(a2, arc.startAngle, arc.endAngle)) return;
  const origEnd = arc.endAngle;
  arc.endAngle = a1;
  store.addEntity(makeEntity({
    type: 'arc', center: { ...arc.center }, radius: arc.radius,
    startAngle: a2, endAngle: origEnd,
  } as any));
}

function filletLines(e1: LineEntity, e2: LineEntity, radius: number) {
  const ix = lineLineIntersectionInf(e1.start, e1.end, e2.start, e2.end);
  if (!ix) return;

  if (radius === 0) {
    trimToIntersection(e1, ix);
    trimToIntersection(e2, ix);
    return;
  }

  const a1 = angle(ix, e1.start.x !== ix.x || e1.start.y !== ix.y ? e1.start : e1.end);
  const a2 = angle(ix, e2.start.x !== ix.x || e2.start.y !== ix.y ? e2.start : e2.end);
  const bisect = (a1 + a2) / 2;
  const halfAngle = Math.abs(a2 - a1) / 2;
  const centerDist = radius / Math.sin(halfAngle);
  const center = polarPoint(ix, centerDist, bisect);

  const tp1 = closestPointOnLine(center, e1.start, e1.end);
  const tp2 = closestPointOnLine(center, e2.start, e2.end);

  trimToIntersection(e1, tp1);
  trimToIntersection(e2, tp2);

  const arcStart = angle(center, tp1);
  const arcEnd = angle(center, tp2);
  store.addEntity(makeEntity({
    type: 'arc', center, radius, startAngle: arcStart, endAngle: arcEnd,
  } as any));
}

// --- TRIM arc/circle/polyline ---

function trimArc(target: ArcEntity, edges: Entity[], pickPt: Point): boolean {
  const intersections: { ang: number; pt: Point }[] = [];
  for (const edge of edges) {
    if (edge.id === target.id) continue;
    const pts = findIntersections(target, edge);
    for (const pt of pts) {
      const a = normalizeAngle(angle(target.center, pt));
      intersections.push({ ang: a, pt });
    }
  }
  if (intersections.length === 0) return false;

  const start = normalizeAngle(target.startAngle);
  const end = normalizeAngle(target.endAngle);
  const pickAng = normalizeAngle(angle(target.center, pickPt));

  const angInSpan = (a: number) => {
    const na = normalizeAngle(a);
    if (start <= end) return na >= start && na <= end;
    return na >= start || na <= end;
  };
  const spanOffset = (a: number) => {
    const na = normalizeAngle(a);
    if (start <= end) return na - start;
    return na >= start ? na - start : na + Math.PI * 2 - start;
  };

  const valid = intersections.filter(i => angInSpan(i.ang));
  if (valid.length === 0) return false;

  valid.sort((a, b) => spanOffset(a.ang) - spanOffset(b.ang));
  const pickOff = spanOffset(pickAng);

  if (valid.length === 1) {
    if (pickOff < spanOffset(valid[0].ang)) {
      target.startAngle = valid[0].ang;
    } else {
      target.endAngle = valid[0].ang;
    }
    return true;
  }

  let leftIdx = -1, rightIdx = -1;
  for (let i = 0; i < valid.length; i++) {
    if (spanOffset(valid[i].ang) <= pickOff) leftIdx = i;
  }
  for (let i = valid.length - 1; i >= 0; i--) {
    if (spanOffset(valid[i].ang) >= pickOff) rightIdx = i;
  }

  if (leftIdx === -1 && rightIdx >= 0) {
    target.startAngle = valid[rightIdx].ang;
  } else if (rightIdx === -1 && leftIdx >= 0) {
    target.endAngle = valid[leftIdx].ang;
  } else if (leftIdx >= 0 && rightIdx >= 0 && leftIdx !== rightIdx) {
    const origEnd = target.endAngle;
    target.endAngle = valid[leftIdx].ang;
    store.addEntity(makeEntity({
      type: 'arc', center: { ...target.center }, radius: target.radius,
      startAngle: valid[rightIdx].ang, endAngle: origEnd,
    } as any));
  }
  return true;
}

function trimCircle(target: CircleEntity, edges: Entity[], pickPt: Point): boolean {
  const intersections: { ang: number; pt: Point }[] = [];
  for (const edge of edges) {
    if (edge.id === target.id) continue;
    const pts = findIntersections(target, edge);
    for (const pt of pts) {
      intersections.push({ ang: normalizeAngle(angle(target.center, pt)), pt });
    }
  }
  if (intersections.length < 2) return false;

  intersections.sort((a, b) => a.ang - b.ang);
  const pickAng = normalizeAngle(angle(target.center, pickPt));

  let leftIdx = -1, rightIdx = -1;
  for (let i = 0; i < intersections.length; i++) {
    if (intersections[i].ang <= pickAng) leftIdx = i;
  }
  for (let i = 0; i < intersections.length; i++) {
    if (intersections[i].ang >= pickAng) { rightIdx = i; break; }
  }
  if (leftIdx === -1) leftIdx = intersections.length - 1;
  if (rightIdx === -1) rightIdx = 0;

  const arcStart = intersections[rightIdx].ang;
  const arcEnd = intersections[leftIdx].ang;

  store.removeEntity(target.id);
  store.addEntity(makeEntity({
    type: 'arc', center: { ...target.center }, radius: target.radius,
    startAngle: arcStart, endAngle: arcEnd,
  } as any));
  return true;
}

function trimPolyline(target: PolylineEntity, edges: Entity[], pickPt: Point): boolean {
  const pts = target.points;
  const n = target.closed ? pts.length : pts.length - 1;
  if (n < 1) return false;

  let bestSegIdx = 0, bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const cp = closestPointOnLine(pickPt, a, b);
    const d = dist(pickPt, cp);
    if (d < bestDist) { bestDist = d; bestSegIdx = i; }
  }

  const segA = pts[bestSegIdx], segB = pts[(bestSegIdx + 1) % pts.length];
  const segDx = segB.x - segA.x, segDy = segB.y - segA.y;
  const segLen2 = segDx * segDx + segDy * segDy;
  if (segLen2 < 1e-20) return false;

  const ixs: { t: number; pt: Point }[] = [];
  for (const edge of edges) {
    if (edge.id === target.id) continue;
    const fakeLine: any = { type: 'line', start: segA, end: segB, id: -1, layer: '', color: '', visible: true, selected: false, lineweight: 1, linetype: '' };
    const hits = findIntersections(fakeLine, edge);
    for (const pt of hits) {
      const t = ((pt.x - segA.x) * segDx + (pt.y - segA.y) * segDy) / segLen2;
      if (t > 0.001 && t < 0.999) ixs.push({ t, pt });
    }
  }
  if (ixs.length === 0) return false;
  ixs.sort((a, b) => a.t - b.t);

  const pickT = ((pickPt.x - segA.x) * segDx + (pickPt.y - segA.y) * segDy) / segLen2;

  if (!target.closed && bestSegIdx === 0) {
    const cutIx = ixs.find(ix => ix.t > pickT) || ixs[ixs.length - 1];
    if (pickT < cutIx.t) {
      target.points[0] = cutIx.pt;
    } else {
      target.points[0] = ixs[0].pt;
    }
    return true;
  }

  if (!target.closed && bestSegIdx === n - 1) {
    const cutIx = ixs.find(ix => ix.t < pickT) || ixs[0];
    if (pickT > cutIx.t) {
      target.points[target.points.length - 1] = cutIx.pt;
    } else {
      target.points[target.points.length - 1] = ixs[ixs.length - 1].pt;
    }
    return true;
  }

  let leftIx: typeof ixs[0] | null = null, rightIx: typeof ixs[0] | null = null;
  for (const ix of ixs) {
    if (ix.t <= pickT) leftIx = ix;
    if (ix.t >= pickT && !rightIx) rightIx = ix;
  }

  if (leftIx && rightIx && leftIx !== rightIx) {
    const newPts = pts.slice(bestSegIdx + 1);
    newPts[0] = rightIx.pt;
    const remain = pts.slice(0, bestSegIdx + 1);
    remain.push(leftIx.pt);
    target.points = remain;
    if (target.bulges) target.bulges = target.bulges.slice(0, remain.length);
    store.addEntity(makeEntity({
      type: 'polyline', points: newPts,
      bulges: newPts.map(() => 0), closed: false,
    } as any));
  } else if (leftIx) {
    target.points = [...pts.slice(0, bestSegIdx + 1), leftIx.pt];
    if (target.bulges) target.bulges = target.bulges.slice(0, target.points.length);
  } else if (rightIx) {
    target.points = [rightIx.pt, ...pts.slice(bestSegIdx + 1)];
    if (target.bulges) target.bulges = target.bulges.slice(0, target.points.length);
  }
  return true;
}

// --- EXTEND arc/polyline ---

function extendArc(target: ArcEntity, boundaries: Entity[], pickPt: Point): boolean {
  const startPt = polarPoint(target.center, target.radius, target.startAngle);
  const endPt = polarPoint(target.center, target.radius, target.endAngle);
  const closerToStart = dist(pickPt, startPt) < dist(pickPt, endPt);

  const virtualCircle: any = {
    type: 'circle', center: target.center, radius: target.radius,
    id: -1, layer: '', color: '', visible: true, selected: false, lineweight: 1, linetype: '',
  };

  let bestAngleDist = Infinity;
  let bestAngle: number | null = null;
  const extendEnd = closerToStart ? normalizeAngle(target.startAngle) : normalizeAngle(target.endAngle);

  for (const edge of boundaries) {
    if (edge.id === target.id) continue;
    const pts = findIntersections(virtualCircle, edge);
    for (const pt of pts) {
      const a = normalizeAngle(angle(target.center, pt));
      if (angleInArc(a, target.startAngle, target.endAngle)) continue;
      let aDist: number;
      if (closerToStart) {
        aDist = normalizeAngle(extendEnd - a);
      } else {
        aDist = normalizeAngle(a - extendEnd);
      }
      if (aDist > 0 && aDist < bestAngleDist) {
        bestAngleDist = aDist;
        bestAngle = a;
      }
    }
  }

  if (bestAngle === null) return false;
  if (closerToStart) target.startAngle = bestAngle;
  else target.endAngle = bestAngle;
  return true;
}

function extendPolyline(target: PolylineEntity, boundaries: Entity[], pickPt: Point): boolean {
  if (target.closed || target.points.length < 2) return false;
  const first = target.points[0], second = target.points[1];
  const last = target.points[target.points.length - 1], prev = target.points[target.points.length - 2];
  const closerToStart = dist(pickPt, first) < dist(pickPt, last);

  const p1 = closerToStart ? second : prev;
  const p2 = closerToStart ? first : last;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;

  const extEnd = { x: p2.x + dx * 1000, y: p2.y + dy * 1000 };
  const extLine: any = {
    type: 'line', start: p1, end: extEnd,
    id: -1, layer: '', color: '', visible: true, selected: false, lineweight: 1, linetype: '',
  };

  let bestDist = Infinity;
  let bestPt: Point | null = null;

  for (const edge of boundaries) {
    if (edge.id === target.id) continue;
    const pts = findIntersections(extLine, edge);
    for (const pt of pts) {
      const t = ((pt.x - p1.x) * dx + (pt.y - p1.y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        const d = dist(pt, p2);
        if (d < bestDist) { bestDist = d; bestPt = pt; }
      }
    }
  }

  if (!bestPt) return false;
  if (closerToStart) target.points[0] = bestPt;
  else target.points[target.points.length - 1] = bestPt;
  return true;
}

// --- FILLET line+arc, arc+arc ---

function filletLineArc(line: LineEntity, arc: ArcEntity, radius: number, linePick: Point, arcPick: Point) {
  if (radius === 0) {
    const hits = lineCircleIntersectionsInf(line.start, line.end, arc.center, arc.radius);
    if (hits.length === 0) return;
    const best = hits.reduce((a, b) => dist(a, linePick) + dist(a, arcPick) < dist(b, linePick) + dist(b, arcPick) ? a : b);
    const a = normalizeAngle(angle(arc.center, best));
    if (angleInArc(a, arc.startAngle, arc.endAngle)) {
      const startPt = polarPoint(arc.center, arc.radius, arc.startAngle);
      const endPt = polarPoint(arc.center, arc.radius, arc.endAngle);
      if (dist(arcPick, startPt) < dist(arcPick, endPt)) arc.startAngle = angle(arc.center, best);
      else arc.endAngle = angle(arc.center, best);
    } else {
      const startPt = polarPoint(arc.center, arc.radius, arc.startAngle);
      const endPt = polarPoint(arc.center, arc.radius, arc.endAngle);
      if (dist(best, startPt) < dist(best, endPt)) arc.startAngle = angle(arc.center, best);
      else arc.endAngle = angle(arc.center, best);
    }
    trimToIntersection(line, best);
    return;
  }

  const ldx = line.end.x - line.start.x, ldy = line.end.y - line.start.y;
  const llen = Math.hypot(ldx, ldy);
  if (llen < 1e-10) return;
  const nx = -ldy / llen, ny = ldx / llen;

  const lineMid = { x: (line.start.x + line.end.x) / 2, y: (line.start.y + line.end.y) / 2 };
  const toArcCenter = (arc.center.x - lineMid.x) * nx + (arc.center.y - lineMid.y) * ny;
  const lineSign = toArcCenter > 0 ? 1 : -1;

  const offLine1 = { x: line.start.x + nx * radius * lineSign, y: line.start.y + ny * radius * lineSign };
  const offLine2 = { x: line.end.x + nx * radius * lineSign, y: line.end.y + ny * radius * lineSign };

  const distToLine = Math.abs((arc.center.x - line.start.x) * nx + (arc.center.y - line.start.y) * ny);
  const arcSign = distToLine > arc.radius ? -1 : 1;
  const offR = arc.radius + radius * arcSign;

  const hits = lineCircleIntersectionsInf(offLine1, offLine2, arc.center, Math.abs(offR));
  if (hits.length === 0) return;

  const center = hits.reduce((a, b) => dist(a, linePick) < dist(b, linePick) ? a : b);

  const t1 = closestPointOnLine(center, line.start, line.end);
  const t2Ang = angle(arc.center, center);
  const t2 = polarPoint(arc.center, arc.radius, t2Ang);

  trimToIntersection(line, t1);

  const startPt = polarPoint(arc.center, arc.radius, arc.startAngle);
  const endPt = polarPoint(arc.center, arc.radius, arc.endAngle);
  if (dist(arcPick, startPt) < dist(arcPick, endPt)) arc.startAngle = t2Ang;
  else arc.endAngle = t2Ang;

  const arcStart = angle(center, t1);
  const arcEnd = angle(center, t2);
  store.addEntity(makeEntity({
    type: 'arc', center, radius, startAngle: arcStart, endAngle: arcEnd,
  } as any));
}

function filletArcArc(arc1: ArcEntity, arc2: ArcEntity, radius: number, pick1: Point, pick2: Point) {
  if (radius === 0) {
    const hits = circleCircleIntersections(arc1.center, arc1.radius, arc2.center, arc2.radius);
    if (hits.length === 0) return;
    const best = hits.reduce((a, b) => dist(a, pick1) + dist(a, pick2) < dist(b, pick1) + dist(b, pick2) ? a : b);
    const a1 = angle(arc1.center, best);
    const a2 = angle(arc2.center, best);
    const s1 = polarPoint(arc1.center, arc1.radius, arc1.startAngle);
    const e1 = polarPoint(arc1.center, arc1.radius, arc1.endAngle);
    if (dist(pick1, s1) < dist(pick1, e1)) arc1.startAngle = a1; else arc1.endAngle = a1;
    const s2 = polarPoint(arc2.center, arc2.radius, arc2.startAngle);
    const e2 = polarPoint(arc2.center, arc2.radius, arc2.endAngle);
    if (dist(pick2, s2) < dist(pick2, e2)) arc2.startAngle = a2; else arc2.endAngle = a2;
    return;
  }

  const d = dist(arc1.center, arc2.center);
  const candidates: Point[] = [];
  for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      const r1 = arc1.radius + radius * s1;
      const r2 = arc2.radius + radius * s2;
      if (r1 <= 0 || r2 <= 0) continue;
      const pts = circleCircleIntersections(arc1.center, r1, arc2.center, r2);
      candidates.push(...pts);
    }
  }
  if (candidates.length === 0) return;

  const center = candidates.reduce((a, b) =>
    dist(a, pick1) + dist(a, pick2) < dist(b, pick1) + dist(b, pick2) ? a : b
  );

  const t1Ang = angle(arc1.center, center);
  const t1 = polarPoint(arc1.center, arc1.radius, t1Ang);
  const t2Ang = angle(arc2.center, center);
  const t2 = polarPoint(arc2.center, arc2.radius, t2Ang);

  const s1 = polarPoint(arc1.center, arc1.radius, arc1.startAngle);
  const e1 = polarPoint(arc1.center, arc1.radius, arc1.endAngle);
  if (dist(pick1, s1) < dist(pick1, e1)) arc1.startAngle = t1Ang; else arc1.endAngle = t1Ang;

  const s2 = polarPoint(arc2.center, arc2.radius, arc2.startAngle);
  const e2 = polarPoint(arc2.center, arc2.radius, arc2.endAngle);
  if (dist(pick2, s2) < dist(pick2, e2)) arc2.startAngle = t2Ang; else arc2.endAngle = t2Ang;

  const arcStart = angle(center, t1);
  const arcEnd = angle(center, t2);
  store.addEntity(makeEntity({
    type: 'arc', center, radius, startAngle: arcStart, endAngle: arcEnd,
  } as any));
}

function chamferLines(e1: LineEntity, e2: LineEntity, d1: number, d2: number) {
  if (d1 === 0 && d2 === 0) {
    const ix = lineLineIntersectionInf(e1.start, e1.end, e2.start, e2.end);
    if (ix) { trimToIntersection(e1, ix); trimToIntersection(e2, ix); }
    return;
  }

  const ix = lineLineIntersectionInf(e1.start, e1.end, e2.start, e2.end);
  if (!ix) return;

  const dir1 = dist(e1.start, ix) > dist(e1.end, ix) ? e1.start : e1.end;
  const dir2 = dist(e2.start, ix) > dist(e2.end, ix) ? e2.start : e2.end;
  const a1 = angle(ix, dir1), a2 = angle(ix, dir2);

  const cp1 = polarPoint(ix, d1, a1);
  const cp2 = polarPoint(ix, d2, a2);

  trimToIntersection(e1, cp1);
  trimToIntersection(e2, cp2);

  store.addEntity(makeEntity({ type: 'line', start: cp1, end: cp2 } as any));
}

function findPolylineSegment(pline: PolylineEntity, pt: Point): number {
  const pts = pline.points;
  const n = pline.closed ? pts.length : pts.length - 1;
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const cp = closestPointOnLine(pt, a, b);
    const d = dist(pt, cp);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

function filletPolylineCorner(pline: PolylineEntity, seg1: number, seg2: number, radius: number): boolean {
  const nPts = pline.points.length;
  const nSegs = pline.closed ? nPts : nPts - 1;

  if (seg1 === seg2 || nPts < 3) return false;

  const sA = Math.min(seg1, seg2);
  const sB = Math.max(seg1, seg2);

  let vertexIdx: number;
  if (sB === sA + 1) {
    vertexIdx = sB;
  } else if (pline.closed && sA === 0 && sB === nSegs - 1) {
    vertexIdx = 0;
  } else {
    return false;
  }

  let prevIdx: number, nextIdx: number;
  if (pline.closed) {
    prevIdx = (vertexIdx - 1 + nPts) % nPts;
    nextIdx = (vertexIdx + 1) % nPts;
  } else {
    if (vertexIdx <= 0 || vertexIdx >= nPts - 1) return false;
    prevIdx = vertexIdx - 1;
    nextIdx = vertexIdx + 1;
  }

  const P = pline.points[prevIdx];
  const V = pline.points[vertexIdx];
  const N = pline.points[nextIdx];

  if (radius === 0) return true;

  const prevSegBulgeIdx = pline.closed && vertexIdx === 0 ? nPts - 1 : vertexIdx - 1;
  if (pline.bulges && (Math.abs(pline.bulges[prevSegBulgeIdx] || 0) > 1e-10 ||
      Math.abs(pline.bulges[vertexIdx] || 0) > 1e-10)) {
    return false;
  }

  const a1 = angle(V, P);
  const a2 = angle(V, N);

  let angleDiff = a2 - a1;
  while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
  while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

  const absHalf = Math.abs(angleDiff) / 2;
  if (Math.sin(absHalf) < 1e-10) return false;

  const tanDist = radius / Math.tan(absHalf);
  const lenPV = dist(P, V);
  const lenVN = dist(V, N);
  if (tanDist > lenPV - 1e-6 || tanDist > lenVN - 1e-6) return false;

  const T1: Point = { x: V.x + tanDist * Math.cos(a1), y: V.y + tanDist * Math.sin(a1) };
  const T2: Point = { x: V.x + tanDist * Math.cos(a2), y: V.y + tanDist * Math.sin(a2) };

  const bisectAngle = a1 + angleDiff / 2;
  const centerDist = radius / Math.sin(absHalf);
  const center: Point = { x: V.x + centerDist * Math.cos(bisectAngle), y: V.y + centerDist * Math.sin(bisectAngle) };

  const arcStartA = angle(center, T1);
  const arcEndA = angle(center, T2);
  let theta = Math.abs(arcEndA - arcStartA);
  if (theta > Math.PI) theta = 2 * Math.PI - theta;

  const cross = (T2.x - T1.x) * (center.y - T1.y) - (T2.y - T1.y) * (center.x - T1.x);
  const bulgeVal = Math.tan(theta / 4) * (cross > 0 ? 1 : -1);

  pline.points.splice(vertexIdx, 1, { ...T1 }, { ...T2 });
  if (!pline.bulges) pline.bulges = new Array(pline.points.length).fill(0);
  pline.bulges.splice(vertexIdx, 0, bulgeVal);

  return true;
}

function chamferPolylineCorner(pline: PolylineEntity, seg1: number, seg2: number, d1: number, d2: number): boolean {
  const nPts = pline.points.length;
  const nSegs = pline.closed ? nPts : nPts - 1;

  if (seg1 === seg2 || nPts < 3) return false;

  const sA = Math.min(seg1, seg2);
  const sB = Math.max(seg1, seg2);

  let vertexIdx: number;
  if (sB === sA + 1) {
    vertexIdx = sB;
  } else if (pline.closed && sA === 0 && sB === nSegs - 1) {
    vertexIdx = 0;
  } else {
    return false;
  }

  let prevIdx: number, nextIdx: number;
  if (pline.closed) {
    prevIdx = (vertexIdx - 1 + nPts) % nPts;
    nextIdx = (vertexIdx + 1) % nPts;
  } else {
    if (vertexIdx <= 0 || vertexIdx >= nPts - 1) return false;
    prevIdx = vertexIdx - 1;
    nextIdx = vertexIdx + 1;
  }

  const P = pline.points[prevIdx];
  const V = pline.points[vertexIdx];
  const N = pline.points[nextIdx];

  if (d1 === 0 && d2 === 0) return true;

  const prevSegBulgeIdx = pline.closed && vertexIdx === 0 ? nPts - 1 : vertexIdx - 1;
  if (pline.bulges && (Math.abs(pline.bulges[prevSegBulgeIdx] || 0) > 1e-10 ||
      Math.abs(pline.bulges[vertexIdx] || 0) > 1e-10)) {
    return false;
  }

  let prevSeg: number, nextSeg: number;
  if (sB === sA + 1) {
    prevSeg = sA; nextSeg = sB;
  } else {
    prevSeg = sB; nextSeg = sA;
  }

  let dBefore: number, dAfter: number;
  if (seg1 === prevSeg) {
    dBefore = d1; dAfter = d2;
  } else {
    dBefore = d2; dAfter = d1;
  }

  const a1 = angle(V, P);
  const a2 = angle(V, N);

  const lenPV = dist(P, V);
  const lenVN = dist(V, N);
  if (dBefore > lenPV - 1e-6 || dAfter > lenVN - 1e-6) return false;

  const CP1: Point = { x: V.x + dBefore * Math.cos(a1), y: V.y + dBefore * Math.sin(a1) };
  const CP2: Point = { x: V.x + dAfter * Math.cos(a2), y: V.y + dAfter * Math.sin(a2) };

  pline.points.splice(vertexIdx, 1, { ...CP1 }, { ...CP2 });
  if (!pline.bulges) pline.bulges = new Array(pline.points.length).fill(0);
  pline.bulges.splice(vertexIdx, 0, 0);

  return true;
}
