import { Point, Entity, LineEntity, CircleEntity, ArcEntity, PolylineEntity, RectEntity, EllipseEntity, DimensionEntity } from './types';

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function angle(a: Point, b: Point): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export function isHorizontalDim(p1: Point, p2: Point, textPos: Point): boolean {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy;
  let nx: number, ny: number;
  if (len2 < 0.0001) {
    nx = p1.x; ny = p1.y;
  } else {
    const t = Math.max(0, Math.min(1, ((textPos.x - p1.x) * dx + (textPos.y - p1.y) * dy) / len2));
    nx = p1.x + t * dx;
    ny = p1.y + t * dy;
  }
  return Math.abs(textPos.y - ny) >= Math.abs(textPos.x - nx);
}

export function polarPoint(origin: Point, distance: number, ang: number): Point {
  return { x: origin.x + distance * Math.cos(ang), y: origin.y + distance * Math.sin(ang) };
}

export function normalizeAngle(a: number): number {
  while (a < 0) a += Math.PI * 2;
  while (a >= Math.PI * 2) a -= Math.PI * 2;
  return a;
}

export function angleInArc(a: number, start: number, end: number): boolean {
  a = normalizeAngle(a);
  start = normalizeAngle(start);
  end = normalizeAngle(end);
  if (start <= end) return a >= start && a <= end;
  return a >= start || a <= end;
}

export function closestPointOnLine(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

export function closestPointOnCircle(p: Point, center: Point, radius: number): Point {
  const a = angle(center, p);
  return polarPoint(center, radius, a);
}

export function lineLineIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denom;
  if (t < -1e-10 || t > 1 + 1e-10 || u < -1e-10 || u > 1 + 1e-10) return null;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

export function lineCircleIntersections(p1: Point, p2: Point, c: Point, r: number): Point[] {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const fx = p1.x - c.x, fy = p1.y - c.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * cc;
  if (disc < 0) return [];
  disc = Math.sqrt(disc);
  const results: Point[] = [];
  for (const t of [(-b - disc) / (2 * a), (-b + disc) / (2 * a)]) {
    if (t >= -1e-10 && t <= 1 + 1e-10) {
      results.push({ x: p1.x + t * dx, y: p1.y + t * dy });
    }
  }
  return results;
}

export function lineCircleIntersectionsInf(p1: Point, p2: Point, c: Point, r: number): Point[] {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const fx = p1.x - c.x, fy = p1.y - c.y;
  const a = dx * dx + dy * dy;
  if (a < 1e-20) return [];
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * cc;
  if (disc < 0) return [];
  disc = Math.sqrt(disc);
  return [(-b - disc) / (2 * a), (-b + disc) / (2 * a)].map(t => ({
    x: p1.x + t * dx, y: p1.y + t * dy,
  }));
}

export function closestPointOnArc(p: Point, center: Point, radius: number, startAngle: number, endAngle: number): Point {
  let a = angle(center, p);
  if (angleInArc(a, startAngle, endAngle)) {
    return polarPoint(center, radius, a);
  }
  const pStart = polarPoint(center, radius, startAngle);
  const pEnd = polarPoint(center, radius, endAngle);
  return dist(p, pStart) < dist(p, pEnd) ? pStart : pEnd;
}

export function circleCircleIntersections(c1: Point, r1: number, c2: Point, r2: number): Point[] {
  const d = dist(c1, c2);
  if (d > r1 + r2 + 1e-10 || d < Math.abs(r1 - r2) - 1e-10 || d < 1e-10) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1.x + a * (c2.x - c1.x) / d;
  const my = c1.y + a * (c2.y - c1.y) / d;
  const rx = -(c2.y - c1.y) * h / d;
  const ry = (c2.x - c1.x) * h / d;
  if (h < 1e-10) return [{ x: mx, y: my }];
  return [{ x: mx + rx, y: my + ry }, { x: mx - rx, y: my - ry }];
}

export function bulgeArc(p1: Point, p2: Point, bulge: number): { center: Point; radius: number; startAngle: number; endAngle: number; ccw: boolean } {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-10) return { center: p1, radius: 0, startAngle: 0, endAngle: 0, ccw: bulge > 0 };
  const alpha = 4 * Math.atan(Math.abs(bulge));
  const sinHalf = Math.sin(alpha / 2);
  const radius = sinHalf > 1e-10 ? chord / (2 * sinHalf) : chord / 2;
  const d = chord * (1 - bulge * bulge) / (4 * bulge);
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const ux = dx / chord, uy = dy / chord;
  const cx = mx + d * (-uy);
  const cy = my + d * ux;
  const startAngle = Math.atan2(p1.y - cy, p1.x - cx);
  const endAngle = Math.atan2(p2.y - cy, p2.x - cx);
  return { center: { x: cx, y: cy }, radius, startAngle, endAngle, ccw: bulge > 0 };
}

export function rectToLines(e: RectEntity): [Point, Point][] {
  const { corner1: c1, corner2: c2 } = e;
  const tl = { x: Math.min(c1.x, c2.x), y: Math.max(c1.y, c2.y) };
  const tr = { x: Math.max(c1.x, c2.x), y: Math.max(c1.y, c2.y) };
  const br = { x: Math.max(c1.x, c2.x), y: Math.min(c1.y, c2.y) };
  const bl = { x: Math.min(c1.x, c2.x), y: Math.min(c1.y, c2.y) };
  return [[tl, tr], [tr, br], [br, bl], [bl, tl]];
}



export function entityBounds(e: Entity): { min: Point; max: Point } | null {
  switch (e.type) {
    case 'line': return { min: { x: Math.min(e.start.x, e.end.x), y: Math.min(e.start.y, e.end.y) },
                          max: { x: Math.max(e.start.x, e.end.x), y: Math.max(e.start.y, e.end.y) } };
    case 'circle': return { min: { x: e.center.x - e.radius, y: e.center.y - e.radius },
                            max: { x: e.center.x + e.radius, y: e.center.y + e.radius } };
    case 'arc': {
      const pts = [polarPoint(e.center, e.radius, e.startAngle), polarPoint(e.center, e.radius, e.endAngle)];
      for (const q of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
        if (angleInArc(q, e.startAngle, e.endAngle)) pts.push(polarPoint(e.center, e.radius, q));
      }
      return { min: { x: Math.min(...pts.map(p => p.x)), y: Math.min(...pts.map(p => p.y)) },
               max: { x: Math.max(...pts.map(p => p.x)), y: Math.max(...pts.map(p => p.y)) } };
    }
    case 'polyline': {
      if (e.points.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of e.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const segCount = e.closed ? e.points.length : e.points.length - 1;
      for (let i = 0; i < segCount; i++) {
        const bg = e.bulges[i] || 0;
        if (Math.abs(bg) < 1e-10) continue;
        const j = (i + 1) % e.points.length;
        const arc = bulgeArc(e.points[i], e.points[j], bg);
        for (const q of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
          const inArc = arc.ccw
            ? angleInArc(q, arc.endAngle, arc.startAngle)
            : angleInArc(q, arc.startAngle, arc.endAngle);
          if (inArc) {
            const qp = polarPoint(arc.center, arc.radius, q);
            if (qp.x < minX) minX = qp.x;
            if (qp.y < minY) minY = qp.y;
            if (qp.x > maxX) maxX = qp.x;
            if (qp.y > maxY) maxY = qp.y;
          }
        }
      }
      return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
    }
    case 'rect': return { min: { x: Math.min(e.corner1.x, e.corner2.x), y: Math.min(e.corner1.y, e.corner2.y) },
                           max: { x: Math.max(e.corner1.x, e.corner2.x), y: Math.max(e.corner1.y, e.corner2.y) } };
    case 'text': return { min: e.position, max: { x: e.position.x + e.height * e.text.length * 0.6, y: e.position.y + e.height } };
    case 'ellipse': {
      const majorLen = Math.hypot(e.majorX, e.majorY);
      const minorLen = majorLen * e.ratio;
      const maxR = Math.max(majorLen, minorLen);
      return { min: { x: e.center.x - maxR, y: e.center.y - maxR },
               max: { x: e.center.x + maxR, y: e.center.y + maxR } };
    }
    case 'dimension': {
      const pts = [e.p1, e.p2, e.textPos];
      return { min: { x: Math.min(...pts.map(q => q.x)), y: Math.min(...pts.map(q => q.y)) },
               max: { x: Math.max(...pts.map(q => q.x)), y: Math.max(...pts.map(q => q.y)) } };
    }
    case 'point': return { min: { ...e.position }, max: { ...e.position } };
    case 'hatch': {
      const all = e.boundaries.flat();
      if (all.length === 0) return null;
      return { min: { x: Math.min(...all.map(p => p.x)), y: Math.min(...all.map(p => p.y)) },
               max: { x: Math.max(...all.map(p => p.x)), y: Math.max(...all.map(p => p.y)) } };
    }
    case 'blockref': return { min: { ...e.insertPoint }, max: { ...e.insertPoint } };
    case 'region': {
      const all = [...e.outerBoundary, ...e.holes.flat()];
      if (all.length === 0) return null;
      return { min: { x: Math.min(...all.map(p => p.x)), y: Math.min(...all.map(p => p.y)) },
               max: { x: Math.max(...all.map(p => p.x)), y: Math.max(...all.map(p => p.y)) } };
    }
    default: return null;
  }
}

export function pointOnEntity(p: Point, e: Entity, tolerance: number): boolean {
  switch (e.type) {
    case 'line': return dist(p, closestPointOnLine(p, e.start, e.end)) <= tolerance;
    case 'circle': return Math.abs(dist(p, e.center) - e.radius) <= tolerance;
    case 'arc': {
      const d = dist(p, e.center);
      if (Math.abs(d - e.radius) > tolerance) return false;
      return angleInArc(angle(e.center, p), e.startAngle, e.endAngle);
    }
    case 'polyline': {
      for (let i = 0; i < e.points.length - (e.closed ? 0 : 1); i++) {
        const a = e.points[i], b = e.points[(i + 1) % e.points.length];
        const bg = e.bulges[i] || 0;
        if (Math.abs(bg) > 1e-10) {
          const arc = bulgeArc(a, b, bg);
          const d2 = dist(p, arc.center);
          if (Math.abs(d2 - arc.radius) <= tolerance) {
            const pAngle = angle(arc.center, p);
            const inArc = arc.ccw
              ? angleInArc(pAngle, arc.endAngle, arc.startAngle)
              : angleInArc(pAngle, arc.startAngle, arc.endAngle);
            if (inArc) return true;
          }
        } else {
          if (dist(p, closestPointOnLine(p, a, b)) <= tolerance) return true;
        }
      }
      return false;
    }
    case 'rect': {
      for (const [a, b] of rectToLines(e)) {
        if (dist(p, closestPointOnLine(p, a, b)) <= tolerance) return true;
      }
      return false;
    }
    case 'text': {
      const b = entityBounds(e);
      if (!b) return false;
      return p.x >= b.min.x - tolerance && p.x <= b.max.x + tolerance &&
             p.y >= b.min.y - tolerance && p.y <= b.max.y + tolerance;
    }
    case 'ellipse': {
      const majorLen = Math.hypot(e.majorX, e.majorY);
      if (majorLen < 1e-10) return false;
      const rot = Math.atan2(e.majorY, e.majorX);
      const dx = p.x - e.center.x, dy = p.y - e.center.y;
      const lx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
      const ly = dx * Math.sin(-rot) + dy * Math.cos(-rot);
      const minorLen = majorLen * e.ratio;
      const normDist = Math.sqrt((lx / majorLen) ** 2 + (ly / minorLen) ** 2);
      return Math.abs(normDist - 1) <= tolerance / majorLen;
    }
    case 'dimension': {
      if (dist(p, closestPointOnLine(p, e.p1, e.p2)) <= tolerance) return true;
      const b = entityBounds(e);
      if (!b) return false;
      return p.x >= b.min.x - tolerance && p.x <= b.max.x + tolerance &&
             p.y >= b.min.y - tolerance && p.y <= b.max.y + tolerance;
    }
    case 'point': return dist(p, e.position) <= tolerance;
    case 'hatch': {
      for (const boundary of e.boundaries) {
        for (let i = 0; i < boundary.length; i++) {
          const a = boundary[i], b = boundary[(i + 1) % boundary.length];
          if (dist(p, closestPointOnLine(p, a, b)) <= tolerance) return true;
        }
      }
      return false;
    }
    case 'blockref': return dist(p, e.insertPoint) <= tolerance * 3;
    case 'region': {
      for (let i = 0; i < e.outerBoundary.length; i++) {
        const a = e.outerBoundary[i], b = e.outerBoundary[(i + 1) % e.outerBoundary.length];
        if (dist(p, closestPointOnLine(p, a, b)) <= tolerance) return true;
      }
      for (const hole of e.holes) {
        for (let i = 0; i < hole.length; i++) {
          const a = hole[i], b = hole[(i + 1) % hole.length];
          if (dist(p, closestPointOnLine(p, a, b)) <= tolerance) return true;
        }
      }
      return false;
    }
    default: return false;
  }
}

export function getGripPoints(e: Entity): Point[] {
  switch (e.type) {
    case 'line':
      return [e.start, midpoint(e.start, e.end), e.end];
    case 'circle':
      return [
        e.center,
        { x: e.center.x + e.radius, y: e.center.y },
        { x: e.center.x, y: e.center.y + e.radius },
        { x: e.center.x - e.radius, y: e.center.y },
        { x: e.center.x, y: e.center.y - e.radius },
      ];
    case 'arc': {
      let arcMidAngle = (e.startAngle + e.endAngle) / 2;
      if (e.endAngle < e.startAngle) {
        arcMidAngle = normalizeAngle((e.startAngle + e.endAngle + Math.PI * 2) / 2);
      }
      return [
        e.center,
        polarPoint(e.center, e.radius, e.startAngle),
        polarPoint(e.center, e.radius, e.endAngle),
        polarPoint(e.center, e.radius, arcMidAngle),
      ];
    }
    case 'polyline': {
      const pts: Point[] = e.points.map(p => ({ ...p }));
      const segCount = e.closed ? e.points.length : e.points.length - 1;
      for (let i = 0; i < segCount; i++) {
        const p1 = e.points[i];
        const p2 = e.points[(i + 1) % e.points.length];
        const b = e.bulges && e.bulges[i] ? e.bulges[i] : 0;
        if (b !== 0) {
          const dx = p2.x - p1.x, dy = p2.y - p1.y;
          const chord = Math.hypot(dx, dy);
          if (chord > 1e-10) {
            const sagitta = b * chord / 2;
            const nx = -dy / chord, ny = dx / chord;
            pts.push({
              x: (p1.x + p2.x) / 2 + sagitta * nx,
              y: (p1.y + p2.y) / 2 + sagitta * ny,
            });
          } else {
            pts.push(midpoint(p1, p2));
          }
        } else {
          pts.push(midpoint(p1, p2));
        }
      }
      // Centroid grip for moving the entire polyline (last grip)
      const cx = e.points.reduce((s, p) => s + p.x, 0) / e.points.length;
      const cy = e.points.reduce((s, p) => s + p.y, 0) / e.points.length;
      pts.push({ x: cx, y: cy });
      return pts;
    }
    case 'rect': {
      const { corner1: c1, corner2: c2 } = e;
      return [
        { x: c1.x, y: c1.y }, { x: c2.x, y: c1.y },
        { x: c2.x, y: c2.y }, { x: c1.x, y: c2.y },
        midpoint(c1, { x: c2.x, y: c1.y }),
        midpoint({ x: c2.x, y: c1.y }, c2),
        midpoint(c2, { x: c1.x, y: c2.y }),
        midpoint({ x: c1.x, y: c2.y }, c1),
        // Center grip for moving the entire rect (last grip, index 8)
        midpoint(c1, c2),
      ];
    }
    case 'text':
      return [e.position];
    case 'ellipse': {
      const majorLen = Math.hypot(e.majorX, e.majorY);
      const rot = Math.atan2(e.majorY, e.majorX);
      return [
        e.center,
        { x: e.center.x + e.majorX, y: e.center.y + e.majorY },
        { x: e.center.x - e.majorX, y: e.center.y - e.majorY },
        { x: e.center.x + (-e.majorY * e.ratio), y: e.center.y + (e.majorX * e.ratio) },
        { x: e.center.x - (-e.majorY * e.ratio), y: e.center.y - (e.majorX * e.ratio) },
      ];
    }
    case 'dimension':
      return [e.p1, e.p2, e.textPos];
    case 'point':
      return [e.position];
    case 'blockref':
      return [e.insertPoint];
    case 'hatch':
      return e.boundaries.flat();
    case 'region':
      return [...e.outerBoundary, ...e.holes.flat()];
    default:
      return [];
  }
}

export function moveGrip(e: Entity, gripIndex: number, newPt: Point) {
  switch (e.type) {
    case 'line':
      if (gripIndex === 0) e.start = newPt;
      else if (gripIndex === 1) {
        const dx = newPt.x - (e.start.x + e.end.x) / 2;
        const dy = newPt.y - (e.start.y + e.end.y) / 2;
        e.start = { x: e.start.x + dx, y: e.start.y + dy };
        e.end = { x: e.end.x + dx, y: e.end.y + dy };
      } else e.end = newPt;
      break;
    case 'circle':
      if (gripIndex === 0) e.center = newPt;
      else e.radius = dist(e.center, newPt);
      break;
    case 'arc':
      if (gripIndex === 0) e.center = newPt;
      else if (gripIndex === 1) {
        e.radius = dist(e.center, newPt);
        e.startAngle = angle(e.center, newPt);
      } else if (gripIndex === 2) {
        e.radius = dist(e.center, newPt);
        e.endAngle = angle(e.center, newPt);
      }
      break;
    case 'polyline': {
      const segCount = e.closed ? e.points.length : e.points.length - 1;
      const centroidIndex = e.points.length + segCount;
      if (gripIndex === centroidIndex) {
        // Centroid grip: move entire polyline
        const cx = e.points.reduce((s, p) => s + p.x, 0) / e.points.length;
        const cy = e.points.reduce((s, p) => s + p.y, 0) / e.points.length;
        const dx = newPt.x - cx;
        const dy = newPt.y - cy;
        for (const p of e.points) { p.x += dx; p.y += dy; }
      } else if (gripIndex >= 0 && gripIndex < e.points.length) {
        e.points[gripIndex] = newPt;
      }
      break;
    }
    case 'rect':
      if (gripIndex === 8) {
        // Center grip: move entire rect
        const cx = (e.corner1.x + e.corner2.x) / 2;
        const cy = (e.corner1.y + e.corner2.y) / 2;
        const dx = newPt.x - cx;
        const dy = newPt.y - cy;
        e.corner1 = { x: e.corner1.x + dx, y: e.corner1.y + dy };
        e.corner2 = { x: e.corner2.x + dx, y: e.corner2.y + dy };
      } else if (gripIndex < 4) {
        const corners = [
          { x: e.corner1.x, y: e.corner1.y }, { x: e.corner2.x, y: e.corner1.y },
          { x: e.corner2.x, y: e.corner2.y }, { x: e.corner1.x, y: e.corner2.y },
        ];
        corners[gripIndex] = newPt;
        e.corner1 = { x: Math.min(corners[0].x, corners[2].x), y: Math.min(corners[0].y, corners[2].y) };
        e.corner2 = { x: Math.max(corners[0].x, corners[2].x), y: Math.max(corners[0].y, corners[2].y) };
      } else {
        // Edge midpoint grips: 4=bottom, 5=right, 6=top, 7=left
        if (gripIndex === 4) e.corner1.y = newPt.y;
        else if (gripIndex === 5) e.corner2.x = newPt.x;
        else if (gripIndex === 6) e.corner2.y = newPt.y;
        else if (gripIndex === 7) e.corner1.x = newPt.x;
      }
      break;
    case 'text':
      e.position = newPt; break;
    case 'ellipse':
      if (gripIndex === 0) e.center = newPt;
      else if (gripIndex === 1 || gripIndex === 2) {
        const sign = gripIndex === 1 ? 1 : -1;
        e.majorX = (newPt.x - e.center.x) * sign;
        e.majorY = (newPt.y - e.center.y) * sign;
      } else {
        const majorLen = Math.hypot(e.majorX, e.majorY);
        if (majorLen > 1e-10) {
          const minorDist = dist(e.center, newPt);
          e.ratio = minorDist / majorLen;
        }
      }
      break;
    case 'dimension':
      if (gripIndex === 0) (e as DimensionEntity).p1 = newPt;
      else if (gripIndex === 1) (e as DimensionEntity).p2 = newPt;
      else (e as DimensionEntity).textPos = newPt;
      break;
    case 'point':
      e.position = newPt; break;
    case 'blockref':
      e.insertPoint = newPt; break;
    case 'region': {
      const allPts = [...e.outerBoundary, ...e.holes.flat()];
      if (gripIndex < allPts.length) {
        if (gripIndex < e.outerBoundary.length) {
          e.outerBoundary[gripIndex] = newPt;
        } else {
          let idx = gripIndex - e.outerBoundary.length;
          for (const hole of e.holes) {
            if (idx < hole.length) { hole[idx] = newPt; break; }
            idx -= hole.length;
          }
        }
      }
      break;
    }
  }
}
