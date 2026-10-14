import { Point, Entity, LineEntity, CircleEntity, ArcEntity, PolylineEntity } from '../types';
import { store, nextId } from '../store';
import { dist, angle, polarPoint, midpoint, pointOnEntity, closestPointOnLine, lineCircleIntersectionsInf, circleCircleIntersections } from '../geometry';
import { CommandEngine } from './engine';
import { makeEntity, threePointArc } from './helpers';

export function catmullRomSpline(pts: Point[], segments: number): Point[] {
  if (pts.length < 2) return [...pts];
  const result: Point[] = [];
  const extended = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < extended.length - 2; i++) {
    const p0 = extended[i - 1], p1 = extended[i], p2 = extended[i + 1], p3 = extended[i + 2];
    for (let s = 0; s <= segments; s++) {
      if (i > 1 && s === 0) continue;
      const t = s / segments;
      const t2 = t * t, t3 = t2 * t;
      result.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return result;
}

function polygonPoints(center: Point, radius: number, sides: number, circumscribed: boolean): Point[] {
  const r = circumscribed ? radius / Math.cos(Math.PI / sides) : radius;
  const pts: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (Math.PI / 2) + (2 * Math.PI * i) / sides;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

function createPolygon(engine: CommandEngine, center: Point, radius: number, sides: number, circumscribed: boolean) {
  const pts = polygonPoints(center, radius, sides, circumscribed);
  store.pushUndo('POLYGON');
  store.addEntity(makeEntity({
    type: 'polyline', points: pts, bulges: pts.map(() => 0), closed: true,
  } as any));
  engine.renderer.rubberPolyline = null;
  engine.prompt(`${sides}-sided polygon created`);
  engine.complete();
}

function nextLinePoint(engine: CommandEngine) {
  const canClose = engine.tempPoints.length >= 3;
  engine.prompt(`Specify next point or [${canClose ? 'Close/' : ''}Undo]:`);
  engine.onMove((p) => {
    engine.renderer.rubberBand = { start: engine.tempPoints[engine.tempPoints.length - 1], end: p };
  });
  engine.inputHandler = (input: string) => {
    const lower = input.toLowerCase();
    if (input === '') {
      engine.renderer.rubberBand = null;
      engine.complete();
      return true;
    }
    if (lower === 'u' || lower === 'undo') {
      if (engine.tempEntities.length > 0) {
        const last = engine.tempEntities.pop()!;
        store.removeEntity(last.id);
        engine.tempPoints.pop();
        engine.prompt('Last point undone');
      }
      return true;
    }
    if ((lower === 'c' || lower === 'close') && engine.tempPoints.length >= 3) {
      const first = engine.tempPoints[0];
      const last = engine.tempPoints[engine.tempPoints.length - 1];
      const ent = makeEntity({ type: 'line', start: last, end: first } as any);
      store.addEntity(ent);
      engine.renderer.rubberBand = null;
      engine.prompt('LINE closed');
      engine.complete();
      return true;
    }
    const pt = engine.parseCoordinate(input);
    if (pt) { engine.handleClick(pt); return true; }
    return false;
  };
  engine.waitForClick((p2) => {
    const p1 = engine.tempPoints[engine.tempPoints.length - 1];
    const ent = makeEntity({ type: 'line', start: p1, end: p2 } as any);
    store.addEntity(ent);
    engine.tempEntities.push(ent);
    engine.tempPoints.push(p2);
    engine.renderer.rubberBand = null;
    nextLinePoint(engine);
  });
  engine.onCancel(() => { engine.renderer.rubberBand = null; });
}

function circleRadius(engine: CommandEngine, center: Point, isDiameter: boolean) {
  engine.prompt(`Specify ${isDiameter ? 'diameter' : 'radius'} or [${isDiameter ? 'Radius' : 'Diameter'}]:`);
  engine.onMove((p) => {
    const r = dist(center, p);
    engine.renderer.rubberCircle = { center, radius: r };
  });
  engine.inputHandler = (input: string) => {
    const lower = input.toLowerCase();
    if (lower === 'd' || lower === 'diameter') {
      circleRadius(engine, center, true);
      return true;
    }
    if (lower === 'r' || lower === 'radius') {
      circleRadius(engine, center, false);
      return true;
    }
    const val = parseFloat(input);
    if (!isNaN(val) && val > 0) {
      const radius = isDiameter ? val / 2 : val;
      store.pushUndo('CIRCLE');
      store.addEntity(makeEntity({ type: 'circle', center, radius } as any));
      engine.renderer.rubberCircle = null;
      engine.prompt(`Circle created, radius = ${radius.toFixed(4)}`);
      engine.complete();
      return true;
    }
    return false;
  };
  engine.waitForClick((p2) => {
    const d = dist(center, p2);
    const radius = isDiameter ? d / 2 : d;
    store.pushUndo('CIRCLE');
    store.addEntity(makeEntity({ type: 'circle', center, radius } as any));
    engine.renderer.rubberCircle = null;
    engine.prompt(`Circle created, radius = ${radius.toFixed(4)}`);
    engine.complete();
  });
}

function nextPlinePoint(engine: CommandEngine, pts: Point[], bulges: number[], mode: 'line' | 'arc', width: number = 0) {
  const canClose = pts.length >= 3;
  if (mode === 'arc') {
    engine.prompt(`Specify next point or [Angle/CEnter/Radius/Line/${canClose ? 'Close/' : ''}Halfwidth/Length/Width/Undo]:`);
  } else {
    engine.prompt(`Specify next point or [Arc/${canClose ? 'Close/' : ''}Halfwidth/Length/Width/Undo]:`);
  }
  engine.onMove(() => {});
  engine.waitForClick((p) => {
    bulges[pts.length - 1] = mode === 'arc' ? 1 : 0;
    pts.push(p);
    bulges.push(0);
    engine.renderer.rubberPolyline = [...pts];
    nextPlinePoint(engine, pts, bulges, mode, width);
  });
  engine.inputHandler = (input: string) => {
    const lower = input.toLowerCase();
    if (lower === '') {
      if (pts.length >= 2) {
        store.pushUndo('PLINE');
        const ent: any = { type: 'polyline', points: [...pts], bulges: [...bulges], closed: false };
        if (width > 0) ent.lineweight = width;
        store.addEntity(makeEntity(ent));
        engine.prompt('Polyline created');
      } else {
        engine.prompt('Need at least 2 points');
      }
      engine.renderer.rubberPolyline = null;
      engine.complete();
      return true;
    }
    if (mode === 'line' && (lower === 'a' || lower === 'arc')) {
      nextPlinePoint(engine, pts, bulges, 'arc', width);
      return true;
    }
    if (mode === 'arc' && (lower === 'a' || lower === 'angle')) {
      engine.prompt('Specify included angle:');
      engine.waitForInput('Angle:', (aInput) => {
        const angleDeg = parseFloat(aInput);
        if (isNaN(angleDeg) || angleDeg === 0) {
          engine.prompt('Invalid angle');
          nextPlinePoint(engine, pts, bulges, mode, width);
          return true;
        }
        const angleRad = angleDeg * Math.PI / 180;
        const computedBulge = Math.tan(angleRad / 4);
        engine.prompt('Specify endpoint of arc:');
        engine.onMove(() => {});
        engine.inputHandler = (input2) => {
          if (input2 === '') { nextPlinePoint(engine, pts, bulges, mode, width); return true; }
          const pt = engine.parseCoordinate(input2);
          if (pt) { engine.handleClick(pt); return true; }
          return false;
        };
        engine.waitForClick((p) => {
          bulges[pts.length - 1] = computedBulge;
          pts.push(p);
          bulges.push(0);
          engine.renderer.rubberPolyline = [...pts];
          nextPlinePoint(engine, pts, bulges, mode, width);
        });
        return true;
      });
      return true;
    }
    if (mode === 'arc' && (lower === 'r' || lower === 'radius')) {
      engine.prompt('Specify radius:');
      engine.waitForInput('Radius:', (rInput) => {
        const r = parseFloat(rInput);
        if (isNaN(r) || r === 0) {
          engine.prompt('Invalid radius');
          nextPlinePoint(engine, pts, bulges, mode, width);
          return true;
        }
        engine.prompt('Specify endpoint of arc:');
        engine.onMove(() => {});
        engine.inputHandler = (input2) => {
          if (input2 === '') { nextPlinePoint(engine, pts, bulges, mode, width); return true; }
          const pt = engine.parseCoordinate(input2);
          if (pt) { engine.handleClick(pt); return true; }
          return false;
        };
        engine.waitForClick((p) => {
          const lastPt = pts[pts.length - 1];
          const d = dist(lastPt, p);
          const absR = Math.abs(r);
          if (absR < d / 2 - 1e-10) {
            engine.prompt('Radius too small for chord length');
            nextPlinePoint(engine, pts, bulges, mode, width);
            return;
          }
          const halfAngle = Math.asin(Math.min(1, d / (2 * absR)));
          let computedBulge = Math.tan(halfAngle / 2);
          if (r < 0) computedBulge = -computedBulge;
          bulges[pts.length - 1] = computedBulge;
          pts.push(p);
          bulges.push(0);
          engine.renderer.rubberPolyline = [...pts];
          nextPlinePoint(engine, pts, bulges, mode, width);
        });
        return true;
      });
      return true;
    }
    if (mode === 'arc' && (lower === 'ce' || lower === 'center')) {
      engine.prompt('Specify center point of arc:');
      engine.onMove(() => {});
      engine.inputHandler = (input2) => {
        if (input2 === '') { nextPlinePoint(engine, pts, bulges, mode, width); return true; }
        const pt = engine.parseCoordinate(input2);
        if (pt) { engine.handleClick(pt); return true; }
        return false;
      };
      engine.waitForClick((centerPt) => {
        engine.prompt('Specify endpoint of arc:');
        engine.onMove(() => {});
        engine.inputHandler = (input2) => {
          if (input2 === '') { nextPlinePoint(engine, pts, bulges, mode, width); return true; }
          const pt = engine.parseCoordinate(input2);
          if (pt) { engine.handleClick(pt); return true; }
          return false;
        };
        engine.waitForClick((endPt) => {
          const lastPt = pts[pts.length - 1];
          const startAngle = Math.atan2(lastPt.y - centerPt.y, lastPt.x - centerPt.x);
          const endAngle = Math.atan2(endPt.y - centerPt.y, endPt.x - centerPt.x);
          let sweep = endAngle - startAngle;
          while (sweep <= 0) sweep += 2 * Math.PI;
          while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
          const computedBulge = Math.tan(sweep / 4);
          bulges[pts.length - 1] = computedBulge;
          pts.push(endPt);
          bulges.push(0);
          engine.renderer.rubberPolyline = [...pts];
          nextPlinePoint(engine, pts, bulges, mode, width);
        });
      });
      return true;
    }
    if (lower === 'l' || lower === 'line') {
      nextPlinePoint(engine, pts, bulges, 'line', width);
      return true;
    }
    if (lower === 'c' || lower === 'close') {
      if (pts.length >= 3) {
        bulges[pts.length - 1] = mode === 'arc' ? 1 : 0;
        store.pushUndo('PLINE');
        const ent: any = { type: 'polyline', points: [...pts], bulges: [...bulges], closed: true };
        if (width > 0) ent.lineweight = width;
        store.addEntity(makeEntity(ent));
        engine.prompt('Polyline closed');
      }
      engine.renderer.rubberPolyline = null;
      engine.complete();
      return true;
    }
    if (lower === 'h' || lower === 'halfwidth') {
      engine.prompt(`Current half-width: ${width / 2}. Enter starting half-width <${width / 2}>:`);
      engine.waitForInput('Starting half-width:', (hwInput) => {
        const hw = parseFloat(hwInput);
        if (!isNaN(hw) && hw >= 0) {
          width = hw * 2;
        }
        engine.prompt(`Half-width set to ${width / 2}`);
        nextPlinePoint(engine, pts, bulges, mode, width);
        return true;
      });
      return true;
    }
    if (lower === 'le' || lower === 'length') {
      engine.prompt('Specify length of line:');
      engine.waitForInput('Length:', (lInput) => {
        const len = parseFloat(lInput);
        if (isNaN(len) || len <= 0) { engine.prompt('Requires a positive number'); nextPlinePoint(engine, pts, bulges, mode, width); return true; }
        const lastPt = pts[pts.length - 1];
        let dir: number;
        if (pts.length >= 2) {
          const prev = pts[pts.length - 2];
          dir = Math.atan2(lastPt.y - prev.y, lastPt.x - prev.x);
        } else {
          dir = 0;
        }
        const newPt = { x: lastPt.x + len * Math.cos(dir), y: lastPt.y + len * Math.sin(dir) };
        bulges[pts.length - 1] = mode === 'arc' ? 1 : 0;
        pts.push(newPt);
        bulges.push(0);
        engine.renderer.rubberPolyline = [...pts];
        engine.prompt(`Line of length ${len} added`);
        nextPlinePoint(engine, pts, bulges, mode, width);
        return true;
      });
      return true;
    }
    if (lower === 'w' || lower === 'width') {
      engine.prompt(`Current width: ${width}. Enter new width <${width}>:`);
      engine.waitForInput('Width:', (wInput) => {
        width = parseFloat(wInput) || width;
        engine.prompt(`Width set to ${width}`);
        nextPlinePoint(engine, pts, bulges, mode, width);
        return true;
      });
      return true;
    }
    if (lower === 'u' || lower === 'undo') {
      if (pts.length > 1) { pts.pop(); bulges.pop(); }
      engine.renderer.rubberPolyline = [...pts];
      return true;
    }
    const pt = engine.parseCoordinate(input);
    if (pt) { engine.handleClick(pt); return true; }
    return false;
  };
  engine.onCancel(() => {
    engine.renderer.rubberPolyline = null;
    engine.prompt('*Cancel*');
  });
}

function nextSplinePoint(engine: CommandEngine, fitPts: Point[]) {
  engine.prompt('Specify next point or [Close/Undo]:');
  engine.onMove((p) => {
    const preview = catmullRomSpline([...fitPts, p], 8);
    engine.renderer.rubberPolyline = preview;
  });
  engine.inputHandler = (input) => {
    const lower = input.toLowerCase();
    if (lower === '') {
      if (fitPts.length >= 2) {
        const splinePts = catmullRomSpline(fitPts, 16);
        store.pushUndo('SPLINE');
        store.addEntity(makeEntity({
          type: 'polyline', points: splinePts,
          bulges: splinePts.map(() => 0), closed: false,
          fitPoints: fitPts.map(p => ({ ...p })),
        } as any));
        engine.prompt(`Spline created with ${fitPts.length} fit points`);
      } else {
        engine.prompt('Need at least 2 points');
      }
      engine.renderer.rubberPolyline = null;
      engine.complete();
      return true;
    }
    if (lower === 'c' || lower === 'close') {
      if (fitPts.length >= 3) {
        const closedPts = [...fitPts, fitPts[0]];
        const splinePts = catmullRomSpline(closedPts, 16);
        store.pushUndo('SPLINE');
        store.addEntity(makeEntity({
          type: 'polyline', points: splinePts,
          bulges: splinePts.map(() => 0), closed: true,
          fitPoints: fitPts.map(p => ({ ...p })),
        } as any));
        engine.prompt('Spline closed');
      }
      engine.renderer.rubberPolyline = null;
      engine.complete();
      return true;
    }
    if (lower === 'u' || lower === 'undo') {
      if (fitPts.length > 1) {
        fitPts.pop();
        const preview = catmullRomSpline(fitPts, 8);
        engine.renderer.rubberPolyline = preview;
        engine.prompt('Last point undone');
      }
      return true;
    }
    const pt = engine.parseCoordinate(input);
    if (pt) { engine.handleClick(pt); return true; }
    return false;
  };
  engine.waitForClick((p) => {
    fitPts.push(p);
    nextSplinePoint(engine, fitPts);
  });
  engine.onCancel(() => { engine.renderer.rubberPolyline = null; });
}

export function registerDrawCommands(engine: CommandEngine) {
  // LINE
  engine.register('LINE', ['L'], () => {
    store.tool = 'line';
    engine.tempPoints = [];
    engine.tempEntities = [];
    engine.prompt('LINE Specify first point:');
    engine.waitForClick((p1) => {
      engine.tempPoints = [p1];
      store.pushUndo('LINE');
      nextLinePoint(engine);
    });
  });

  // CIRCLE
  engine.register('CIRCLE', ['C'], () => {
    store.tool = 'circle';
    engine.prompt('CIRCLE Specify center point or [2P/3P/TTR]:');
    engine.inputHandler = (input: string) => {
      const lower = input.toLowerCase();
      if (lower === '2p') {
        engine.inputHandler = null;
        engine.prompt('Specify first end point of diameter:');
        engine.waitForClick((p1) => {
          engine.prompt('Specify second end point of diameter:');
          engine.onMove((p) => {
            const c = midpoint(p1, p);
            engine.renderer.rubberCircle = { center: c, radius: dist(p1, p) / 2 };
          });
          engine.waitForClick((p2) => {
            const center = midpoint(p1, p2);
            const radius = dist(p1, p2) / 2;
            store.pushUndo('CIRCLE');
            store.addEntity(makeEntity({ type: 'circle', center, radius } as any));
            engine.renderer.rubberCircle = null;
            engine.prompt(`Circle created (2P), radius = ${radius.toFixed(4)}`);
            engine.complete();
          });
        });
        return true;
      }
      if (lower === '3p') {
        engine.inputHandler = null;
        engine.prompt('Specify first point on circle:');
        engine.waitForClick((p1) => {
          engine.prompt('Specify second point on circle:');
          engine.waitForClick((p2) => {
            engine.prompt('Specify third point on circle:');
            engine.onMove((p) => {
              const arc = threePointArc(p1, p2, p);
              if (arc) engine.renderer.rubberCircle = { center: arc.center, radius: arc.radius };
            });
            engine.waitForClick((p3) => {
              const arc = threePointArc(p1, p2, p3);
              if (arc) {
                store.pushUndo('CIRCLE');
                store.addEntity(makeEntity({ type: 'circle', center: arc.center, radius: arc.radius } as any));
                engine.renderer.rubberCircle = null;
                engine.prompt(`Circle created (3P), radius = ${arc.radius.toFixed(4)}`);
              } else {
                engine.prompt('Points are collinear, no circle created');
              }
              engine.complete();
            });
          });
        });
        return true;
      }
      if (lower === 'ttr' || lower === 't') {
        engine.inputHandler = null;
        engine.prompt('Specify point on first tangent entity:');
        engine.waitForClick((click1) => {
          const ent1 = store.entities.find(e => e.visible !== false && pointOnEntity(click1, e, 15 / store.view.zoom));
          if (!ent1) {
            engine.prompt('No entity found at that point');
            engine.complete();
            return;
          }
          if (ent1.type !== 'line' && ent1.type !== 'circle' && ent1.type !== 'arc') {
            engine.prompt('Entity must be a line, circle, or arc');
            engine.complete();
            return;
          }
          engine.prompt('Specify point on second tangent entity:');
          engine.waitForClick((click2) => {
            const ent2 = store.entities.find(e => e.visible !== false && pointOnEntity(click2, e, 15 / store.view.zoom));
            if (!ent2) {
              engine.prompt('No entity found at that point');
              engine.complete();
              return;
            }
            if (ent2.type !== 'line' && ent2.type !== 'circle' && ent2.type !== 'arc') {
              engine.prompt('Entity must be a line, circle, or arc');
              engine.complete();
              return;
            }
            engine.prompt('Specify radius of circle:');
            engine.waitForInput('Radius:', (rInput) => {
              const R = parseFloat(rInput);
              if (isNaN(R) || R <= 0) {
                engine.prompt('Invalid radius');
                engine.complete();
                return true;
              }
              const candidates: Point[] = [];
              const getLineDir = (e: LineEntity): { p1: Point; p2: Point; nx: number; ny: number } => {
                const dx = e.end.x - e.start.x;
                const dy = e.end.y - e.start.y;
                const len = Math.hypot(dx, dy);
                return { p1: e.start, p2: e.end, nx: -dy / len, ny: dx / len };
              };
              const getCircleCenter = (e: CircleEntity | ArcEntity): { center: Point; radius: number } => {
                return { center: e.center, radius: e.radius };
              };

              const infLineLineIntersect = (a1: Point, a2: Point, b1: Point, b2: Point): Point | null => {
                const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
                const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
                const denom = d1x * d2y - d1y * d2x;
                if (Math.abs(denom) < 1e-10) return null;
                const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
                return { x: a1.x + t * d1x, y: a1.y + t * d1y };
              };

              const type1 = ent1.type === 'line' ? 'line' : 'circle';
              const type2 = ent2.type === 'line' ? 'line' : 'circle';

              if (type1 === 'line' && type2 === 'line') {
                const l1 = getLineDir(ent1 as LineEntity);
                const l2 = getLineDir(ent2 as LineEntity);
                for (const s1 of [-1, 1]) {
                  const off1a = { x: l1.p1.x + s1 * R * l1.nx, y: l1.p1.y + s1 * R * l1.ny };
                  const off1b = { x: l1.p2.x + s1 * R * l1.nx, y: l1.p2.y + s1 * R * l1.ny };
                  for (const s2 of [-1, 1]) {
                    const off2a = { x: l2.p1.x + s2 * R * l2.nx, y: l2.p1.y + s2 * R * l2.ny };
                    const off2b = { x: l2.p2.x + s2 * R * l2.nx, y: l2.p2.y + s2 * R * l2.ny };
                    const pt = infLineLineIntersect(off1a, off1b, off2a, off2b);
                    if (pt) candidates.push(pt);
                  }
                }
              } else if (type1 === 'line' && type2 === 'circle') {
                const l = getLineDir(ent1 as LineEntity);
                const c = getCircleCenter(ent2 as (CircleEntity | ArcEntity));
                for (const s of [-1, 1]) {
                  const offA = { x: l.p1.x + s * R * l.nx, y: l.p1.y + s * R * l.ny };
                  const offB = { x: l.p2.x + s * R * l.nx, y: l.p2.y + s * R * l.ny };
                  for (const sign of [-1, 1]) {
                    const rr = c.radius + sign * R;
                    if (rr < 0) continue;
                    const pts = lineCircleIntersectionsInf(offA, offB, c.center, rr);
                    candidates.push(...pts);
                  }
                }
              } else if (type1 === 'circle' && type2 === 'line') {
                const c = getCircleCenter(ent1 as (CircleEntity | ArcEntity));
                const l = getLineDir(ent2 as LineEntity);
                for (const s of [-1, 1]) {
                  const offA = { x: l.p1.x + s * R * l.nx, y: l.p1.y + s * R * l.ny };
                  const offB = { x: l.p2.x + s * R * l.nx, y: l.p2.y + s * R * l.ny };
                  for (const sign of [-1, 1]) {
                    const rr = c.radius + sign * R;
                    if (rr < 0) continue;
                    const pts = lineCircleIntersectionsInf(offA, offB, c.center, rr);
                    candidates.push(...pts);
                  }
                }
              } else {
                const c1 = getCircleCenter(ent1 as (CircleEntity | ArcEntity));
                const c2 = getCircleCenter(ent2 as (CircleEntity | ArcEntity));
                for (const s1 of [-1, 1]) {
                  for (const s2 of [-1, 1]) {
                    const rr1 = c1.radius + s1 * R;
                    const rr2 = c2.radius + s2 * R;
                    if (rr1 < 0 || rr2 < 0) continue;
                    const pts = circleCircleIntersections(c1.center, rr1, c2.center, rr2);
                    candidates.push(...pts);
                  }
                }
              }

              if (candidates.length === 0) {
                engine.prompt('No circle of that radius tangent to both entities');
                engine.complete();
                return true;
              }

              const mid = midpoint(click1, click2);
              let best = candidates[0];
              let bestDist = dist(mid, best);
              for (let i = 1; i < candidates.length; i++) {
                const d = dist(mid, candidates[i]);
                if (d < bestDist) { bestDist = d; best = candidates[i]; }
              }

              store.pushUndo('CIRCLE');
              store.addEntity(makeEntity({ type: 'circle', center: best, radius: R } as any));
              engine.renderer.rubberCircle = null;
              engine.prompt(`Circle created (TTR), radius = ${R.toFixed(4)}`);
              engine.complete();
              return true;
            });
          });
        });
        return true;
      }
      return false;
    };
    engine.waitForClick((center) => {
      engine.inputHandler = null;
      engine.tempPoints = [center];
      circleRadius(engine, center, false);
    });
  });

  // ARC
  engine.register('ARC', ['A'], () => {
    store.tool = 'arc';
    engine.prompt('ARC Specify start point or [Center/Continue]:');

    const doStartCenterEnd = (startPt: Point) => {
      engine.prompt('Specify center point:');
      engine.waitForClick((center) => {
        const radius = dist(center, startPt);
        const startAngle = angle(center, startPt);
        engine.prompt('Specify end point:');
        engine.onMove((p) => {
          const endAngle = angle(center, p);
          engine.renderer.rubberArc = { center, radius, startAngle, endAngle };
        });
        engine.waitForClick((endPt) => {
          const endAngle = angle(center, endPt);
          store.pushUndo('ARC');
          store.addEntity(makeEntity({ type: 'arc', center, radius, startAngle, endAngle } as any));
          engine.renderer.rubberArc = null;
          engine.prompt('Arc created (SCE)');
          engine.complete();
        });
      });
    };

    const doStartEndRadius = (startPt: Point) => {
      engine.prompt('Specify end point:');
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: startPt, end: p };
      });
      engine.waitForClick((endPt) => {
        engine.renderer.rubberBand = null;
        engine.prompt('Specify radius:');
        engine.waitForInput('Radius:', (rInput) => {
          const R = parseFloat(rInput);
          if (isNaN(R) || R === 0) { engine.prompt('Invalid radius'); engine.complete(); return true; }
          const d = dist(startPt, endPt);
          if (d > 2 * Math.abs(R)) { engine.prompt('Radius too small for the chord'); engine.complete(); return true; }
          const mx = (startPt.x + endPt.x) / 2, my = (startPt.y + endPt.y) / 2;
          const h = Math.sqrt(R * R - (d / 2) * (d / 2));
          const dx = endPt.x - startPt.x, dy = endPt.y - startPt.y;
          const center = R > 0
            ? { x: mx + h * dy / d, y: my - h * dx / d }
            : { x: mx - h * dy / d, y: my + h * dx / d };
          const radius = Math.abs(R);
          const startAngle = angle(center, startPt);
          const endAngle = angle(center, endPt);
          store.pushUndo('ARC');
          store.addEntity(makeEntity({ type: 'arc', center, radius, startAngle, endAngle } as any));
          engine.prompt('Arc created (SER)');
          engine.complete();
          return true;
        });
      });
    };

    const doContinue = () => {
      const last = [...store.entities].reverse().find(e => e.type === 'arc' || e.type === 'line');
      if (!last) { engine.prompt('No previous arc or line to continue from'); engine.complete(); return; }
      let startPt: Point;
      let tangentAngle: number;
      if (last.type === 'line') {
        const ln = last as LineEntity;
        startPt = { ...ln.end };
        tangentAngle = angle(ln.start, ln.end);
      } else {
        const ar = last as ArcEntity;
        startPt = polarPoint(ar.center, ar.radius, ar.endAngle);
        tangentAngle = ar.endAngle + Math.PI / 2;
      }
      engine.prompt(`Continue arc from (${startPt.x.toFixed(2)}, ${startPt.y.toFixed(2)}) — Specify end point:`);
      engine.onMove((p) => {
        const mid = midpoint(startPt, p);
        const chordAngle = angle(startPt, p);
        const deflection = chordAngle - tangentAngle;
        const d = dist(startPt, p);
        if (d < 1e-6) return;
        const R = d / (2 * Math.sin(deflection));
        if (!isFinite(R) || Math.abs(R) > 1e8) {
          engine.renderer.rubberBand = { start: startPt, end: p };
          engine.renderer.rubberArc = null;
        } else {
          const cx = mid.x + R * Math.cos(chordAngle + Math.PI / 2) - R * Math.cos(chordAngle) * Math.cos(deflection);
          const center = {
            x: startPt.x + Math.abs(R) * Math.cos(tangentAngle + (R > 0 ? Math.PI / 2 : -Math.PI / 2)),
            y: startPt.y + Math.abs(R) * Math.sin(tangentAngle + (R > 0 ? Math.PI / 2 : -Math.PI / 2)),
          };
          engine.renderer.rubberArc = { center, radius: Math.abs(R), startAngle: angle(center, startPt), endAngle: angle(center, p) };
          engine.renderer.rubberBand = null;
        }
      });
      engine.waitForClick((endPt) => {
        engine.renderer.rubberArc = null;
        engine.renderer.rubberBand = null;
        const arc = threePointArc(startPt, midpoint(startPt, endPt), endPt);
        const chordAngle = angle(startPt, endPt);
        const deflection = chordAngle - tangentAngle;
        const d = dist(startPt, endPt);
        if (d < 1e-6) { engine.prompt('Points are identical'); engine.complete(); return; }
        const sinD = Math.sin(deflection);
        if (Math.abs(sinD) < 1e-6) {
          store.pushUndo('ARC');
          store.addEntity(makeEntity({ type: 'line', start: startPt, end: endPt } as any));
          engine.prompt('Points are collinear with tangent — line created');
          engine.complete();
          return;
        }
        const R = d / (2 * sinD);
        const center = {
          x: startPt.x + Math.abs(R) * Math.cos(tangentAngle + (R > 0 ? Math.PI / 2 : -Math.PI / 2)),
          y: startPt.y + Math.abs(R) * Math.sin(tangentAngle + (R > 0 ? Math.PI / 2 : -Math.PI / 2)),
        };
        const radius = Math.abs(R);
        const startAngle = angle(center, startPt);
        const endAngle = angle(center, endPt);
        store.pushUndo('ARC');
        store.addEntity(makeEntity({ type: 'arc', center, radius, startAngle, endAngle } as any));
        engine.prompt('Arc created (Continue)');
        engine.complete();
      });
    };

    engine.inputHandler = (input: string) => {
      const lower = input.toLowerCase();
      if (lower === 'ce' || lower === 'center') {
        engine.inputHandler = null;
        engine.prompt('Specify center point:');
        engine.waitForClick((center) => {
          engine.prompt('Specify start point:');
          engine.waitForClick((startPt) => {
            const radius = dist(center, startPt);
            const startAngle = angle(center, startPt);
            engine.prompt('Specify end point:');
            engine.onMove((p) => {
              engine.renderer.rubberArc = { center, radius, startAngle, endAngle: angle(center, p) };
            });
            engine.waitForClick((endPt) => {
              const endAngle = angle(center, endPt);
              store.pushUndo('ARC');
              store.addEntity(makeEntity({ type: 'arc', center, radius, startAngle, endAngle } as any));
              engine.renderer.rubberArc = null;
              engine.prompt('Arc created (CSE)');
              engine.complete();
            });
          });
        });
        return true;
      }
      if (lower === 'co' || lower === 'continue') {
        engine.inputHandler = null;
        doContinue();
        return true;
      }
      return false;
    };

    engine.waitForClick((p1) => {
      engine.inputHandler = null;
      engine.tempPoints = [p1];
      engine.prompt('Specify second point or [Center/End]:');

      engine.inputHandler = (input: string) => {
        const lower = input.toLowerCase();
        if (lower === 'ce' || lower === 'center') {
          engine.inputHandler = null;
          doStartCenterEnd(p1);
          return true;
        }
        if (lower === 'e' || lower === 'end') {
          engine.inputHandler = null;
          doStartEndRadius(p1);
          return true;
        }
        return false;
      };

      engine.waitForClick((p2) => {
        engine.inputHandler = null;
        engine.tempPoints.push(p2);
        engine.prompt('Specify end point:');
        engine.onMove((p3) => {
          const arc = threePointArc(p1, p2, p3);
          if (arc) engine.renderer.rubberArc = arc;
        });
        engine.waitForClick((p3) => {
          const arc = threePointArc(p1, p2, p3);
          if (arc) {
            store.pushUndo('ARC');
            store.addEntity(makeEntity({ type: 'arc', ...arc } as any));
            engine.prompt('Arc created');
          } else {
            engine.prompt('Points are collinear, no arc created');
          }
          engine.renderer.rubberArc = null;
          engine.complete();
        });
      });
    });
  });

  // RECTANG
  engine.register('RECTANG', ['REC'], () => {
    store.tool = 'rect';
    let chamferDist = 0;
    let filletRadius = 0;

    const promptCorner1 = () => {
      engine.prompt('RECTANG Specify first corner point or [Chamfer/Fillet]:');
      engine.inputHandler = (input) => {
        const lower = input.toLowerCase();
        if (lower === 'c' || lower === 'chamfer') {
          engine.prompt('Specify chamfer distance <0>:');
          engine.waitForInput('Chamfer:', (dInput) => {
            chamferDist = parseFloat(dInput) || 0;
            filletRadius = 0;
            engine.prompt(`Chamfer distance = ${chamferDist}`);
            promptCorner1();
            return true;
          });
          return true;
        }
        if (lower === 'f' || lower === 'fillet') {
          engine.prompt('Specify fillet radius <0>:');
          engine.waitForInput('Fillet:', (rInput) => {
            filletRadius = parseFloat(rInput) || 0;
            chamferDist = 0;
            engine.prompt(`Fillet radius = ${filletRadius}`);
            promptCorner1();
            return true;
          });
          return true;
        }
        if (lower === '') { engine.complete(); return true; }
        const pt = engine.parseCoordinate(input);
        if (pt) { engine.handleClick(pt); return true; }
        return false;
      };
      engine.waitForClick((c1) => {
        engine.inputHandler = null;
        engine.tempPoints = [c1];
        engine.prompt('Specify other corner point:');
        engine.onMove((p) => {
          engine.renderer.rubberRect = { corner1: c1, corner2: p };
        });
        engine.waitForClick((c2) => {
          store.pushUndo('RECTANG');
          engine.renderer.rubberRect = null;

          if (chamferDist > 0) {
            const x1 = Math.min(c1.x, c2.x), y1 = Math.min(c1.y, c2.y);
            const x2 = Math.max(c1.x, c2.x), y2 = Math.max(c1.y, c2.y);
            const d = Math.min(chamferDist, (x2 - x1) / 2, (y2 - y1) / 2);
            const pts: Point[] = [
              { x: x1 + d, y: y1 }, { x: x2 - d, y: y1 },
              { x: x2, y: y1 + d }, { x: x2, y: y2 - d },
              { x: x2 - d, y: y2 }, { x: x1 + d, y: y2 },
              { x: x1, y: y2 - d }, { x: x1, y: y1 + d },
            ];
            store.addEntity(makeEntity({ type: 'polyline', points: pts, bulges: pts.map(() => 0), closed: true } as any));
            engine.prompt('Chamfered rectangle created');
          } else if (filletRadius > 0) {
            const x1 = Math.min(c1.x, c2.x), y1 = Math.min(c1.y, c2.y);
            const x2 = Math.max(c1.x, c2.x), y2 = Math.max(c1.y, c2.y);
            const r = Math.min(filletRadius, (x2 - x1) / 2, (y2 - y1) / 2);
            const bulge = Math.tan(Math.PI / 8);
            const pts: Point[] = [
              { x: x1 + r, y: y1 }, { x: x2 - r, y: y1 },
              { x: x2, y: y1 + r }, { x: x2, y: y2 - r },
              { x: x2 - r, y: y2 }, { x: x1 + r, y: y2 },
              { x: x1, y: y2 - r }, { x: x1, y: y1 + r },
            ];
            const bulges = [0, bulge, 0, bulge, 0, bulge, 0, bulge];
            store.addEntity(makeEntity({ type: 'polyline', points: pts, bulges, closed: true } as any));
            engine.prompt('Filleted rectangle created');
          } else {
            store.addEntity(makeEntity({ type: 'rect', corner1: c1, corner2: c2 } as any));
            engine.prompt('Rectangle created');
          }
          engine.complete();
        });
      });
    };
    promptCorner1();
  });

  // PLINE
  engine.register('PLINE', ['PL'], () => {
    store.tool = 'polyline';
    const pts: Point[] = [];
    const bulges: number[] = [];
    engine.prompt('PLINE Specify start point:');
    engine.waitForClick((p1) => {
      pts.push(p1);
      bulges.push(0);
      engine.renderer.rubberPolyline = pts;
      nextPlinePoint(engine, pts, bulges, 'line');
    });
  });

  // TEXT
  engine.register('TEXT', ['DT'], () => {
    store.tool = 'text';
    const style = store.textStyles.find(s => s.name === store.currentTextStyle) || store.textStyles[0];
    engine.prompt(`TEXT Style: "${style.name}". Specify insertion point:`);
    engine.waitForClick((pos) => {
      engine.prompt(`Specify height <${style.height}>:`);
      engine.waitForInput('Height:', (hInput) => {
        const height = parseFloat(hInput) || style.height;
        engine.prompt('Specify rotation angle <0>:');
        engine.waitForInput('Rotation:', (rInput) => {
          const rotation = parseFloat(rInput) || 0;
          engine.prompt('Enter text:');
          engine.waitForInput('Text:', (text) => {
            if (text) {
              store.pushUndo('TEXT');
              store.addEntity(makeEntity({ type: 'text', position: pos, text, height, rotation, textStyle: style.name } as any));
              engine.prompt(`Text "${text}" created`);
            }
            engine.complete();
            return true;
          });
          return true;
        });
        return true;
      });
    });
  });

  // POINT
  engine.register('POINT', ['PO'], () => {
    engine.prompt('POINT Specify a point:');
    const placePoint = () => {
      engine.waitForClick((pt) => {
        store.pushUndo('POINT');
        store.addEntity(makeEntity({ type: 'point', position: pt, pdmode: store.pdmode, pdsize: store.pdsize } as any));
        engine.prompt('Specify next point or press Enter to exit:');
        engine.inputHandler = (input) => {
          if (input === '') { engine.complete(); return true; }
          const coord = engine.parseCoordinate(input);
          if (coord) { engine.handleClick(coord); return true; }
          return false;
        };
        placePoint();
      });
    };
    placePoint();
  });

  // MTEXT
  engine.register('MTEXT', ['MT'], () => {
    store.tool = 'text';
    const style = store.textStyles.find(s => s.name === store.currentTextStyle) || store.textStyles[0];
    engine.prompt(`MTEXT Style: "${style.name}". Specify first corner:`);
    engine.waitForClick((c1) => {
      engine.prompt('Specify opposite corner:');
      engine.onMove((p) => {
        engine.renderer.rubberRect = { corner1: c1, corner2: p };
      });
      engine.waitForClick((c2) => {
        engine.renderer.rubberRect = null;
        const height = Math.abs(c2.y - c1.y) / 3 || style.height;
        engine.prompt('Enter text (use \\n for newlines):');
        engine.waitForInput('Text:', (text) => {
          if (text) {
            const content = text.replace(/\\n/g, '\n');
            store.pushUndo('MTEXT');
            store.addEntity(makeEntity({
              type: 'text',
              position: { x: Math.min(c1.x, c2.x), y: Math.max(c1.y, c2.y) },
              text: content, height, rotation: 0, textStyle: style.name,
            } as any));
            engine.prompt(`MText created`);
          }
          engine.complete();
          return true;
        });
      });
    });
  });

  // ELLIPSE
  engine.register('ELLIPSE', ['EL'], () => {
    store.tool = 'ellipse';
    engine.prompt('ELLIPSE Specify axis endpoint of ellipse or [Center]:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const lower = input.toLowerCase();
      if (lower === 'c' || lower === 'center') {
        engine.inputHandler = null;
        engine.prompt('Specify center of ellipse:');
        engine.waitForClick((center) => {
          engine.prompt('Specify endpoint of axis:');
          engine.onMove((p) => {
            engine.renderer.rubberBand = { start: center, end: p };
          });
          engine.waitForClick((axisEnd) => {
            const majorX = axisEnd.x - center.x;
            const majorY = axisEnd.y - center.y;
            engine.renderer.rubberBand = null;
            engine.prompt('Specify distance to other axis or [Rotation]:');
            engine.onMove((p) => {
              const majorLen = Math.hypot(majorX, majorY);
              if (majorLen > 0) {
                const rot = Math.atan2(majorY, majorX);
                const dx = p.x - center.x, dy = p.y - center.y;
                const localY = -dx * Math.sin(rot) + dy * Math.cos(rot);
                const ratio = Math.abs(localY) / majorLen;
                engine.renderer.rubberEllipse = { center, majorX, majorY, ratio: Math.max(0.01, Math.min(ratio, 100)) };
              }
            });
            engine.inputHandler = (input2) => {
              if (input2 === '') { engine.renderer.rubberEllipse = null; engine.complete(); return true; }
              const val = parseFloat(input2);
              if (isNaN(val) || val <= 0) { engine.prompt('Requires a positive number'); return true; }
              const majorLen = Math.hypot(majorX, majorY);
              const ratio = val / majorLen;
              store.pushUndo('ELLIPSE');
              store.addEntity(makeEntity({
                type: 'ellipse', center, majorX, majorY,
                ratio: Math.max(0.001, ratio), startParam: 0, endParam: Math.PI * 2,
              } as any));
              engine.renderer.rubberEllipse = null;
              engine.prompt('Ellipse created');
              engine.complete();
              return true;
            };
            engine.waitForClick((p2) => {
              const majorLen = Math.hypot(majorX, majorY);
              if (majorLen > 0) {
                const rot = Math.atan2(majorY, majorX);
                const dx = p2.x - center.x, dy = p2.y - center.y;
                const localY = -dx * Math.sin(rot) + dy * Math.cos(rot);
                const ratio = Math.abs(localY) / majorLen;
                store.pushUndo('ELLIPSE');
                store.addEntity(makeEntity({
                  type: 'ellipse', center, majorX, majorY,
                  ratio: Math.max(0.001, ratio), startParam: 0, endParam: Math.PI * 2,
                } as any));
              }
              engine.renderer.rubberEllipse = null;
              engine.prompt('Ellipse created');
              engine.complete();
            });
          });
        });
        return true;
      }
      const pt = engine.parseCoordinate(input);
      if (pt) { engine.handleClick(pt); return true; }
      return false;
    };
    engine.waitForClick((axisEnd1) => {
      engine.inputHandler = null;
      engine.prompt('Specify other endpoint of axis:');
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: axisEnd1, end: p };
      });
      engine.waitForClick((axisEnd2) => {
        engine.renderer.rubberBand = null;
        const center = midpoint(axisEnd1, axisEnd2);
        const majorX = axisEnd2.x - center.x;
        const majorY = axisEnd2.y - center.y;
        engine.prompt('Specify distance to other axis:');
        engine.onMove((p) => {
          const majorLen = Math.hypot(majorX, majorY);
          if (majorLen > 0) {
            const rot = Math.atan2(majorY, majorX);
            const dx = p.x - center.x, dy = p.y - center.y;
            const localY = -dx * Math.sin(rot) + dy * Math.cos(rot);
            const ratio = Math.abs(localY) / majorLen;
            engine.renderer.rubberEllipse = { center, majorX, majorY, ratio: Math.max(0.01, Math.min(ratio, 100)) };
          }
        });
        engine.inputHandler = (input2) => {
          if (input2 === '') { engine.renderer.rubberEllipse = null; engine.complete(); return true; }
          const val = parseFloat(input2);
          if (isNaN(val) || val <= 0) { engine.prompt('Requires a positive number'); return true; }
          const majorLen = Math.hypot(majorX, majorY);
          const ratio = val / majorLen;
          store.pushUndo('ELLIPSE');
          store.addEntity(makeEntity({
            type: 'ellipse', center, majorX, majorY,
            ratio: Math.max(0.001, ratio), startParam: 0, endParam: Math.PI * 2,
          } as any));
          engine.renderer.rubberEllipse = null;
          engine.prompt('Ellipse created');
          engine.complete();
          return true;
        };
        engine.waitForClick((p2) => {
          const majorLen = Math.hypot(majorX, majorY);
          if (majorLen > 0) {
            const rot = Math.atan2(majorY, majorX);
            const dx = p2.x - center.x, dy = p2.y - center.y;
            const localY = -dx * Math.sin(rot) + dy * Math.cos(rot);
            const ratio = Math.abs(localY) / majorLen;
            store.pushUndo('ELLIPSE');
            store.addEntity(makeEntity({
              type: 'ellipse', center, majorX, majorY,
              ratio: Math.max(0.001, ratio), startParam: 0, endParam: Math.PI * 2,
            } as any));
          }
          engine.renderer.rubberEllipse = null;
          engine.prompt('Ellipse created');
          engine.complete();
        });
      });
    });
    engine.onCancel(() => { engine.renderer.rubberBand = null; engine.renderer.rubberEllipse = null; });
  });

  // SPLINE
  engine.register('SPLINE', ['SPL'], () => {
    store.tool = 'spline';
    const fitPts: Point[] = [];
    engine.prompt('SPLINE Specify first point:');
    engine.waitForClick((p1) => {
      fitPts.push(p1);
      nextSplinePoint(engine, fitPts);
    });
    engine.onCancel(() => { engine.renderer.rubberPolyline = null; });
  });

  // DONUT
  engine.register('DONUT', ['DO'], () => {
    engine.prompt('DONUT Specify inside diameter <0.5>:');
    engine.waitForInput('Inside diameter:', (iInput) => {
      const parsed = parseFloat(iInput);
      const innerDia = isNaN(parsed) ? 0.5 : parsed;
      if (innerDia < 0) { engine.prompt('Diameter must be >= 0'); engine.complete(); return true; }
      engine.prompt(`Specify outside diameter <1.0>:`);
      engine.waitForInput('Outside diameter:', (oInput) => {
        const outerDia = parseFloat(oInput) || 1.0;
        if (outerDia <= 0) { engine.prompt('Outside diameter must be > 0'); engine.complete(); return true; }
        if (outerDia <= innerDia) { engine.prompt('Outside diameter must be > inside diameter'); engine.complete(); return true; }
        engine.inputHandler = null;
        engine.prompt('Specify center of donut:');
        const placeDonut = () => {
          engine.onMove((p) => {
            const r = (innerDia + outerDia) / 4;
            engine.renderer.rubberCircle = { center: p, radius: r };
          });
          engine.inputHandler = (input) => {
            if (input === '') { engine.renderer.rubberCircle = null; engine.complete(); return true; }
            return false;
          };
          engine.waitForClick((center) => {
            engine.renderer.rubberCircle = null;
            store.pushUndo('DONUT');
            const innerR = innerDia / 2;
            const outerR = outerDia / 2;
            if (innerR < 0.001) {
              store.addEntity(makeEntity({ type: 'circle', center, radius: outerR } as any));
            } else {
              const midR = (innerR + outerR) / 2;
              const bulge = (outerR - innerR) / (2 * midR);
              const pts = [
                { x: center.x + midR, y: center.y },
                { x: center.x - midR, y: center.y },
              ];
              store.addEntity(makeEntity({
                type: 'polyline', points: pts,
                bulges: [1, 1], closed: true,
                lineweight: outerR - innerR,
              } as any));
            }
            store.emit();
            engine.prompt('Donut created. Specify center or press Enter to exit:');
            placeDonut();
          });
        };
        placeDonut();
        return true;
      });
      return true;
    });
  });

  // XLINE
  engine.register('XLINE', ['XL'], () => {
    const scale = 100000;

    const createXlineAt = (pt: Point, ux: number, uy: number) => {
      store.pushUndo('XLINE');
      store.addEntity(makeEntity({
        type: 'line',
        start: { x: pt.x - ux * scale, y: pt.y - uy * scale },
        end: { x: pt.x + ux * scale, y: pt.y + uy * scale },
      } as any));
      store.emit();
    };

    const twoPointMode = () => {
      engine.waitForClick((p1) => {
        engine.prompt('Specify through point:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: p1, end: p };
        });
        engine.inputHandler = (input) => {
          if (input === '') { engine.renderer.rubberBand = null; engine.complete(); return true; }
          return false;
        };
        engine.waitForClick((p2) => {
          engine.renderer.rubberBand = null;
          const dx = p2.x - p1.x, dy = p2.y - p1.y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-10) { engine.prompt('Points are identical'); twoPointMode(); return; }
          createXlineAt(p1, dx / len, dy / len);
          engine.prompt('Construction line created. Specify point or Enter to exit:');
          twoPointMode();
        });
      });
    };

    const horMode = () => {
      engine.prompt('Specify through point (Hor):');
      engine.waitForClick((pt) => {
        createXlineAt(pt, 1, 0);
        engine.prompt('Horizontal xline created. Specify point or Enter to exit:');
        horMode();
      });
      engine.inputHandler = (input) => {
        if (input === '') { engine.complete(); return true; }
        return false;
      };
    };

    const verMode = () => {
      engine.prompt('Specify through point (Ver):');
      engine.waitForClick((pt) => {
        createXlineAt(pt, 0, 1);
        engine.prompt('Vertical xline created. Specify point or Enter to exit:');
        verMode();
      });
      engine.inputHandler = (input) => {
        if (input === '') { engine.complete(); return true; }
        return false;
      };
    };

    const angMode = () => {
      engine.prompt('Enter angle of xline (degrees):');
      engine.waitForInput('Angle:', (val) => {
        const deg = parseFloat(val);
        if (isNaN(deg)) { engine.prompt('Invalid angle'); engine.complete(); return true; }
        const rad = deg * Math.PI / 180;
        const ux = Math.cos(rad), uy = Math.sin(rad);
        engine.prompt('Specify through point:');
        engine.waitForClick((pt) => {
          createXlineAt(pt, ux, uy);
          engine.prompt('Angled xline created. Specify point or Enter to exit:');
          const morePoints = () => {
            engine.waitForClick((pt2) => {
              createXlineAt(pt2, ux, uy);
              engine.prompt('Angled xline created. Specify point or Enter to exit:');
              morePoints();
            });
            engine.inputHandler = (input) => {
              if (input === '') { engine.complete(); return true; }
              return false;
            };
          };
          morePoints();
        });
        engine.inputHandler = (input) => {
          if (input === '') { engine.complete(); return true; }
          return false;
        };
        return true;
      });
    };

    const bisectMode = () => {
      engine.prompt('Specify angle vertex point:');
      engine.waitForClick((vertex) => {
        engine.prompt('Specify angle start point:');
        engine.waitForClick((side1) => {
          engine.prompt('Specify angle end point:');
          engine.onMove((p) => {
            engine.renderer.rubberBand = { start: vertex, end: p };
          });
          engine.waitForClick((side2) => {
            engine.renderer.rubberBand = null;
            const a1 = Math.atan2(side1.y - vertex.y, side1.x - vertex.x);
            const a2 = Math.atan2(side2.y - vertex.y, side2.x - vertex.x);
            const bisect = (a1 + a2) / 2;
            const ux = Math.cos(bisect), uy = Math.sin(bisect);
            createXlineAt(vertex, ux, uy);
            engine.prompt('Bisector xline created.');
            engine.complete();
          });
        });
      });
    };

    const offsetMode = () => {
      engine.prompt('Specify offset distance:');
      engine.waitForInput('Distance:', (val) => {
        const offsetDist = parseFloat(val);
        if (isNaN(offsetDist) || offsetDist <= 0) {
          engine.prompt('Invalid distance');
          engine.complete();
          return true;
        }
        engine.prompt('Select a line to offset:');
        engine.waitForClick((pickPt) => {
          const tol = 10 / store.view.zoom;
          const lineEnt = store.entities.find(
            e => e.visible && e.type === 'line' && pointOnEntity(pickPt, e, tol)
          );
          if (!lineEnt || lineEnt.type !== 'line') {
            engine.prompt('No line found at that point');
            engine.complete();
            return;
          }
          engine.prompt('Specify side to offset:');
          engine.waitForClick((sidePt) => {
            const le = lineEnt as any;
            const dx = le.end.x - le.start.x, dy = le.end.y - le.start.y;
            const len = Math.hypot(dx, dy);
            if (len < 1e-10) { engine.prompt('Degenerate line'); engine.complete(); return; }
            const ux = dx / len, uy = dy / len;
            const nx = -uy, ny = ux;
            const mx = (le.start.x + le.end.x) / 2, my = (le.start.y + le.end.y) / 2;
            const cross = (sidePt.x - mx) * nx + (sidePt.y - my) * ny;
            const sign = cross >= 0 ? 1 : -1;
            const ox = mx + nx * offsetDist * sign;
            const oy = my + ny * offsetDist * sign;
            createXlineAt({ x: ox, y: oy }, ux, uy);
            engine.prompt('Offset xline created.');
            engine.complete();
          });
        });
        return true;
      });
    };

    engine.prompt('XLINE Specify a point or [Hor/Ver/Ang/Bisect/Offset]:');
    engine.inputHandler = (input) => {
      const lower = input.toLowerCase();
      if (lower === 'h' || lower === 'hor') { horMode(); return true; }
      if (lower === 'v' || lower === 'ver') { verMode(); return true; }
      if (lower === 'a' || lower === 'ang') { angMode(); return true; }
      if (lower === 'b' || lower === 'bisect') { bisectMode(); return true; }
      if (lower === 'o' || lower === 'offset') { offsetMode(); return true; }
      if (lower === '') { engine.complete(); return true; }
      return false;
    };
    twoPointMode();
  });

  // RAY
  engine.register('RAY', ['RA'], () => {
    engine.prompt('RAY Specify start point:');
    const placeRay = () => {
      engine.waitForClick((p1) => {
        engine.prompt('Specify through point:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: p1, end: p };
        });
        engine.inputHandler = (input) => {
          if (input === '') { engine.renderer.rubberBand = null; engine.complete(); return true; }
          return false;
        };
        engine.waitForClick((p2) => {
          engine.renderer.rubberBand = null;
          const dx = p2.x - p1.x, dy = p2.y - p1.y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-10) { engine.prompt('Points are identical'); placeRay(); return; }
          const scale = 100000;
          const ux = dx / len, uy = dy / len;
          store.pushUndo('RAY');
          store.addEntity(makeEntity({
            type: 'line',
            start: { ...p1 },
            end: { x: p1.x + ux * scale, y: p1.y + uy * scale },
          } as any));
          store.emit();
          engine.prompt('Ray created. Specify point or Enter to exit:');
          placeRay();
        });
      });
    };
    placeRay();
  });

  // POLYGON
  engine.register('POLYGON', ['POL'], () => {
    engine.prompt('POLYGON Enter number of sides <6>:');
    engine.inputHandler = (input) => {
      const sides = parseInt(input) || 6;
      if (sides < 3 || sides > 1024) { engine.prompt('Invalid number of sides'); engine.complete(); return true; }
      engine.inputHandler = null;
      engine.prompt('Specify center of polygon:');
      engine.waitForClick((center) => {
        engine.prompt('Enter an option [Inscribed in circle/Circumscribed about circle] <I>:');
        engine.inputHandler = (input2) => {
          const circumscribed = input2.toLowerCase().startsWith('c');
          engine.prompt('Specify radius of circle:');
          engine.onMove((p) => {
            const r = dist(center, p);
            const pts = polygonPoints(center, r, sides, circumscribed);
            engine.renderer.rubberPolyline = [...pts, pts[0]];
          });
          engine.inputHandler = (rInput) => {
            if (rInput === '') { engine.renderer.rubberPolyline = null; engine.complete(); return true; }
            const r = parseFloat(rInput);
            if (isNaN(r) || r <= 0) return false;
            createPolygon(engine, center, r, sides, circumscribed);
            return true;
          };
          engine.waitForClick((p) => {
            const r = dist(center, p);
            createPolygon(engine, center, r, sides, circumscribed);
          });
          return true;
        };
      });
      return true;
    };
  });

  // MLINE — Multi-line: draws parallel lines at configurable offset
  engine.register('MLINE', ['ML'], () => {
    let offset = 1;
    let justification: 'top' | 'zero' | 'bottom' = 'top';

    const promptStart = () => {
      engine.prompt(`MLINE Offset=${offset}, Justification=${justification}. Specify start point or [Justification/Scale]:`);
      engine.inputHandler = (input) => {
        const lower = input.toLowerCase();
        if (lower === 'j' || lower === 'justification') {
          engine.prompt('Enter justification type [Top/Zero/Bottom] <Top>:');
          engine.waitForInput('Justification:', (jInput) => {
            const jl = jInput.toLowerCase();
            if (jl === 'z' || jl === 'zero') justification = 'zero';
            else if (jl === 'b' || jl === 'bottom') justification = 'bottom';
            else justification = 'top';
            engine.prompt(`Justification = ${justification}`);
            promptStart();
            return true;
          });
          return true;
        }
        if (lower === 's' || lower === 'scale') {
          engine.prompt(`Enter mline scale <${offset}>:`);
          engine.waitForInput('Scale:', (sInput) => {
            const val = parseFloat(sInput);
            if (!isNaN(val) && val > 0) offset = val;
            engine.prompt(`Mline scale = ${offset}`);
            promptStart();
            return true;
          });
          return true;
        }
        if (lower === '') { engine.complete(); return true; }
        const pt = engine.parseCoordinate(input);
        if (pt) { engine.handleClick(pt); return true; }
        return false;
      };
      engine.waitForClick((p1) => {
        engine.inputHandler = null;
        const pts: Point[] = [p1];
        nextMlinePoint(pts);
      });
    };

    const nextMlinePoint = (pts: Point[]) => {
      const canClose = pts.length >= 3;
      engine.prompt(`Specify next point or [${canClose ? 'Close/' : ''}Undo]:`);
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: pts[pts.length - 1], end: p };
      });
      engine.inputHandler = (input) => {
        const lower = input.toLowerCase();
        if (lower === '') {
          engine.renderer.rubberBand = null;
          if (pts.length >= 2) {
            createMline(pts, false);
          }
          engine.complete();
          return true;
        }
        if (lower === 'u' || lower === 'undo') {
          if (pts.length > 1) pts.pop();
          engine.prompt('Last point undone');
          return true;
        }
        if ((lower === 'c' || lower === 'close') && pts.length >= 3) {
          engine.renderer.rubberBand = null;
          createMline(pts, true);
          engine.complete();
          return true;
        }
        const pt = engine.parseCoordinate(input);
        if (pt) { engine.handleClick(pt); return true; }
        return false;
      };
      engine.waitForClick((p) => {
        pts.push(p);
        engine.renderer.rubberBand = null;
        nextMlinePoint(pts);
      });
      engine.onCancel(() => { engine.renderer.rubberBand = null; });
    };

    const createMline = (pts: Point[], closed: boolean) => {
      store.pushUndo('MLINE');
      const off1: Point[] = [];
      const off2: Point[] = [];

      for (let i = 0; i < pts.length; i++) {
        let nx = 0, ny = 0;
        if (pts.length === 1) { nx = 0; ny = 1; }
        else if (i === 0 && !closed) {
          const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
          const len = Math.hypot(dx, dy) || 1;
          nx = -dy / len; ny = dx / len;
        } else if (i === pts.length - 1 && !closed) {
          const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
          const len = Math.hypot(dx, dy) || 1;
          nx = -dy / len; ny = dx / len;
        } else {
          const prev = pts[(i - 1 + pts.length) % pts.length];
          const next = pts[(i + 1) % pts.length];
          const d1x = pts[i].x - prev.x, d1y = pts[i].y - prev.y;
          const d2x = next.x - pts[i].x, d2y = next.y - pts[i].y;
          const len1 = Math.hypot(d1x, d1y) || 1, len2 = Math.hypot(d2x, d2y) || 1;
          const n1x = -d1y / len1, n1y = d1x / len1;
          const n2x = -d2y / len2, n2y = d2x / len2;
          nx = (n1x + n2x) / 2; ny = (n1y + n2y) / 2;
          const nlen = Math.hypot(nx, ny) || 1;
          nx /= nlen; ny /= nlen;
        }

        let s1: number, s2: number;
        if (justification === 'top') { s1 = 0; s2 = -offset; }
        else if (justification === 'bottom') { s1 = offset; s2 = 0; }
        else { s1 = offset / 2; s2 = -offset / 2; }

        off1.push({ x: pts[i].x + nx * s1, y: pts[i].y + ny * s1 });
        off2.push({ x: pts[i].x + nx * s2, y: pts[i].y + ny * s2 });
      }

      store.addEntity(makeEntity({
        type: 'polyline', points: off1, bulges: off1.map(() => 0), closed,
      } as any));
      store.addEntity(makeEntity({
        type: 'polyline', points: off2, bulges: off2.map(() => 0), closed,
      } as any));
      engine.prompt(`Multiline created (${pts.length} vertices, offset=${offset})`);
    };

    promptStart();
  });

  // SKETCH — Freehand polyline drawing
  engine.register('SKETCH', [], () => {
    let increment = 1;
    engine.prompt(`SKETCH Record increment <${increment}>:`);
    engine.waitForInput('Increment:', (incInput) => {
      const val = parseFloat(incInput);
      if (!isNaN(val) && val > 0) increment = val;
      engine.prompt(`Record increment = ${increment}. Click to start sketching, Enter to finish:`);

      let sketching = false;
      const pts: Point[] = [];

      engine.onMove((p) => {
        if (!sketching) return;
        if (pts.length === 0) {
          pts.push({ ...p });
        } else {
          const last = pts[pts.length - 1];
          if (dist(last, p) >= increment) {
            pts.push({ ...p });
            engine.renderer.rubberPolyline = [...pts];
          }
        }
      });

      engine.waitForClick((p) => {
        if (!sketching) {
          sketching = true;
          pts.push({ ...p });
          engine.renderer.rubberPolyline = [...pts];
          engine.prompt(`Sketching... move mouse to draw. Click or Enter to stop.`);
          engine.waitForClick(() => {
            finishSketch();
          });
        }
      });

      engine.inputHandler = (input) => {
        if (input === '' || input === '.') {
          finishSketch();
          return true;
        }
        return false;
      };

      function finishSketch() {
        engine.renderer.rubberPolyline = null;
        sketching = false;
        if (pts.length >= 2) {
          store.pushUndo('SKETCH');
          store.addEntity(makeEntity({
            type: 'polyline', points: [...pts], bulges: pts.map(() => 0), closed: false,
          } as any));
          engine.prompt(`Sketch recorded: ${pts.length} points`);
        } else {
          engine.prompt('Not enough points for sketch');
        }
        engine.complete();
      }

      engine.onCancel(() => {
        engine.renderer.rubberPolyline = null;
      });

      return true;
    });
  });

  // TRACE — Wide solid line segments
  engine.register('TRACE', [], () => {
    engine.prompt('TRACE Specify trace width <1>:');
    engine.waitForInput('Width:', (wInput) => {
      const width = parseFloat(wInput) || 1;
      if (width <= 0) { engine.prompt('Width must be positive'); engine.complete(); return true; }
      engine.prompt('Specify start point:');

      engine.waitForClick((p1) => {
        const tracePts: Point[] = [p1];
        nextTracePoint(width, tracePts);
      });

      function nextTracePoint(w: number, tracePts: Point[]) {
        engine.prompt('Specify next point or Enter to finish:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: tracePts[tracePts.length - 1], end: p };
        });
        engine.inputHandler = (input) => {
          if (input === '') {
            engine.renderer.rubberBand = null;
            engine.complete();
            return true;
          }
          const pt = engine.parseCoordinate(input);
          if (pt) { engine.handleClick(pt); return true; }
          return false;
        };
        engine.waitForClick((p2) => {
          engine.renderer.rubberBand = null;
          const p1 = tracePts[tracePts.length - 1];
          const dx = p2.x - p1.x, dy = p2.y - p1.y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-10) { nextTracePoint(w, tracePts); return; }
          const nx = -dy / len * (w / 2), ny = dx / len * (w / 2);
          const quad: Point[] = [
            { x: p1.x + nx, y: p1.y + ny },
            { x: p1.x - nx, y: p1.y - ny },
            { x: p2.x - nx, y: p2.y - ny },
            { x: p2.x + nx, y: p2.y + ny },
          ];
          store.pushUndo('TRACE');
          store.addEntity(makeEntity({
            type: 'hatch',
            boundaries: [quad],
            patternName: 'SOLID',
            patternScale: 1,
            patternAngle: 0,
          } as any));
          tracePts.push(p2);
          engine.prompt(`Trace segment created (width=${w})`);
          nextTracePoint(w, tracePts);
        });
        engine.onCancel(() => { engine.renderer.rubberBand = null; });
      }

      return true;
    });
  });

  // SOLID — 2D filled triangle/quad
  engine.register('SOLID', ['SO'], () => {
    engine.prompt('SOLID Specify first point:');
    engine.waitForClick((p1) => {
      engine.prompt('Specify second point:');
      engine.onMove((p) => { engine.renderer.rubberBand = { start: p1, end: p }; });
      engine.waitForClick((p2) => {
        engine.renderer.rubberBand = null;
        engine.prompt('Specify third point:');
        engine.onMove((p) => { engine.renderer.rubberBand = { start: p2, end: p }; });
        engine.waitForClick((p3) => {
          engine.renderer.rubberBand = null;
          engine.prompt('Specify fourth point or <Enter for triangle>:');
          engine.onMove((p) => { engine.renderer.rubberBand = { start: p3, end: p }; });
          engine.inputHandler = (input) => {
            if (input === '') {
              engine.renderer.rubberBand = null;
              store.pushUndo('SOLID');
              store.addEntity(makeEntity({
                type: 'hatch',
                boundaries: [[{ ...p1 }, { ...p2 }, { ...p3 }]],
                patternName: 'SOLID',
                patternScale: 1,
                patternAngle: 0,
              } as any));
              engine.prompt('Solid triangle created');
              engine.complete();
              return true;
            }
            const pt = engine.parseCoordinate(input);
            if (pt) { engine.handleClick(pt); return true; }
            return false;
          };
          engine.waitForClick((p4) => {
            engine.renderer.rubberBand = null;
            store.pushUndo('SOLID');
            store.addEntity(makeEntity({
              type: 'hatch',
              boundaries: [[{ ...p1 }, { ...p2 }, { ...p4 }, { ...p3 }]],
              patternName: 'SOLID',
              patternScale: 1,
              patternAngle: 0,
            } as any));
            engine.prompt('Solid quad created');
            engine.complete();
          });
          engine.onCancel(() => { engine.renderer.rubberBand = null; });
        });
      });
    });
  });

  // === REVCLOUD ===
  engine.register('REVCLOUD', ['RC'], () => {
    let arcLen = 5;
    engine.prompt(`REVCLOUD Minimum arc length: ${arcLen}  Maximum arc length: ${arcLen}`);
    engine.prompt('Specify arc length or [Arc length] <pick start point>:');
    engine.waitForInput('Arc length or start:', (input) => {
      const lower = input.toLowerCase();
      if (lower === 'a' || lower === 'arc length' || lower === 'arc') {
        engine.prompt('Specify minimum length of arc:');
        engine.waitForInput('Min arc length:', (minInput) => {
          const n = parseFloat(minInput);
          if (!isNaN(n) && n > 0) arcLen = n;
          engine.prompt(`Arc length = ${arcLen}. Pick start point of cloud:`);
          startRevcloud(engine, arcLen);
          return true;
        });
        return true;
      }
      const n = parseFloat(input);
      if (!isNaN(n) && n > 0) {
        arcLen = n;
        engine.prompt(`Arc length = ${arcLen}. Pick start point of cloud:`);
        startRevcloud(engine, arcLen);
        return true;
      }
      const coord = engine.parseCoordinate(input);
      if (coord) {
        buildRevcloud(engine, arcLen, coord);
        return true;
      }
      engine.prompt('Pick start point of cloud:');
      engine.waitForClick((start) => {
        buildRevcloud(engine, arcLen, start);
      });
      return true;
    });
  });

  // === DTEXT ===
  engine.register('DTEXT', [], () => {
    engine.prompt('DTEXT Specify start point:');
    engine.waitForClick((startPt) => {
      const style = store.textStyles.find(s => s.name === store.currentTextStyle) || store.textStyles[0];
      const defaultH = style.height || 2.5;
      engine.prompt(`Specify height <${defaultH}>:`);
      engine.waitForInput('Height:', (hInput) => {
        const h = hInput === '' ? defaultH : parseFloat(hInput);
        if (isNaN(h) || h <= 0) { engine.prompt('Invalid height'); engine.complete(); return true; }
        engine.prompt('Specify rotation angle <0>:');
        engine.waitForInput('Rotation:', (rInput) => {
          const rotDeg = rInput === '' ? 0 : parseFloat(rInput);
          if (isNaN(rotDeg)) { engine.prompt('Invalid angle'); engine.complete(); return true; }
          let curY = startPt.y;
          const promptText = () => {
            engine.prompt('Enter text (Enter on empty line to finish):');
            engine.waitForInput('Text:', (text) => {
              if (text === '') {
                engine.prompt('DTEXT complete');
                engine.complete();
                return true;
              }
              store.pushUndo('DTEXT');
              store.addEntity(makeEntity({
                type: 'text', position: { x: startPt.x, y: curY }, text, height: h, rotation: rotDeg, textStyle: store.currentTextStyle,
              } as any));
              curY -= h * 1.5;
              promptText();
              return true;
            });
          };
          promptText();
          return true;
        });
        return true;
      });
    });
  });

  // === BHATCH ===
  engine.register('BHATCH', ['BH'], () => {
    engine.prompt('BHATCH Pattern [LINE/CROSS/DOTS/ANSI31/ANSI37/SOLID] <LINE>:');
    engine.waitForInput('Pattern:', (pInput) => {
      const valid = ['LINE', 'CROSS', 'DOTS', 'ANSI31', 'ANSI37', 'SOLID'];
      const patternName = pInput === '' ? 'LINE' : pInput.toUpperCase();
      if (!valid.includes(patternName)) { engine.prompt(`Unknown pattern "${pInput}". Using LINE.`); }
      const pat = valid.includes(patternName) ? patternName : 'LINE';
      engine.prompt('Specify scale <1>:');
      engine.waitForInput('Scale:', (sInput) => {
        const scale = sInput === '' ? 1 : parseFloat(sInput);
        if (isNaN(scale) || scale <= 0) { engine.prompt('Invalid scale'); engine.complete(); return true; }
        engine.prompt('Specify angle <0>:');
        engine.waitForInput('Angle:', (aInput) => {
          const ang = aInput === '' ? 0 : parseFloat(aInput);
          if (isNaN(ang)) { engine.prompt('Invalid angle'); engine.complete(); return true; }
          engine.prompt('Select objects to define boundary:');
          engine.requireSelection((sel) => {
            const boundaryPts: Point[] = [];
            for (const e of sel) {
              if (e.type === 'polyline') {
                for (const p of e.points) boundaryPts.push({ ...p });
              } else if (e.type === 'rect') {
                const x1 = Math.min(e.corner1.x, e.corner2.x), x2 = Math.max(e.corner1.x, e.corner2.x);
                const y1 = Math.min(e.corner1.y, e.corner2.y), y2 = Math.max(e.corner1.y, e.corner2.y);
                boundaryPts.push({ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 });
              } else if (e.type === 'circle') {
                for (let i = 0; i < 36; i++) {
                  const a = (2 * Math.PI * i) / 36;
                  boundaryPts.push({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
                }
              } else if (e.type === 'arc') {
                let sa = e.startAngle * Math.PI / 180, ea = e.endAngle * Math.PI / 180;
                if (ea <= sa) ea += 2 * Math.PI;
                for (let i = 0; i <= 18; i++) {
                  const a = sa + (ea - sa) * i / 18;
                  boundaryPts.push({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
                }
              } else if (e.type === 'line') {
                boundaryPts.push({ ...e.start }, { ...e.end });
              } else if (e.type === 'ellipse') {
                const majLen = Math.sqrt(e.majorX * e.majorX + e.majorY * e.majorY);
                const minLen = majLen * e.ratio;
                const rot = Math.atan2(e.majorY, e.majorX);
                for (let i = 0; i < 36; i++) {
                  const a = (2 * Math.PI * i) / 36;
                  const lx = majLen * Math.cos(a), ly = minLen * Math.sin(a);
                  boundaryPts.push({ x: e.center.x + lx * Math.cos(rot) - ly * Math.sin(rot), y: e.center.y + lx * Math.sin(rot) + ly * Math.cos(rot) });
                }
              }
            }
            if (boundaryPts.length < 3) {
              engine.prompt('Not enough boundary points');
              engine.complete();
              return;
            }
            store.pushUndo('BHATCH');
            store.addEntity(makeEntity({
              type: 'hatch', boundaries: [boundaryPts], patternName: pat, patternScale: scale, patternAngle: ang,
            } as any));
            store.clearSelection();
            engine.prompt(`BHATCH: ${pat} pattern applied`);
            engine.complete();
          });
          return true;
        });
        return true;
      });
      return true;
    });
  });

  // === GRADIENT ===
  engine.register('GRADIENT', ['GD'], () => {
    engine.prompt('GRADIENT Type [LINEAR/RADIAL/CYLINDRICAL] <LINEAR>:');
    engine.waitForInput('Type:', (tInput) => {
      const validTypes = ['LINEAR', 'RADIAL', 'CYLINDRICAL'];
      const gradType = tInput === '' ? 'LINEAR' : tInput.toUpperCase();
      const finalType = validTypes.includes(gradType) ? gradType : 'LINEAR';
      engine.prompt('Specify first color <#ff0000>:');
      engine.waitForInput('Color 1:', (c1Input) => {
        const color1 = c1Input === '' ? '#ff0000' : c1Input.trim();
        engine.prompt('Specify second color <#0000ff>:');
        engine.waitForInput('Color 2:', (c2Input) => {
          const color2 = c2Input === '' ? '#0000ff' : c2Input.trim();
          engine.prompt('Select objects to define boundary:');
          engine.requireSelection((sel) => {
            const boundaryPts: Point[] = [];
            for (const e of sel) {
              if (e.type === 'polyline') {
                for (const p of e.points) boundaryPts.push({ ...p });
              } else if (e.type === 'rect') {
                const x1 = Math.min(e.corner1.x, e.corner2.x), x2 = Math.max(e.corner1.x, e.corner2.x);
                const y1 = Math.min(e.corner1.y, e.corner2.y), y2 = Math.max(e.corner1.y, e.corner2.y);
                boundaryPts.push({ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 });
              } else if (e.type === 'circle') {
                for (let i = 0; i < 36; i++) {
                  const a = (2 * Math.PI * i) / 36;
                  boundaryPts.push({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
                }
              } else if (e.type === 'line') {
                boundaryPts.push({ ...e.start }, { ...e.end });
              }
            }
            if (boundaryPts.length < 3) {
              engine.prompt('Not enough boundary points');
              engine.complete();
              return;
            }
            store.pushUndo('GRADIENT');
            store.addEntity(makeEntity({
              type: 'hatch',
              boundaries: [boundaryPts],
              patternName: `GRADIENT_${finalType}`,
              patternScale: 1,
              patternAngle: 0,
            } as any));
            store.clearSelection();
            engine.prompt('Gradient hatch created');
            engine.complete();
          });
          return true;
        });
        return true;
      });
      return true;
    });
  });

  // === WIPEOUT ===
  engine.register('WIPEOUT', [], () => {
    engine.prompt('WIPEOUT Specify first corner:');
    engine.waitForClick((p1) => {
      engine.prompt('Specify opposite corner:');
      engine.onMove((p) => {
        engine.renderer.rubberRect = { corner1: p1, corner2: p };
      });
      engine.waitForClick((p2) => {
        engine.renderer.rubberRect = null;
        store.pushUndo('WIPEOUT');
        const entity = makeEntity({ type: 'rect', corner1: p1, corner2: p2, color: '#000000', linetype: 'continuous' } as any);
        (entity as any).wipeout = true;
        store.addEntity(entity);
        engine.prompt('Wipeout created');
        engine.complete();
      });
    });
  });

  // === HELIX ===
  engine.register('HELIX', ['HX'], () => {
    engine.prompt('HELIX Specify center point of base:');
    engine.waitForClick((center) => {
      engine.prompt('Specify base radius <10>:');
      engine.waitForInput('Base radius:', (rInput) => {
        const baseRadius = rInput === '' ? 10 : parseFloat(rInput);
        if (isNaN(baseRadius) || baseRadius <= 0) {
          engine.prompt('Invalid radius');
          engine.complete();
          return true;
        }
        engine.prompt(`Specify top radius <${baseRadius}>:`);
        engine.waitForInput('Top radius:', (trInput) => {
          const topRadius = trInput === '' ? baseRadius : parseFloat(trInput);
          if (isNaN(topRadius) || topRadius < 0) {
            engine.prompt('Invalid radius');
            engine.complete();
            return true;
          }

          const askTurns = (turns: number) => {
            const segsPerTurn = 36;
            const totalSegs = Math.round(turns * segsPerTurn);
            const pts: Point[] = [];
            for (let i = 0; i <= totalSegs; i++) {
              const t = i / totalSegs;
              const a = t * turns * 2 * Math.PI;
              const r = baseRadius + (topRadius - baseRadius) * t;
              pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
            }
            store.pushUndo('HELIX');
            store.addEntity(makeEntity({
              type: 'polyline',
              points: pts,
              bulges: pts.map(() => 0),
              closed: false,
            } as any));
            store.emit();
            engine.prompt(`Helix created: ${turns} turns, base radius ${baseRadius}, top radius ${topRadius}`);
            engine.complete();
          };

          engine.prompt('Specify number of turns <3>:');
          engine.waitForInput('Turns:', (tInput) => {
            const turns = tInput === '' ? 3 : parseFloat(tInput);
            if (isNaN(turns) || turns <= 0) {
              engine.prompt('Invalid number of turns');
              engine.complete();
              return true;
            }
            askTurns(turns);
            return true;
          });
          return true;
        });
        return true;
      });
    });
  });

}

function startRevcloud(engine: CommandEngine, arcLen: number) {
  engine.waitForClick((start) => {
    buildRevcloud(engine, arcLen, start);
  });
}

function buildRevcloud(engine: CommandEngine, arcLen: number, start: Point) {
  const points: Point[] = [start];
  engine.prompt('Guide cursor along cloud path... press Enter or click near start to finish');

  engine.onMove((p) => {
    const last = points[points.length - 1];
    const d = dist(last, p);
    if (d >= arcLen) {
      points.push({ ...p });
    }
    if (points.length >= 3) {
      engine.renderer.rubberBand = null;
      engine.renderer.preview = (ctx: CanvasRenderingContext2D) => {
        drawRevcloudPreview(ctx, points, arcLen);
      };
    }
  });

  engine.waitForClick((p) => {
    points.push({ ...p });
    finishRevcloud(engine, points, arcLen);
  });

  engine.inputHandler = (input) => {
    if (input === '') {
      points.push({ ...start });
      finishRevcloud(engine, points, arcLen);
      return true;
    }
    return true;
  };
}

function finishRevcloud(engine: CommandEngine, points: Point[], arcLen: number) {
  engine.renderer.preview = null;
  if (points.length < 3) {
    engine.prompt('REVCLOUD needs at least 3 points');
    engine.complete();
    return;
  }

  store.pushUndo('REVCLOUD');
  const arcPoints = generateRevcloudArcs(points, arcLen);
  store.addEntity(makeEntity({
    type: 'polyline',
    points: arcPoints,
    closed: true,
  } as any));
  store.emit();
  engine.prompt(`Revision cloud created with ${points.length} guide points`);
  engine.complete();
}

function generateRevcloudArcs(guidePoints: Point[], arcLen: number): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < guidePoints.length - 1; i++) {
    const p1 = guidePoints[i];
    const p2 = guidePoints[i + 1];
    const segLen = dist(p1, p2);
    if (segLen < 0.01) continue;
    const numArcs = Math.max(1, Math.round(segLen / arcLen));
    const dx = (p2.x - p1.x) / numArcs;
    const dy = (p2.y - p1.y) / numArcs;
    const bulge = arcLen * 0.3;

    for (let j = 0; j < numArcs; j++) {
      const ax = p1.x + dx * j;
      const ay = p1.y + dy * j;
      const bx = p1.x + dx * (j + 1);
      const by = p1.y + dy * (j + 1);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const nx = -(by - ay);
      const ny = bx - ax;
      const nl = Math.hypot(nx, ny) || 1;
      const sign = (j % 2 === 0) ? 1 : -1;
      const cx = mx + sign * bulge * nx / nl;
      const cy = my + sign * bulge * ny / nl;

      if (result.length === 0) result.push({ x: ax, y: ay });
      const steps = 6;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        result.push({
          x: u * u * ax + 2 * u * t * cx + t * t * bx,
          y: u * u * ay + 2 * u * t * cy + t * t * by,
        });
      }
    }
  }
  return result;
}

function drawRevcloudPreview(ctx: CanvasRenderingContext2D, points: Point[], arcLen: number) {
  const arcPts = generateRevcloudArcs(points, arcLen);
  if (arcPts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = '#00ff00';
  ctx.setLineDash([]);
  ctx.beginPath();
  const s0 = store.worldToScreen(arcPts[0]);
  ctx.moveTo(s0.x, s0.y);
  for (let i = 1; i < arcPts.length; i++) {
    const sp = store.worldToScreen(arcPts[i]);
    ctx.lineTo(sp.x, sp.y);
  }
  ctx.stroke();
  ctx.restore();
}
