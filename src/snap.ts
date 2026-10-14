import { Point, Entity, SnapResult, SnapMode, LineEntity, CircleEntity, ArcEntity, PolylineEntity, RectEntity } from './types';
import { store } from './store';
import { dist, midpoint, closestPointOnLine, closestPointOnCircle, angle, polarPoint,
         lineLineIntersection, lineCircleIntersections, circleCircleIntersections,
         rectToLines, angleInArc, bulgeArc } from './geometry';

const SNAP_RADIUS = 15; // pixels

export function findSnap(worldPt: Point, screenPt: Point): SnapResult {
  const override = store.snapOverride;
  const modes = override ? new Set([override]) : store.snapModes;
  const tol = SNAP_RADIUS / store.view.zoom;

  let best: SnapResult = { point: worldPt, mode: 'none' };
  let bestDist = tol;

  // Nearest is lowest-priority among entity snaps — it always returns
  // the closest point on the curve, which would steal from geometric
  // snaps (midpoint, perpendicular, quadrant, etc.) every time.
  let bestNearest: SnapResult = { point: worldPt, mode: 'none' };
  let bestNearestDist = tol;

  function trySnap(pt: Point, mode: SnapMode, entityId?: string) {
    if (!modes.has(mode)) return;
    const d = dist(worldPt, pt);
    if (mode === 'nearest') {
      if (d < bestNearestDist) {
        bestNearestDist = d;
        bestNearest = { point: pt, mode, entityId };
      }
      return;
    }
    if (d < bestDist) {
      bestDist = d;
      best = { point: pt, mode, entityId };
    }
  }

  for (const e of store.entities) {
    if (!e.visible) continue;
    switch (e.type) {
      case 'line': snapLine(e, worldPt, trySnap); break;
      case 'circle': snapCircle(e, worldPt, trySnap); break;
      case 'arc': snapArc(e, worldPt, trySnap); break;
      case 'polyline': snapPolyline(e, worldPt, trySnap); break;
      case 'rect': snapRect(e, worldPt, trySnap); break;
      case 'point': trySnap(e.position, 'endpoint', e.id); break;
      case 'hatch':
        for (const boundary of e.boundaries) {
          for (const pt of boundary) trySnap(pt, 'endpoint', e.id);
        }
        break;
      case 'blockref': trySnap(e.insertPoint, 'endpoint', e.id); break;
      case 'region':
        for (const pt of e.outerBoundary) trySnap(pt, 'endpoint', e.id);
        for (const hole of e.holes) {
          for (const pt of hole) trySnap(pt, 'endpoint', e.id);
        }
        break;
    }
  }

  // Intersection snaps between entity pairs
  if (modes.has('intersection')) {
    const ents = store.entities.filter(e => e.visible);
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < ents.length; j++) {
        for (const pt of entityIntersections(ents[i], ents[j])) {
          trySnap(pt, 'intersection');
        }
      }
    }
  }

  // Fall back to nearest only if no geometric snap was found
  if (best.mode === 'none' && bestNearest.mode !== 'none') {
    best = bestNearest;
    bestDist = bestNearestDist;
  }

  // Grid snap: F9 toggle forces snap to grid; also fires if 'grid' snap mode is active
  // Snaps to UCS-aligned grid when UCS is active
  if ((store.snapToGrid || modes.has('grid')) && store.gridOn && best.mode === 'none') {
    const gs = store.gridSpacing;
    const ucsP = store.wcsToUcs(worldPt);
    const snappedUcs = { x: Math.round(ucsP.x / gs) * gs, y: Math.round(ucsP.y / gs) * gs };
    const gp = store.ucsToWcs(snappedUcs);
    if (store.snapToGrid || dist(worldPt, gp) < tol) {
      best = { point: gp, mode: 'grid' };
    }
  }

  return best;
}

type TryFn = (pt: Point, mode: SnapMode, entityId?: string) => void;

function snapLine(e: LineEntity, p: Point, trySnap: TryFn) {
  trySnap(e.start, 'endpoint', e.id);
  trySnap(e.end, 'endpoint', e.id);
  trySnap(midpoint(e.start, e.end), 'midpoint', e.id);
  const perp = closestPointOnLine(store.lastPoint, e.start, e.end);
  trySnap(perp, 'perpendicular', e.id);
  trySnap(closestPointOnLine(p, e.start, e.end), 'nearest', e.id);
}

function snapCircle(e: CircleEntity, p: Point, trySnap: TryFn) {
  trySnap(e.center, 'center', e.id);
  for (const a of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    trySnap(polarPoint(e.center, e.radius, a), 'quadrant', e.id);
  }
  const perpAngle = angle(e.center, store.lastPoint);
  trySnap(polarPoint(e.center, e.radius, perpAngle), 'perpendicular', e.id);
  trySnap(polarPoint(e.center, e.radius, perpAngle + Math.PI), 'perpendicular', e.id);
  trySnap(closestPointOnCircle(p, e.center, e.radius), 'nearest', e.id);
  const lp = store.lastPoint;
  const dToCenter = dist(lp, e.center);
  if (dToCenter > e.radius + 1e-10) {
    const baseAngle = angle(e.center, lp);
    const halfAngle = Math.acos(e.radius / dToCenter);
    trySnap(polarPoint(e.center, e.radius, baseAngle + halfAngle), 'tangent', e.id);
    trySnap(polarPoint(e.center, e.radius, baseAngle - halfAngle), 'tangent', e.id);
  }
}

function snapArc(e: ArcEntity, p: Point, trySnap: TryFn) {
  trySnap(polarPoint(e.center, e.radius, e.startAngle), 'endpoint', e.id);
  trySnap(polarPoint(e.center, e.radius, e.endAngle), 'endpoint', e.id);
  trySnap(e.center, 'center', e.id);
  const midA = (e.startAngle + e.endAngle) / 2;
  trySnap(polarPoint(e.center, e.radius, midA), 'midpoint', e.id);
  for (const a of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    if (angleInArc(a, e.startAngle, e.endAngle)) {
      trySnap(polarPoint(e.center, e.radius, a), 'quadrant', e.id);
    }
  }
  const cp = closestPointOnCircle(p, e.center, e.radius);
  if (angleInArc(angle(e.center, cp), e.startAngle, e.endAngle)) {
    trySnap(cp, 'nearest', e.id);
  }
  const lp = store.lastPoint;
  const dToCenter = dist(lp, e.center);
  if (dToCenter > e.radius + 1e-10) {
    const baseAngle = angle(e.center, lp);
    const halfAngle = Math.acos(e.radius / dToCenter);
    for (const tangentAngle of [baseAngle + halfAngle, baseAngle - halfAngle]) {
      if (angleInArc(tangentAngle, e.startAngle, e.endAngle)) {
        trySnap(polarPoint(e.center, e.radius, tangentAngle), 'tangent', e.id);
      }
    }
  }
}

function snapPolyline(e: PolylineEntity, p: Point, trySnap: TryFn) {
  for (let i = 0; i < e.points.length; i++) {
    trySnap(e.points[i], 'endpoint', e.id);
  }
  const count = e.closed ? e.points.length : e.points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = e.points[i], b = e.points[(i + 1) % e.points.length];
    const bg = e.bulges?.[i] ?? 0;
    if (Math.abs(bg) > 1e-10) {
      const arc = bulgeArc(a, b, bg);
      const midA = (arc.startAngle + arc.endAngle) / 2;
      trySnap(polarPoint(arc.center, arc.radius, midA), 'midpoint', e.id);
      const cp = closestPointOnCircle(p, arc.center, arc.radius);
      if (angleInArc(angle(arc.center, cp), arc.startAngle, arc.endAngle)) {
        trySnap(cp, 'nearest', e.id);
      }
      trySnap(arc.center, 'center', e.id);
      const lp = store.lastPoint;
      const dToCenter = dist(lp, arc.center);
      if (dToCenter > arc.radius + 1e-10) {
        const ba = angle(arc.center, lp);
        const ha = Math.acos(arc.radius / dToCenter);
        for (const ta of [ba + ha, ba - ha]) {
          if (angleInArc(ta, arc.startAngle, arc.endAngle)) {
            trySnap(polarPoint(arc.center, arc.radius, ta), 'tangent', e.id);
          }
        }
      }
    } else {
      trySnap(midpoint(a, b), 'midpoint', e.id);
      trySnap(closestPointOnLine(p, a, b), 'nearest', e.id);
    }
  }
}

function snapRect(e: RectEntity, p: Point, trySnap: TryFn) {
  for (const [a, b] of rectToLines(e)) {
    trySnap(a, 'endpoint', e.id);
    trySnap(midpoint(a, b), 'midpoint', e.id);
    trySnap(closestPointOnLine(p, a, b), 'nearest', e.id);
  }
}

function entityIntersections(a: Entity, b: Entity): Point[] {
  const segsA = entityToSegments(a);
  const segsB = entityToSegments(b);
  const circsA = entityToCircles(a);
  const circsB = entityToCircles(b);
  const pts: Point[] = [];

  for (const sa of segsA) {
    for (const sb of segsB) {
      const p = lineLineIntersection(sa[0], sa[1], sb[0], sb[1]);
      if (p) pts.push(p);
    }
    for (const cb of circsB) {
      for (const p of lineCircleIntersections(sa[0], sa[1], cb.center, cb.radius)) {
        if (pointOnArcGeom(p, cb)) pts.push(p);
      }
    }
  }
  for (const ca of circsA) {
    for (const sb of segsB) {
      for (const p of lineCircleIntersections(sb[0], sb[1], ca.center, ca.radius)) {
        if (pointOnArcGeom(p, ca)) pts.push(p);
      }
    }
    for (const cb of circsB) {
      for (const p of circleCircleIntersections(ca.center, ca.radius, cb.center, cb.radius)) {
        if (pointOnArcGeom(p, ca) && pointOnArcGeom(p, cb)) pts.push(p);
      }
    }
  }
  return pts;
}

function entityToSegments(e: Entity): [Point, Point][] {
  switch (e.type) {
    case 'line': return [[e.start, e.end]];
    case 'polyline': {
      const segs: [Point, Point][] = [];
      const pe = e as PolylineEntity;
      const n = pe.closed ? pe.points.length : pe.points.length - 1;
      for (let i = 0; i < n; i++) {
        const bulge = (pe.bulges && pe.bulges[i]) || 0;
        if (bulge === 0) {
          segs.push([pe.points[i], pe.points[(i + 1) % pe.points.length]]);
        }
      }
      return segs;
    }
    case 'rect': return rectToLines(e);
    default: return [];
  }
}

interface ArcGeometry {
  center: Point;
  radius: number;
  startAngle: number;
  endAngle: number;
  isFullCircle: boolean;
}

function pointOnArcGeom(pt: Point, arc: ArcGeometry): boolean {
  if (arc.isFullCircle) return true;
  return angleInArc(angle(arc.center, pt), arc.startAngle, arc.endAngle);
}

function bulgeToArc(p1: Point, p2: Point, bulge: number): ArcGeometry | null {
  const d = dist(p1, p2);
  if (d < 1e-10) return null;
  const absB = Math.abs(bulge);
  const radius = d * (1 + bulge * bulge) / (4 * absB);
  const offsetScalar = d * (1 - bulge * bulge) / (4 * bulge);
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const perpX = -dy / d;
  const perpY = dx / d;
  const cx = mx + offsetScalar * perpX;
  const cy = my + offsetScalar * perpY;
  const center = { x: cx, y: cy };
  let startAngle: number, endAngle: number;
  if (bulge > 0) {
    startAngle = angle(center, p1);
    endAngle = angle(center, p2);
  } else {
    startAngle = angle(center, p2);
    endAngle = angle(center, p1);
  }
  return { center, radius, startAngle, endAngle, isFullCircle: false };
}

function entityToCircles(e: Entity): ArcGeometry[] {
  switch (e.type) {
    case 'circle': return [{ center: e.center, radius: e.radius, startAngle: 0, endAngle: 0, isFullCircle: true }];
    case 'arc': return [{ center: e.center, radius: e.radius, startAngle: e.startAngle, endAngle: e.endAngle, isFullCircle: false }];
    case 'polyline': {
      const arcs: ArcGeometry[] = [];
      const pe = e as PolylineEntity;
      const n = pe.closed ? pe.points.length : pe.points.length - 1;
      for (let i = 0; i < n; i++) {
        const bulge = (pe.bulges && pe.bulges[i]) || 0;
        if (bulge !== 0) {
          const arc = bulgeToArc(pe.points[i], pe.points[(i + 1) % pe.points.length], bulge);
          if (arc) arcs.push(arc);
        }
      }
      return arcs;
    }
    default: return [];
  }
}
