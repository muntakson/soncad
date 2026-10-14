import { Point, Entity, LineEntity, CircleEntity, ArcEntity, PolylineEntity } from '../types';
import { store, nextId } from '../store';
import { dist, angle, polarPoint, midpoint, closestPointOnLine, lineLineIntersection,
         lineCircleIntersections, circleCircleIntersections, pointOnEntity, entityBounds,
         angleInArc, normalizeAngle, rectToLines, bulgeArc } from '../geometry';

export function makeEntity(partial: Partial<Entity> & { type: Entity['type'] }): any {
  const layer = store.currentLayer();
  return {
    id: nextId(),
    layer: layer.name,
    color: store.currentColor,
    lineweight: 1,
    linetype: 'continuous',
    visible: true,
    selected: false,
    ...partial,
  };
}

export function transformPoint(p: Point, fn: (pt: Point) => Point): Point { return fn(p); }

export function moveEntity(e: Entity, dx: number, dy: number) {
  const mv = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  switch (e.type) {
    case 'line': e.start = mv(e.start); e.end = mv(e.end); break;
    case 'circle': e.center = mv(e.center); break;
    case 'arc': e.center = mv(e.center); break;
    case 'polyline': e.points = e.points.map(mv); break;
    case 'rect': e.corner1 = mv(e.corner1); e.corner2 = mv(e.corner2); break;
    case 'text': e.position = mv(e.position); break;
    case 'ellipse': e.center = mv(e.center); break;
    case 'dimension': e.p1 = mv(e.p1); e.p2 = mv(e.p2); e.textPos = mv(e.textPos); break;
    case 'point': e.position = mv(e.position); break;
    case 'hatch': e.boundaries = e.boundaries.map(b => b.map(mv)); break;
    case 'blockref': e.insertPoint = mv(e.insertPoint); break;
    case 'region': e.outerBoundary = e.outerBoundary.map(mv); e.holes = e.holes.map(h => h.map(mv)); break;
  }
}

export function rotatePoint(p: Point, center: Point, ang: number): Point {
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const dx = p.x - center.x, dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

export function rotateEntity(e: Entity, center: Point, ang: number) {
  const rot = (p: Point) => rotatePoint(p, center, ang);
  switch (e.type) {
    case 'line': e.start = rot(e.start); e.end = rot(e.end); break;
    case 'circle': e.center = rot(e.center); break;
    case 'arc': e.center = rot(e.center); e.startAngle += ang; e.endAngle += ang; break;
    case 'polyline': e.points = e.points.map(rot); break;
    case 'rect': e.corner1 = rot(e.corner1); e.corner2 = rot(e.corner2); break;
    case 'text': e.position = rot(e.position); e.rotation += ang * 180 / Math.PI; break;
    case 'ellipse': e.center = rot(e.center); break;
    case 'dimension': e.p1 = rot(e.p1); e.p2 = rot(e.p2); e.textPos = rot(e.textPos); break;
    case 'point': e.position = rot(e.position); break;
    case 'hatch': e.boundaries = e.boundaries.map(b => b.map(rot)); break;
    case 'blockref': e.insertPoint = rot(e.insertPoint); e.rotation += ang * 180 / Math.PI; break;
    case 'region': e.outerBoundary = e.outerBoundary.map(rot); e.holes = e.holes.map(h => h.map(rot)); break;
  }
}

export function scaleEntity(e: Entity, center: Point, factor: number) {
  const sc = (p: Point): Point => ({
    x: center.x + (p.x - center.x) * factor,
    y: center.y + (p.y - center.y) * factor,
  });
  switch (e.type) {
    case 'line': e.start = sc(e.start); e.end = sc(e.end); break;
    case 'circle': e.center = sc(e.center); e.radius *= factor; break;
    case 'arc': e.center = sc(e.center); e.radius *= factor; break;
    case 'polyline': e.points = e.points.map(sc); break;
    case 'rect': e.corner1 = sc(e.corner1); e.corner2 = sc(e.corner2); break;
    case 'text': e.position = sc(e.position); e.height *= factor; break;
    case 'ellipse': e.center = sc(e.center); e.majorX *= factor; e.majorY *= factor; break;
    case 'dimension': e.p1 = sc(e.p1); e.p2 = sc(e.p2); e.textPos = sc(e.textPos); break;
    case 'point': e.position = sc(e.position); break;
    case 'hatch': e.boundaries = e.boundaries.map(b => b.map(sc)); e.patternScale *= factor; break;
    case 'blockref': e.insertPoint = sc(e.insertPoint); e.scaleX *= factor; e.scaleY *= factor; break;
    case 'region': e.outerBoundary = e.outerBoundary.map(sc); e.holes = e.holes.map(h => h.map(sc)); break;
  }
}

export function mirrorPoint(p: Point, m1: Point, m2: Point): Point {
  const dx = m2.x - m1.x, dy = m2.y - m1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return p;
  const t = ((p.x - m1.x) * dx + (p.y - m1.y) * dy) / len2;
  const closestX = m1.x + t * dx, closestY = m1.y + t * dy;
  return { x: 2 * closestX - p.x, y: 2 * closestY - p.y };
}

export function mirrorEntity(e: Entity, m1: Point, m2: Point) {
  const mir = (p: Point) => mirrorPoint(p, m1, m2);
  switch (e.type) {
    case 'line': e.start = mir(e.start); e.end = mir(e.end); break;
    case 'circle': e.center = mir(e.center); break;
    case 'arc': {
      e.center = mir(e.center);
      const mirAngle = Math.atan2(m2.y - m1.y, m2.x - m1.x);
      const newStart = 2 * mirAngle - e.endAngle;
      const newEnd = 2 * mirAngle - e.startAngle;
      e.startAngle = newStart; e.endAngle = newEnd;
      break;
    }
    case 'polyline': e.points = e.points.map(mir); break;
    case 'rect': e.corner1 = mir(e.corner1); e.corner2 = mir(e.corner2); break;
    case 'text': e.position = mir(e.position); break;
    case 'ellipse': e.center = mir(e.center); break;
    case 'dimension': e.p1 = mir(e.p1); e.p2 = mir(e.p2); e.textPos = mir(e.textPos); break;
    case 'point': e.position = mir(e.position); break;
    case 'hatch': e.boundaries = e.boundaries.map(b => b.map(mir)); break;
    case 'blockref': e.insertPoint = mir(e.insertPoint); break;
    case 'region': e.outerBoundary = e.outerBoundary.map(mir); e.holes = e.holes.map(h => h.map(mir)); break;
  }
}

export function offsetEntity(e: Entity, distance: number, side: Point): Entity | null {
  switch (e.type) {
    case 'line': {
      const dx = e.end.x - e.start.x, dy = e.end.y - e.start.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) return null;
      const nx = -dy / len, ny = dx / len;
      const mid = midpoint(e.start, e.end);
      const sign = (side.x - mid.x) * nx + (side.y - mid.y) * ny > 0 ? 1 : -1;
      const off = sign * distance;
      return makeEntity({
        type: 'line',
        start: { x: e.start.x + nx * off, y: e.start.y + ny * off },
        end: { x: e.end.x + nx * off, y: e.end.y + ny * off },
      } as any);
    }
    case 'circle': {
      const sign = dist(side, e.center) > e.radius ? 1 : -1;
      return makeEntity({ type: 'circle', center: { ...e.center }, radius: e.radius + sign * distance } as any);
    }
    case 'arc': {
      const sign = dist(side, e.center) > e.radius ? 1 : -1;
      return makeEntity({
        type: 'arc', center: { ...e.center }, radius: e.radius + sign * distance,
        startAngle: e.startAngle, endAngle: e.endAngle,
      } as any);
    }
    case 'rect': {
      const minX = Math.min(e.corner1.x, e.corner2.x);
      const maxX = Math.max(e.corner1.x, e.corner2.x);
      const minY = Math.min(e.corner1.y, e.corner2.y);
      const maxY = Math.max(e.corner1.y, e.corner2.y);
      const inside = side.x > minX && side.x < maxX && side.y > minY && side.y < maxY;
      const sign = inside ? -1 : 1;
      const newMinX = minX - sign * distance;
      const newMaxX = maxX + sign * distance;
      const newMinY = minY - sign * distance;
      const newMaxY = maxY + sign * distance;
      if (newMaxX <= newMinX || newMaxY <= newMinY) return null;
      return makeEntity({
        type: 'rect',
        corner1: { x: newMinX, y: newMinY },
        corner2: { x: newMaxX, y: newMaxY },
      } as any);
    }
    case 'ellipse': {
      const sign = dist(side, e.center) > Math.hypot(e.majorX, e.majorY) ? 1 : -1;
      const majorLen = Math.hypot(e.majorX, e.majorY);
      const newMajorLen = majorLen + sign * distance;
      if (newMajorLen <= 0) return null;
      const scale = newMajorLen / majorLen;
      return makeEntity({
        type: 'ellipse',
        center: { ...e.center },
        majorX: e.majorX * scale,
        majorY: e.majorY * scale,
        ratio: e.ratio,
        startParam: e.startParam,
        endParam: e.endParam,
      } as any);
    }
    case 'polyline': {
      const pts = e.points;
      const bulgesArr = e.bulges || pts.map(() => 0);
      const n = pts.length;
      if (n < 2) return null;
      const offsetPts: Point[] = [];
      const offsetBulges: number[] = [];
      for (let i = 0; i < n - (e.closed ? 0 : 1); i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const bulge = bulgesArr[i] || 0;
        if (Math.abs(bulge) > 1e-10) {
          const arc = bulgeArc(a, b, bulge);
          const sideDistToCenter = dist(side, arc.center);
          const outward = sideDistToCenter > arc.radius ? 1 : -1;
          const newRadius = arc.radius + outward * distance;
          if (newRadius <= 1e-10) continue;
          const newStart = polarPoint(arc.center, newRadius, arc.startAngle);
          const newEnd = polarPoint(arc.center, newRadius, arc.endAngle);
          offsetPts.push(newStart, newEnd);
          offsetBulges.push(bulge, 0);
        } else {
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len === 0) continue;
          const nx = -dy / len, ny = dx / len;
          const midPt = midpoint(a, b);
          const sign = (side.x - midPt.x) * nx + (side.y - midPt.y) * ny > 0 ? 1 : -1;
          const off = sign * distance;
          offsetPts.push(
            { x: a.x + nx * off, y: a.y + ny * off },
            { x: b.x + nx * off, y: b.y + ny * off }
          );
          offsetBulges.push(0, 0);
        }
      }
      if (offsetPts.length < 2) return null;
      const cleanPts: Point[] = [offsetPts[0]];
      const cleanBulges: number[] = [offsetBulges[0]];
      for (let i = 1; i < offsetPts.length; i++) {
        if (dist(offsetPts[i], cleanPts[cleanPts.length - 1]) > 1e-6) {
          cleanPts.push(offsetPts[i]);
          cleanBulges.push(offsetBulges[i]);
        }
      }
      while (cleanBulges.length < cleanPts.length) cleanBulges.push(0);
      cleanBulges.length = cleanPts.length;
      return makeEntity({
        type: 'polyline', points: cleanPts,
        bulges: cleanBulges, closed: e.closed,
      } as any);
    }
    default: return null;
  }
}

// PEDIT helpers
export const JOIN_TOL = 1e-4;

export function ptsEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < JOIN_TOL && Math.abs(a.y - b.y) < JOIN_TOL;
}

export function entityEndpoints(e: Entity): { start: Point; end: Point } | null {
  switch (e.type) {
    case 'line': return { start: e.start, end: e.end };
    case 'polyline': {
      if (e.points.length < 2) return null;
      return { start: e.points[0], end: e.points[e.points.length - 1] };
    }
    case 'arc': {
      return {
        start: polarPoint(e.center, e.radius, e.startAngle),
        end: polarPoint(e.center, e.radius, e.endAngle),
      };
    }
    default: return null;
  }
}

export function entityToPoints(e: Entity, reverse: boolean): Point[] {
  if (e.type === 'line') {
    return reverse ? [{ ...e.end }, { ...e.start }] : [{ ...e.start }, { ...e.end }];
  }
  if (e.type === 'polyline') {
    const pts = e.points.map(p => ({ ...p }));
    return reverse ? pts.reverse() : pts;
  }
  if (e.type === 'arc') {
    const steps = Math.max(8, Math.ceil(Math.abs(e.endAngle - e.startAngle) / (Math.PI / 16)));
    const pts: Point[] = [];
    const span = e.endAngle - e.startAngle;
    for (let i = 0; i <= steps; i++) {
      const a = e.startAngle + (span * i) / steps;
      pts.push(polarPoint(e.center, e.radius, a));
    }
    return reverse ? pts.reverse() : pts;
  }
  return [];
}

export function joinToPline(pline: PolylineEntity, entity: Entity): boolean {
  const ep = entityEndpoints(entity);
  if (!ep) return false;

  const pStart = pline.points[0];
  const pEnd = pline.points[pline.points.length - 1];

  if (ptsEqual(pEnd, ep.start)) {
    const pts = entityToPoints(entity, false);
    pline.points.push(...pts.slice(1));
    pline.bulges.push(...pts.slice(1).map(() => 0));
    return true;
  }
  if (ptsEqual(pEnd, ep.end)) {
    const pts = entityToPoints(entity, true);
    pline.points.push(...pts.slice(1));
    pline.bulges.push(...pts.slice(1).map(() => 0));
    return true;
  }
  if (ptsEqual(pStart, ep.end)) {
    const pts = entityToPoints(entity, false);
    pline.points.unshift(...pts.slice(0, -1));
    pline.bulges.unshift(...pts.slice(0, -1).map(() => 0));
    return true;
  }
  if (ptsEqual(pStart, ep.start)) {
    const pts = entityToPoints(entity, true);
    pline.points.unshift(...pts.slice(0, -1));
    pline.bulges.unshift(...pts.slice(0, -1).map(() => 0));
    return true;
  }
  return false;
}

// Trim / fillet / chamfer helpers
export function trimToIntersection(line: LineEntity, pt: Point) {
  const d1 = dist(line.start, pt), d2 = dist(line.end, pt);
  if (d1 < d2) line.start = pt;
  else line.end = pt;
}

export function lineLineIntersectionInf(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

export function edgeToSegments(e: Entity): [Point, Point][] {
  switch (e.type) {
    case 'line': return [[e.start, e.end]];
    case 'polyline': {
      const segs: [Point, Point][] = [];
      const n = e.closed ? e.points.length : e.points.length - 1;
      for (let i = 0; i < n; i++) segs.push([e.points[i], e.points[(i + 1) % e.points.length]]);
      return segs;
    }
    case 'rect': return rectToLines(e);
    default: return [];
  }
}

export function findIntersections(target: Entity, edge: Entity): Point[] {
  const pts: Point[] = [];

  if (target.type === 'line') {
    const edgeSegs = edgeToSegments(edge);
    for (const [a, b] of edgeSegs) {
      const p = lineLineIntersection(target.start, target.end, a, b);
      if (p) pts.push(p);
    }
    if (edge.type === 'circle') {
      pts.push(...lineCircleIntersections(target.start, target.end, edge.center, edge.radius));
    } else if (edge.type === 'arc') {
      const all = lineCircleIntersections(target.start, target.end, edge.center, edge.radius);
      for (const p of all) {
        if (angleInArc(angle(edge.center, p), edge.startAngle, edge.endAngle)) pts.push(p);
      }
    }
  } else if (target.type === 'circle' || target.type === 'arc') {
    const tc = target.center, tr = target.radius;
    const isArc = target.type === 'arc';
    const filterTarget = (p: Point) =>
      !isArc || angleInArc(angle(tc, p), (target as ArcEntity).startAngle, (target as ArcEntity).endAngle);

    const edgeSegs = edgeToSegments(edge);
    for (const [a, b] of edgeSegs) {
      const hits = lineCircleIntersections(a, b, tc, tr);
      for (const p of hits) {
        if (filterTarget(p)) pts.push(p);
      }
    }
    if (edge.type === 'circle' || edge.type === 'arc') {
      const hits = circleCircleIntersections(tc, tr, edge.center, edge.radius);
      for (const p of hits) {
        if (!filterTarget(p)) continue;
        if (edge.type === 'arc' && !angleInArc(angle(edge.center, p), edge.startAngle, edge.endAngle)) continue;
        pts.push(p);
      }
    }
  } else if (target.type === 'polyline') {
    const n = target.closed ? target.points.length : target.points.length - 1;
    for (let i = 0; i < n; i++) {
      const a = target.points[i], b = target.points[(i + 1) % target.points.length];
      const segTarget = { type: 'line' as const, start: a, end: b, id: -1, layer: '', color: '', visible: true, selected: false, lineweight: 1, linetype: '' };
      const segPts = findIntersections(segTarget as any, edge);
      pts.push(...segPts);
    }
  }

  return pts;
}

export function threePointArc(p1: Point, p2: Point, p3: Point) {
  const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-10) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const center = { x: ux, y: uy };
  const radius = dist(center, p1);
  const startAngle = angle(center, p1);
  const endAngle = angle(center, p3);
  return { center, radius, startAngle, endAngle };
}
