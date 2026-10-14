import { Entity, Point, SnapResult, SnapMode, BlockRefEntity, DimStyle, PolylineEntity } from './types';
import { store } from './store';
import { polarPoint, angleInArc, normalizeAngle, getGripPoints, isHorizontalDim, dist, angle, bulgeArc } from './geometry';
import { renderShelterOverlay } from './shelter';

const COLORS: Record<string, string> = {
  '1': '#ff0000', '2': '#ffff00', '3': '#00ff00', '4': '#00ffff',
  '5': '#0000ff', '6': '#ff00ff', '7': '#ffffff',
};

// AutoCAD R14: all snap markers are yellow
const SNAP_COLOR = '#ffff00';

const LINETYPE_PATTERNS: Record<string, number[]> = {
  continuous: [],
  dashed: [8, 4],
  hidden: [4, 4],
  center: [12, 4, 4, 4],
  dashdot: [8, 4, 2, 4],
  phantom: [16, 4, 4, 4, 4, 4],
  dot: [2, 4],
  border: [8, 4, 8, 4, 2, 4],
  divide: [8, 4, 2, 4, 2, 4],
};

const SNAP_LABELS: Partial<Record<SnapMode, string>> = {
  endpoint: 'Endpoint', midpoint: 'Midpoint', center: 'Center',
  intersection: 'Intersection', perpendicular: 'Perpendicular',
  tangent: 'Tangent', quadrant: 'Quadrant', nearest: 'Nearest',
  grid: 'Grid',
};

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  cursorWorld: Point = { x: 0, y: 0 };
  snapResult: SnapResult | null = null;
  rubberBand: { start: Point; end: Point } | null = null;
  rubberCircle: { center: Point; radius: number } | null = null;
  rubberArc: { center: Point; radius: number; startAngle: number; endAngle: number } | null = null;
  rubberRect: { corner1: Point; corner2: Point } | null = null;
  rubberPolyline: Point[] | null = null;
  rubberEllipse: { center: Point; majorX: number; majorY: number; ratio: number } | null = null;
  selectionBox: { p1: Point; p2: Point } | null = null;
  hotGrip: { entityId: string; gripIndex: number } | null = null;
  gripRubberBand: { start: Point; end: Point } | null = null;
  preview: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  polarTrackLine: { from: Point; to: Point; angle: number; distance: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;

    // R14 black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    // Grid
    if (store.gridOn) this.drawGrid(w, h);

    // Raster overlays (satellite, cadastral images)
    for (const ov of store.rasterOverlays) {
      const ovLayer = store.layers.find(l => l.name === ov.layer);
      if (ovLayer && !ovLayer.visible) continue;
      if (ovLayer && ovLayer.frozen) continue;
      const tl = store.worldToScreen({ x: ov.bounds.minX, y: ov.bounds.maxY });
      const br = store.worldToScreen({ x: ov.bounds.maxX, y: ov.bounds.minY });
      const dw = br.x - tl.x;
      const dh = br.y - tl.y;
      if (dw > 0 && dh > 0) {
        ctx.globalAlpha = 0.85;
        ctx.drawImage(ov.image, tl.x, tl.y, dw, dh);
        ctx.globalAlpha = 1.0;
      }
    }

    // Entities
    for (const e of store.entities) {
      if (!e.visible) continue;
      const eLayer = store.layers.find(l => l.name === e.layer);
      if (eLayer && eLayer.frozen) continue;
      this.drawEntity(e);
    }

    // Grips on selected entities
    this.drawGrips();

    // Grip rubber band
    if (this.gripRubberBand) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 1;
      this.strokeLine(this.gripRubberBand.start, this.gripRubberBand.end);
      ctx.setLineDash([]);
    }

    // Rubber band previews
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    if (this.rubberBand) {
      this.strokeLine(this.rubberBand.start, this.rubberBand.end);
    }
    if (this.rubberCircle) {
      this.strokeCircle(this.rubberCircle.center, this.rubberCircle.radius);
    }
    if (this.rubberArc) {
      this.strokeArc(this.rubberArc.center, this.rubberArc.radius, this.rubberArc.startAngle, this.rubberArc.endAngle);
    }
    if (this.rubberRect) {
      const { corner1: c1, corner2: c2 } = this.rubberRect;
      this.strokeRectWorld(c1, c2);
    }
    if (this.rubberPolyline && this.rubberPolyline.length > 0) {
      for (let i = 0; i < this.rubberPolyline.length - 1; i++) {
        this.strokeLine(this.rubberPolyline[i], this.rubberPolyline[i + 1]);
      }
      this.strokeLine(this.rubberPolyline[this.rubberPolyline.length - 1], this.cursorWorld);
    }
    if (this.rubberEllipse) {
      const e = this.rubberEllipse;
      const sc = store.worldToScreen(e.center);
      const majorLen = Math.hypot(e.majorX, e.majorY) * store.view.zoom;
      const rot = Math.atan2(e.majorY, e.majorX);
      ctx.save();
      ctx.translate(sc.x, sc.y);
      ctx.rotate(-rot);
      ctx.scale(1, e.ratio);
      ctx.beginPath();
      ctx.arc(0, 0, majorLen, 0, Math.PI * 2);
      ctx.restore();
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (this.preview) {
      this.preview(ctx);
    }

    // Polar tracking line
    if (this.polarTrackLine) {
      const ptl = this.polarTrackLine;
      const sf = store.worldToScreen(ptl.from);
      const st = store.worldToScreen(ptl.to);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sf.x, sf.y);
      ctx.lineTo(st.x, st.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Tooltip with angle and distance
      const mx = (sf.x + st.x) / 2;
      const my = (sf.y + st.y) / 2;
      ctx.font = '10px monospace';
      ctx.fillStyle = '#00ff00';
      ctx.fillText(`${ptl.distance.toFixed(2)} < ${ptl.angle.toFixed(1)}°`, mx + 10, my - 6);
    }

    // Selection box
    if (this.selectionBox) {
      const s1 = store.worldToScreen(this.selectionBox.p1);
      const s2 = store.worldToScreen(this.selectionBox.p2);
      const leftToRight = s2.x > s1.x;
      ctx.strokeStyle = leftToRight ? '#00ff00' : '#0000ff';
      ctx.fillStyle = leftToRight ? 'rgba(0,255,0,0.05)' : 'rgba(0,0,255,0.05)';
      ctx.setLineDash(leftToRight ? [] : [6, 3]);
      ctx.strokeRect(s1.x, s1.y, s2.x - s1.x, s2.y - s1.y);
      ctx.fillRect(s1.x, s1.y, s2.x - s1.x, s2.y - s1.y);
      ctx.setLineDash([]);
    }

    // Snap marker
    if (this.snapResult && this.snapResult.mode !== 'none') {
      this.drawSnapMarker(this.snapResult);
    }

    // Crosshair cursor (full screen, R14 style)
    this.drawCrosshair(w, h);

    // Scale bar (bottom-right)
    this.drawScaleBar(w, h);

    // UCS icon (bottom-left)
    this.drawUCSIcon();

    // Shelter placement overlay
    renderShelterOverlay(ctx, w, h);
  }

  private drawGrid(w: number, h: number) {
    const ctx = this.ctx;
    const gs = store.gridSpacing;
    const v = store.view;
    const ucsOrig = store.ucsOrigin;
    const ucsRad = store.ucsAngle * Math.PI / 180;
    const hasUCS = store.isUCS();

    const worldLeft = v.panX;
    const worldRight = v.panX + w / v.zoom;
    const worldBottom = v.panY - h / v.zoom;
    const worldTop = v.panY;

    const dotSize = Math.max(1, v.zoom * 0.8);
    const majorEvery = 5;

    if (!hasUCS) {
      const startX = Math.floor(worldLeft / gs) * gs;
      const startY = Math.floor(worldBottom / gs) * gs;
      for (let x = startX; x <= worldRight; x += gs) {
        for (let y = startY; y <= worldTop; y += gs) {
          const isMajor = Math.round(x / gs) % majorEvery === 0 && Math.round(y / gs) % majorEvery === 0;
          ctx.fillStyle = isMajor ? '#555555' : '#333333';
          const sz = isMajor ? dotSize * 1.5 : dotSize;
          const sp = store.worldToScreen({ x, y });
          ctx.fillRect(sp.x - sz / 2, sp.y - sz / 2, sz, sz);
        }
      }
    } else {
      const cos = Math.cos(ucsRad), sin = Math.sin(ucsRad);
      const diag = Math.hypot(worldRight - worldLeft, worldTop - worldBottom);
      const range = Math.ceil(diag / gs) + 2;
      const cx = (worldLeft + worldRight) / 2;
      const cy = (worldBottom + worldTop) / 2;
      const ucsCenterX = Math.round(((cx - ucsOrig.x) * cos + (cy - ucsOrig.y) * sin) / gs);
      const ucsCenterY = Math.round((-(cx - ucsOrig.x) * sin + (cy - ucsOrig.y) * cos) / gs);

      for (let i = -range; i <= range; i++) {
        for (let j = -range; j <= range; j++) {
          const ui = ucsCenterX + i, uj = ucsCenterY + j;
          const wx = ucsOrig.x + ui * gs * cos - uj * gs * sin;
          const wy = ucsOrig.y + ui * gs * sin + uj * gs * cos;
          if (wx < worldLeft - gs || wx > worldRight + gs || wy < worldBottom - gs || wy > worldTop + gs) continue;
          const isMajor = ui % majorEvery === 0 && uj % majorEvery === 0;
          ctx.fillStyle = isMajor ? '#555555' : '#333333';
          const sz = isMajor ? dotSize * 1.5 : dotSize;
          const sp = store.worldToScreen({ x: wx, y: wy });
          ctx.fillRect(sp.x - sz / 2, sp.y - sz / 2, sz, sz);
        }
      }
    }
  }

  private drawCrosshair(w: number, h: number) {
    const ctx = this.ctx;
    const sp = store.worldToScreen(this.cursorWorld);
    const gap = 5;

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Horizontal
    ctx.moveTo(0, sp.y); ctx.lineTo(sp.x - gap, sp.y);
    ctx.moveTo(sp.x + gap, sp.y); ctx.lineTo(w, sp.y);
    // Vertical
    ctx.moveTo(sp.x, 0); ctx.lineTo(sp.x, sp.y - gap);
    ctx.moveTo(sp.x, sp.y + gap); ctx.lineTo(sp.x, h);
    ctx.stroke();
  }

  private drawUCSIcon() {
    const ctx = this.ctx;
    const hasUCS = store.isUCS();
    const rad = store.ucsAngle * Math.PI / 180;
    const len = 22;
    const ox = 35, oy = this.canvas.getBoundingClientRect().height - 35;

    const xColor = hasUCS ? '#ff4444' : '#888888';
    const yColor = hasUCS ? '#44ff44' : '#888888';
    const labelColor = hasUCS ? '#ffffff' : '#888888';

    const xDx = Math.cos(rad) * len, xDy = -Math.sin(rad) * len;
    const yDx = -Math.sin(rad) * len, yDy = -Math.cos(rad) * len;

    ctx.lineWidth = hasUCS ? 2 : 1;

    // X axis
    ctx.strokeStyle = xColor;
    ctx.beginPath();
    ctx.moveTo(ox, oy); ctx.lineTo(ox + xDx, oy + xDy); ctx.stroke();
    // X arrowhead
    const xTip = { x: ox + xDx, y: oy + xDy };
    const xAng = Math.atan2(xDy, xDx);
    ctx.fillStyle = xColor;
    ctx.beginPath();
    ctx.moveTo(xTip.x, xTip.y);
    ctx.lineTo(xTip.x - 6 * Math.cos(xAng - 0.4), xTip.y - 6 * Math.sin(xAng - 0.4));
    ctx.lineTo(xTip.x - 6 * Math.cos(xAng + 0.4), xTip.y - 6 * Math.sin(xAng + 0.4));
    ctx.fill();

    // Y axis
    ctx.strokeStyle = yColor;
    ctx.beginPath();
    ctx.moveTo(ox, oy); ctx.lineTo(ox + yDx, oy + yDy); ctx.stroke();
    // Y arrowhead
    const yTip = { x: ox + yDx, y: oy + yDy };
    const yAng = Math.atan2(yDy, yDx);
    ctx.fillStyle = yColor;
    ctx.beginPath();
    ctx.moveTo(yTip.x, yTip.y);
    ctx.lineTo(yTip.x - 6 * Math.cos(yAng - 0.4), yTip.y - 6 * Math.sin(yAng - 0.4));
    ctx.lineTo(yTip.x - 6 * Math.cos(yAng + 0.4), yTip.y - 6 * Math.sin(yAng + 0.4));
    ctx.fill();

    // Axis labels
    ctx.font = 'bold 10px monospace';
    ctx.fillStyle = labelColor;
    ctx.fillText('X', ox + xDx + Math.cos(xAng) * 8, oy + xDy + Math.sin(xAng) * 8 + 3);
    ctx.fillText('Y', ox + yDx + Math.cos(yAng) * 8, oy + yDy + Math.sin(yAng) * 8 + 3);

    // Origin marker: small square for WCS, small circle for UCS
    if (hasUCS) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ox, oy, 3, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#888888';
      ctx.lineWidth = 1;
      ctx.strokeRect(ox - 2, oy - 2, 4, 4);
    }

    // WCS/UCS label
    ctx.font = '9px monospace';
    ctx.fillStyle = labelColor;
    ctx.fillText(hasUCS ? 'UCS' : 'WCS', ox - 6, oy + 14);
  }

  private drawScaleBar(w: number, h: number) {
    const ctx = this.ctx;
    const barMaxPx = 120;
    const worldLen = barMaxPx / store.view.zoom;

    const niceSteps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let step = niceSteps[0];
    for (const s of niceSteps) {
      if (s <= worldLen) step = s;
      else break;
    }
    // Handle very small zoom
    if (worldLen < 1) {
      const small = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];
      step = small[0];
      for (const s of small) {
        if (s <= worldLen) step = s;
        else break;
      }
    }

    const barPx = step * store.view.zoom;
    const bx = w - barPx - 20;
    const by = h - 16;

    ctx.strokeStyle = '#aaaaaa';
    ctx.fillStyle = '#aaaaaa';
    ctx.lineWidth = 1;

    // Horizontal bar
    ctx.beginPath();
    ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.stroke();
    // End ticks
    ctx.beginPath();
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx + barPx, by - 4); ctx.lineTo(bx + barPx, by + 4); ctx.stroke();

    // Label
    let label: string;
    if (step >= 1) label = step.toString();
    else label = step.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, bx + barPx / 2, by - 6);
    ctx.textAlign = 'start';
  }

  private drawGrips() {
    if (!store.gripsEnabled) return;
    const ctx = this.ctx;
    const gs = 4;
    for (const e of store.entities) {
      if (!e.visible || !e.selected) continue;
      const grips = getGripPoints(e);
      for (let gi = 0; gi < grips.length; gi++) {
        const sp = store.worldToScreen(grips[gi]);
        const isHot = this.hotGrip && this.hotGrip.entityId === e.id && this.hotGrip.gripIndex === gi;
        ctx.fillStyle = isHot ? '#ff0000' : '#0066ff';
        ctx.fillRect(sp.x - gs, sp.y - gs, gs * 2 + 1, gs * 2 + 1);
        ctx.strokeStyle = isHot ? '#ffffff' : '#aaccff';
        ctx.lineWidth = 1;
        ctx.strokeRect(sp.x - gs, sp.y - gs, gs * 2 + 1, gs * 2 + 1);
      }
    }
  }

  private drawSnapMarker(snap: SnapResult) {
    const ctx = this.ctx;
    const sp = store.worldToScreen(snap.point);
    const s = 6;

    ctx.strokeStyle = SNAP_COLOR;
    ctx.lineWidth = 1.5;

    switch (snap.mode) {
      case 'endpoint':
        ctx.strokeRect(sp.x - s, sp.y - s, s * 2, s * 2);
        break;
      case 'midpoint':
        ctx.beginPath();
        ctx.moveTo(sp.x - s, sp.y + s);
        ctx.lineTo(sp.x + s, sp.y + s);
        ctx.lineTo(sp.x, sp.y - s);
        ctx.closePath(); ctx.stroke();
        break;
      case 'center':
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, s, 0, Math.PI * 2); ctx.stroke();
        // Cross inside the circle (R14 style)
        ctx.beginPath();
        ctx.moveTo(sp.x - s * 0.5, sp.y); ctx.lineTo(sp.x + s * 0.5, sp.y);
        ctx.moveTo(sp.x, sp.y - s * 0.5); ctx.lineTo(sp.x, sp.y + s * 0.5);
        ctx.stroke();
        break;
      case 'intersection':
        ctx.beginPath();
        ctx.moveTo(sp.x - s, sp.y - s); ctx.lineTo(sp.x + s, sp.y + s);
        ctx.moveTo(sp.x + s, sp.y - s); ctx.lineTo(sp.x - s, sp.y + s);
        ctx.stroke();
        break;
      case 'perpendicular':
        ctx.beginPath();
        ctx.moveTo(sp.x - s, sp.y + s); ctx.lineTo(sp.x - s, sp.y - s);
        ctx.lineTo(sp.x + s, sp.y - s); ctx.stroke();
        break;
      case 'quadrant':
        ctx.save();
        ctx.translate(sp.x, sp.y); ctx.rotate(Math.PI / 4);
        ctx.strokeRect(-s, -s, s * 2, s * 2);
        ctx.restore();
        break;
      case 'nearest':
        ctx.beginPath();
        ctx.moveTo(sp.x - s, sp.y); ctx.lineTo(sp.x, sp.y - s);
        ctx.lineTo(sp.x + s, sp.y); ctx.lineTo(sp.x, sp.y + s);
        ctx.closePath(); ctx.stroke();
        break;
      case 'tangent':
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, s * 0.6, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sp.x - s, sp.y - s * 0.6); ctx.lineTo(sp.x + s, sp.y - s * 0.6); ctx.stroke();
        break;
    }

    // Tooltip label (R14 shows snap mode name next to marker)
    const label = SNAP_LABELS[snap.mode];
    if (label) {
      ctx.font = '10px "MS Sans Serif", Tahoma, sans-serif';
      ctx.fillStyle = SNAP_COLOR;
      ctx.fillText(label, sp.x + s + 4, sp.y - s);
    }
  }

  private parentBlockColor: string | null = null;

  private resolveColor(e: Entity): string {
    if (e.color === 'bylayer') {
      const layer = store.layers.find(l => l.name === e.layer);
      return layer?.color || '#ffffff';
    }
    if (e.color === 'byblock') {
      return this.parentBlockColor || '#ffffff';
    }
    return COLORS[e.color] || e.color || '#ffffff';
  }

  private resolveLineweight(e: Entity): number {
    if (e.lineweight <= 0) {
      const layer = store.layers.find(l => l.name === e.layer);
      return (layer as any)?.lineweight || 1;
    }
    return e.lineweight;
  }

  drawEntity(e: Entity) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.resolveColor(e);
    const lw = this.resolveLineweight(e);
    const screenLw = store.lwDisplay ? Math.max(1, lw * 0.3 * store.view.zoom) : 1;
    ctx.lineWidth = screenLw;

    if (e.selected) {
      ctx.setLineDash([6, 3]);
    } else {
      ctx.setLineDash([]);
    }

    // Hover highlight: brighter color and thicker line
    if (e.id === store.hoveredEntityId && !e.selected) {
      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth = screenLw + 1.5;
    }

    // World-space dash pattern for non-continuous linetypes
    const rawPattern = (!e.selected && e.linetype && e.linetype !== 'continuous')
      ? (LINETYPE_PATTERNS[e.linetype] || [])
      : [];
    const worldPattern = rawPattern.map(v => v * store.ltScale);
    const hasDash = worldPattern.length > 0;

    switch (e.type) {
      case 'line':
        if (hasDash) this.strokeDashedPath([e.start, e.end], worldPattern, false);
        else this.strokeLine(e.start, e.end);
        break;
      case 'circle':
        if (hasDash) this.strokeDashedCircle(e.center, e.radius, worldPattern);
        else this.strokeCircle(e.center, e.radius);
        break;
      case 'arc':
        if (hasDash) this.strokeDashedArc(e.center, e.radius, e.startAngle, e.endAngle, worldPattern);
        else this.strokeArc(e.center, e.radius, e.startAngle, e.endAngle);
        break;
      case 'polyline':
        if (hasDash) {
          ctx.setLineDash([]);
          this.strokeDashedPolyline(e, rawPattern);
        } else {
          this.drawPolyline(e);
        }
        break;
      case 'rect':
        if (hasDash) {
          const rectPts: Point[] = [
            e.corner1,
            { x: e.corner2.x, y: e.corner1.y },
            e.corner2,
            { x: e.corner1.x, y: e.corner2.y },
          ];
          this.strokeDashedPath(rectPts, worldPattern, true);
        } else {
          this.strokeRectWorld(e.corner1, e.corner2);
        }
        break;
      case 'ellipse':
        if (hasDash) this.strokeDashedEllipse(e, worldPattern);
        else this.drawEllipse(e);
        break;
      case 'text': this.drawText(e); break;
      case 'dimension': this.drawDimension(e); break;
      case 'point': this.drawPoint(e); break;
      case 'hatch': this.drawHatch(e); break;
      case 'blockref': this.drawBlockRef(e); break;
      case 'region': this.drawRegion(e); break;
    }
    ctx.setLineDash([]);
  }

  private strokeLine(a: Point, b: Point) {
    const sa = store.worldToScreen(a), sb = store.worldToScreen(b);
    this.ctx.beginPath();
    this.ctx.moveTo(sa.x, sa.y); this.ctx.lineTo(sb.x, sb.y);
    this.ctx.stroke();
  }

  private strokeCircle(c: Point, r: number) {
    const sc = store.worldToScreen(c);
    this.ctx.beginPath();
    this.ctx.arc(sc.x, sc.y, r * store.view.zoom, 0, Math.PI * 2);
    this.ctx.stroke();
  }

  private strokeArc(c: Point, r: number, start: number, end: number) {
    const sc = store.worldToScreen(c);
    this.ctx.beginPath();
    this.ctx.arc(sc.x, sc.y, r * store.view.zoom, -end, -start);
    this.ctx.stroke();
  }

  private strokeRectWorld(c1: Point, c2: Point) {
    const s1 = store.worldToScreen(c1), s2 = store.worldToScreen(c2);
    this.ctx.strokeRect(s1.x, s1.y, s2.x - s1.x, s2.y - s1.y);
  }

  private strokeDashedPath(worldPoints: Point[], pattern: number[], closed: boolean) {
    const ctx = this.ctx;
    const zoom = store.view.zoom;
    const totalPatLen = pattern.reduce((a, b) => a + b, 0);

    if (totalPatLen === 0 || pattern.length === 0 || worldPoints.length < 2) {
      if (worldPoints.length < 2) return;
      ctx.beginPath();
      const s0 = store.worldToScreen(worldPoints[0]);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < worldPoints.length; i++) {
        const sp = store.worldToScreen(worldPoints[i]);
        ctx.lineTo(sp.x, sp.y);
      }
      if (closed) ctx.closePath();
      ctx.stroke();
      return;
    }

    const screenPattern = pattern.map(v => v * zoom);
    const pts = worldPoints.map(p => store.worldToScreen(p));
    if (closed && pts.length > 0) {
      pts.push({ x: pts[0].x, y: pts[0].y });
    }

    let patIdx = 0;
    let patRemain = screenPattern[0];
    let drawing = true;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 0; i < pts.length - 1; i++) {
      let sx = pts[i].x, sy = pts[i].y;
      const ex = pts[i + 1].x, ey = pts[i + 1].y;
      let segLen = Math.hypot(ex - sx, ey - sy);
      if (segLen < 0.5) continue;
      const ux = (ex - sx) / segLen, uy = (ey - sy) / segLen;

      while (segLen > 0.001) {
        if (patRemain >= segLen) {
          if (drawing) ctx.lineTo(ex, ey);
          else ctx.moveTo(ex, ey);
          patRemain -= segLen;
          segLen = 0;
        } else {
          const nx = sx + ux * patRemain;
          const ny = sy + uy * patRemain;
          if (drawing) ctx.lineTo(nx, ny);
          else ctx.moveTo(nx, ny);
          sx = nx; sy = ny;
          segLen -= patRemain;
          patIdx = (patIdx + 1) % screenPattern.length;
          patRemain = screenPattern[patIdx];
          drawing = !drawing;
        }
      }

      if (patRemain < 0.001) {
        patIdx = (patIdx + 1) % screenPattern.length;
        patRemain = screenPattern[patIdx];
        drawing = !drawing;
      }
    }
    ctx.stroke();
  }

  private strokeDashedCircle(center: Point, radius: number, pattern: number[]) {
    const numSegments = Math.min(360, Math.max(72, Math.ceil(radius * store.view.zoom * 0.5)));
    const points: Point[] = [];
    for (let i = 0; i < numSegments; i++) {
      const a = (i / numSegments) * Math.PI * 2;
      points.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
    }
    this.strokeDashedPath(points, pattern, true);
  }

  private strokeDashedArc(center: Point, radius: number, startAngle: number, endAngle: number, pattern: number[]) {
    let sweep = endAngle - startAngle;
    if (sweep <= 0) sweep += Math.PI * 2;
    const numSegments = Math.min(360, Math.max(36, Math.ceil(sweep * radius * store.view.zoom * 0.25)));
    const points: Point[] = [];
    for (let i = 0; i <= numSegments; i++) {
      const a = startAngle + (i / numSegments) * sweep;
      points.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
    }
    this.strokeDashedPath(points, pattern, false);
  }

  private strokeDashedEllipse(e: { center: Point; majorX: number; majorY: number; ratio: number; startParam: number; endParam: number }, pattern: number[]) {
    const majorLen = Math.hypot(e.majorX, e.majorY);
    const rot = Math.atan2(e.majorY, e.majorX);
    let sweep = e.endParam - e.startParam;
    if (sweep <= 0) sweep += Math.PI * 2;
    const isFull = Math.abs(sweep - Math.PI * 2) < 0.001;
    const numSegments = Math.min(360, Math.max(72, Math.ceil(majorLen * store.view.zoom * 0.5)));
    const points: Point[] = [];
    const count = isFull ? numSegments : numSegments + 1;
    for (let i = 0; i < count; i++) {
      const t = e.startParam + (i / numSegments) * sweep;
      const lx = majorLen * Math.cos(t);
      const ly = majorLen * e.ratio * Math.sin(t);
      points.push({
        x: e.center.x + lx * Math.cos(rot) - ly * Math.sin(rot),
        y: e.center.y + lx * Math.sin(rot) + ly * Math.cos(rot),
      });
    }
    this.strokeDashedPath(points, pattern, isFull);
  }

  private drawPolyline(e: { points: Point[]; closed: boolean; bulges?: number[] }) {
    if (e.points.length < 2) return;
    const ctx = this.ctx;
    ctx.beginPath();
    const s0 = store.worldToScreen(e.points[0]);
    ctx.moveTo(s0.x, s0.y);

    const n = e.points.length;
    const segCount = e.closed ? n : n - 1;

    for (let i = 0; i < segCount; i++) {
      const j = (i + 1) % n;
      const bg = e.bulges?.[i] ?? 0;

      if (Math.abs(bg) > 1e-10) {
        const arc = bulgeArc(e.points[i], e.points[j], bg);
        const sc = store.worldToScreen(arc.center);
        const sr = arc.radius * store.view.zoom;
        ctx.arc(sc.x, sc.y, sr, -arc.startAngle, -arc.endAngle, !arc.ccw);
      } else {
        const sp = store.worldToScreen(e.points[j]);
        ctx.lineTo(sp.x, sp.y);
      }
    }

    ctx.stroke();
  }

  private strokeDashedPolyline(e: PolylineEntity, pattern: number[]): void {
    if (e.points.length < 2) return;
    const ctx = this.ctx;

    const path: { x: number; y: number }[] = [];
    path.push(store.worldToScreen(e.points[0]));

    const segCount = e.closed ? e.points.length : e.points.length - 1;

    for (let i = 0; i < segCount; i++) {
      const p1 = e.points[i];
      const p2 = e.points[(i + 1) % e.points.length];
      const bulge = e.bulges?.[i] ?? 0;

      if (Math.abs(bulge) < 1e-10) {
        path.push(store.worldToScreen(p2));
      } else {
        const arc = bulgeArc(p1, p2, bulge);
        const screenRadius = arc.radius * store.view.zoom;

        let sweep = arc.endAngle - arc.startAngle;
        if (arc.ccw) {
          if (sweep <= 0) sweep += Math.PI * 2;
        } else {
          if (sweep >= 0) sweep -= Math.PI * 2;
        }

        const arcLen = Math.abs(sweep) * screenRadius;
        const steps = Math.max(8, Math.ceil(arcLen / 3));
        const sc = store.worldToScreen(arc.center);

        for (let t = 1; t <= steps; t++) {
          const frac = t / steps;
          const a = arc.startAngle + sweep * frac;
          path.push({
            x: sc.x + screenRadius * Math.cos(a),
            y: sc.y - screenRadius * Math.sin(a),
          });
        }
      }
    }

    let patIdx = 0;
    let patRemain = pattern[0];
    let isDash = true;
    let inDash = false;

    for (let i = 1; i < path.length; i++) {
      const px = path[i - 1].x, py = path[i - 1].y;
      const qx = path[i].x, qy = path[i].y;
      const dx = qx - px, dy = qy - py;
      const segLen = Math.hypot(dx, dy);
      if (segLen < 0.01) continue;

      let pos = 0;
      while (pos < segLen - 0.001) {
        const step = Math.min(patRemain, segLen - pos);
        if (step < 0.001) break;
        const f1 = pos / segLen;
        const f2 = (pos + step) / segLen;

        if (isDash) {
          if (!inDash) {
            ctx.beginPath();
            ctx.moveTo(px + dx * f1, py + dy * f1);
            inDash = true;
          }
          ctx.lineTo(px + dx * f2, py + dy * f2);
        } else if (inDash) {
          ctx.stroke();
          inDash = false;
        }

        pos += step;
        patRemain -= step;
        if (patRemain < 0.01) {
          if (isDash && inDash) {
            ctx.stroke();
            inDash = false;
          }
          patIdx = (patIdx + 1) % pattern.length;
          patRemain = pattern[patIdx];
          isDash = !isDash;
        }
      }
    }

    if (inDash) {
      ctx.stroke();
    }
  }

  private drawText(e: { position: Point; text: string; height: number; rotation: number; color?: string; textStyle?: string }) {
    const ctx = this.ctx;
    const sp = store.worldToScreen(e.position);
    const fontSize = Math.max(8, e.height * store.view.zoom);
    const style = e.textStyle ? store.textStyles.find(s => s.name === e.textStyle) : null;
    const fontFamily = style?.fontFamily || 'monospace';
    const widthFactor = style?.widthFactor || 1;
    const oblique = style?.oblique || 0;
    ctx.save();
    ctx.translate(sp.x, sp.y);
    ctx.rotate(-e.rotation * Math.PI / 180);

    if (store.qtextOn) {
      const approxWidth = e.text.length * fontSize * 0.6 * widthFactor;
      const lines = e.text.split('\n');
      const totalHeight = lines.length * fontSize * 1.2;
      ctx.strokeRect(0, -fontSize * 0.2, approxWidth, totalHeight);
      ctx.restore();
      return;
    }

    if (oblique !== 0) {
      ctx.transform(1, 0, Math.tan(oblique * Math.PI / 180), 1, 0, 0);
    }
    if (widthFactor !== 1) {
      ctx.scale(widthFactor, 1);
    }
    ctx.font = `${fontSize}px "${fontFamily}", ${fontFamily === 'monospace' ? 'monospace' : 'sans-serif'}`;
    ctx.fillStyle = ctx.strokeStyle;
    const lines = e.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 0, i * fontSize * 1.2);
    }
    ctx.restore();
  }

  private drawEllipse(e: { center: Point; majorX: number; majorY: number; ratio: number; startParam: number; endParam: number }) {
    const ctx = this.ctx;
    const sc = store.worldToScreen(e.center);
    const majorLen = Math.hypot(e.majorX, e.majorY) * store.view.zoom;
    const rot = Math.atan2(e.majorY, e.majorX);
    ctx.save();
    ctx.translate(sc.x, sc.y);
    ctx.rotate(-rot);
    ctx.scale(1, e.ratio);
    ctx.beginPath();
    ctx.arc(0, 0, majorLen, -e.endParam, -e.startParam);
    ctx.restore();
    ctx.stroke();
  }

  private drawPoint(e: { position: Point; pdmode: number; pdsize: number }) {
    const ctx = this.ctx;
    const sp = store.worldToScreen(e.position);
    const sz = Math.max(3, e.pdsize * store.view.zoom * 0.5);
    const base = e.pdmode % 4;
    const deco = e.pdmode - base;

    if (deco === 32 || deco === 96) {
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sz, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (deco === 64 || deco === 96) {
      ctx.beginPath();
      ctx.moveTo(sp.x - sz, sp.y - sz); ctx.lineTo(sp.x + sz, sp.y - sz);
      ctx.lineTo(sp.x + sz, sp.y + sz); ctx.lineTo(sp.x - sz, sp.y + sz);
      ctx.closePath();
      ctx.stroke();
    }

    ctx.beginPath();
    if (base === 0 || base === 1) {
      ctx.arc(sp.x, sp.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    } else if (base === 2) {
      ctx.moveTo(sp.x - sz, sp.y); ctx.lineTo(sp.x + sz, sp.y);
      ctx.moveTo(sp.x, sp.y - sz); ctx.lineTo(sp.x, sp.y + sz);
      ctx.stroke();
    } else if (base === 3) {
      ctx.moveTo(sp.x - sz, sp.y - sz); ctx.lineTo(sp.x + sz, sp.y + sz);
      ctx.moveTo(sp.x - sz, sp.y + sz); ctx.lineTo(sp.x + sz, sp.y - sz);
      ctx.stroke();
    }
  }

  private static HATCH_PATTERNS: Record<string, { angles: number[]; spacing: number }> = {
    ANSI31: { angles: [45], spacing: 3 },
    ANSI32: { angles: [45], spacing: 6 },
    ANSI33: { angles: [45], spacing: 2 },
    ANSI34: { angles: [45, -45], spacing: 3 },
    ANSI35: { angles: [45, 0], spacing: 3 },
    ANSI36: { angles: [45, 135], spacing: 4 },
    ANSI37: { angles: [45, -45, 0], spacing: 3 },
    ANSI38: { angles: [45, -45, 0, 90], spacing: 3 },
    CROSS: { angles: [0, 90], spacing: 4 },
    SQUARE: { angles: [0, 90], spacing: 6 },
    HONEY: { angles: [0, 60, 120], spacing: 4 },
    EARTH: { angles: [0, 90, 45, -45], spacing: 5 },
    GRASS: { angles: [90, 45, 135], spacing: 6 },
    DOTS: { angles: [], spacing: 4 },
  };

  private drawHatch(e: { boundaries: Point[][]; patternName: string; patternScale: number; patternAngle: number }) {
    const ctx = this.ctx;
    for (const boundary of e.boundaries) {
      if (boundary.length < 3) continue;
      ctx.beginPath();
      const s0 = store.worldToScreen(boundary[0]);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < boundary.length; i++) {
        const sp = store.worldToScreen(boundary[i]);
        ctx.lineTo(sp.x, sp.y);
      }
      ctx.closePath();
      if (e.patternName === 'SOLID') {
        if (store.fillOn) {
          ctx.fillStyle = ctx.strokeStyle;
          ctx.globalAlpha = 0.3;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.stroke();
      } else {
        ctx.stroke();
        ctx.save();
        ctx.clip();
        const bounds = this.polyBounds(boundary);
        const s1 = store.worldToScreen(bounds.min);
        const s2 = store.worldToScreen(bounds.max);
        const cx = (s1.x + s2.x) / 2, cy = (s1.y + s2.y) / 2;
        const diag = Math.hypot(s2.x - s1.x, s2.y - s1.y);
        const pattern = Renderer.HATCH_PATTERNS[e.patternName];
        const baseSpacing = Math.max(4, (pattern?.spacing || 3) * e.patternScale * store.view.zoom);

        if (e.patternName === 'DOTS') {
          const dotSpacing = baseSpacing;
          ctx.fillStyle = ctx.strokeStyle;
          for (let dx = -diag; dx <= diag; dx += dotSpacing) {
            for (let dy = -diag; dy <= diag; dy += dotSpacing) {
              ctx.beginPath();
              ctx.arc(cx + dx, cy + dy, 1, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        } else {
          const angles = pattern ? pattern.angles : [45];
          for (const lineAngle of angles) {
            const ang = (lineAngle + e.patternAngle) * Math.PI / 180;
            const cos = Math.cos(ang), sin = Math.sin(ang);
            for (let d = -diag; d <= diag; d += baseSpacing) {
              const ox = cx + d * cos, oy = cy + d * sin;
              ctx.beginPath();
              ctx.moveTo(ox - diag * sin, oy + diag * cos);
              ctx.lineTo(ox + diag * sin, oy - diag * cos);
              ctx.stroke();
            }
          }
        }
        ctx.restore();
      }
    }
  }

  private polyBounds(pts: Point[]): { min: Point; max: Point } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
  }

  private drawRegion(e: { outerBoundary: Point[]; holes: Point[][] }) {
    const ctx = this.ctx;
    if (e.outerBoundary.length < 3) return;

    ctx.beginPath();
    const s0 = store.worldToScreen(e.outerBoundary[0]);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < e.outerBoundary.length; i++) {
      const sp = store.worldToScreen(e.outerBoundary[i]);
      ctx.lineTo(sp.x, sp.y);
    }
    ctx.closePath();
    ctx.stroke();

    if (store.fillOn) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.globalAlpha = 0.15;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    for (const hole of e.holes) {
      if (hole.length < 3) continue;
      ctx.beginPath();
      const h0 = store.worldToScreen(hole[0]);
      ctx.moveTo(h0.x, h0.y);
      for (let i = 1; i < hole.length; i++) {
        const hp = store.worldToScreen(hole[i]);
        ctx.lineTo(hp.x, hp.y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  private drawBlockRef(e: Entity & { blockName: string; insertPoint: Point; scaleX: number; scaleY: number; rotation: number }) {
    const blockEnts = store.blockDefs.get(e.blockName);
    if (!blockEnts) {
      const sp = store.worldToScreen(e.insertPoint);
      this.ctx.fillStyle = '#ff00ff';
      this.ctx.font = '10px monospace';
      this.ctx.fillText(`[${e.blockName}]`, sp.x, sp.y);
      return;
    }
    const ctx = this.ctx;
    ctx.save();
    const prevBlockColor = this.parentBlockColor;
    this.parentBlockColor = this.resolveColor(e);
    const sp = store.worldToScreen(e.insertPoint);
    ctx.translate(sp.x, sp.y);
    ctx.rotate(-e.rotation * Math.PI / 180);
    ctx.scale(e.scaleX, e.scaleY);
    ctx.translate(-sp.x, -sp.y);
    for (const sub of blockEnts) {
      this.drawEntity({ ...sub, selected: false } as any);
    }
    this.parentBlockColor = prevBlockColor;
    ctx.restore();

    const br = e as any as BlockRefEntity;
    if (br.attributes && br.attributes.length > 0 && store.attDispMode !== 'off') {
      const defs = store.blockAttribs.get(br.blockName);
      const h = store.currentDimStyle.textHeight;
      let yOff = 0;
      for (const attr of br.attributes) {
        const def = defs?.find(d => d.tag === attr.tag);
        const invisible = def?.invisible ?? false;
        if (store.attDispMode === 'normal' && invisible) continue;
        this.drawText({
          position: { x: br.insertPoint.x, y: br.insertPoint.y - h * 1.5 - yOff },
          text: attr.value,
          height: h,
          rotation: br.rotation,
        });
        yOff += h * 1.5;
      }
    }
  }

  private drawDimension(e: { dimType: string; p1: Point; p2: Point; textPos: Point; textOverride?: string; dimOverrides?: Partial<Omit<DimStyle, 'name'>> }) {
    const ctx = this.ctx;
    const base = store.currentDimStyle;
    const ds = e.dimOverrides ? { ...base, ...e.dimOverrides } : base;
    ctx.strokeStyle = ds.color;
    ctx.fillStyle = ds.color;
    const arrowLen = Math.min(20, ds.arrowSize * store.view.zoom);
    const extGap = ds.extensionOffset;

    if (e.dimType === 'linear') {
      const horizontal = isHorizontalDim(e.p1, e.p2, e.textPos);
      let dimP1: Point, dimP2: Point;
      if (horizontal) {
        dimP1 = { x: e.p1.x, y: e.textPos.y };
        dimP2 = { x: e.p2.x, y: e.textPos.y };
      } else {
        dimP1 = { x: e.textPos.x, y: e.p1.y };
        dimP2 = { x: e.textPos.x, y: e.p2.y };
      }
      this.drawExtLine(e.p1, dimP1, extGap);
      this.drawExtLine(e.p2, dimP2, extGap);
      this.strokeLine(dimP1, dimP2);
      const s1 = store.worldToScreen(dimP1), s2 = store.worldToScreen(dimP2);
      const sa = Math.atan2(s2.y - s1.y, s2.x - s1.x);
      this.drawArrowhead(s1, sa, arrowLen);
      this.drawArrowhead(s2, sa + Math.PI, arrowLen);
      const linearDist = Math.hypot(dimP2.x - dimP1.x, dimP2.y - dimP1.y);
      this.drawDimText(e.textOverride || linearDist.toFixed(ds.precision), { x: (dimP1.x + dimP2.x) / 2, y: (dimP1.y + dimP2.y) / 2 });
    } else if (e.dimType === 'aligned') {
      const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) return;
      const nx = -dy / len, ny = dx / len;
      const mid = { x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 };
      const off = (e.textPos.x - mid.x) * nx + (e.textPos.y - mid.y) * ny;
      const dimP1 = { x: e.p1.x + nx * off, y: e.p1.y + ny * off };
      const dimP2 = { x: e.p2.x + nx * off, y: e.p2.y + ny * off };
      this.drawExtLine(e.p1, dimP1, extGap);
      this.drawExtLine(e.p2, dimP2, extGap);
      this.strokeLine(dimP1, dimP2);
      const s1 = store.worldToScreen(dimP1), s2 = store.worldToScreen(dimP2);
      const sa = Math.atan2(s2.y - s1.y, s2.x - s1.x);
      this.drawArrowhead(s1, sa, arrowLen);
      this.drawArrowhead(s2, sa + Math.PI, arrowLen);
      this.drawDimText(e.textOverride || len.toFixed(ds.precision), { x: (dimP1.x + dimP2.x) / 2, y: (dimP1.y + dimP2.y) / 2 });
    } else if (e.dimType === 'angular') {
      const center = e.textPos;
      const radius = dist(center, e.p1);
      const a1 = angle(center, e.p1);
      const a2 = angle(center, e.p2);
      const sc = store.worldToScreen(center);
      const sr = radius * store.view.zoom;
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, sr, -a2, -a1);
      ctx.stroke();
      const sP1 = store.worldToScreen(e.p1), sP2 = store.worldToScreen(e.p2);
      const sa1 = Math.atan2(sP1.y - sc.y, sP1.x - sc.x);
      const sa2 = Math.atan2(sP2.y - sc.y, sP2.x - sc.x);
      this.drawArrowhead(sP1, sa1 + Math.PI / 2, arrowLen);
      this.drawArrowhead(sP2, sa2 - Math.PI / 2, arrowLen);
      this.drawExtLine(center, e.p1, extGap);
      this.drawExtLine(center, e.p2, extGap);
      const midAng = (a1 + a2) / 2;
      const textWorld = polarPoint(center, radius, midAng);
      let angularText = e.textOverride;
      if (!angularText) {
        let sweep = a2 - a1;
        if (sweep < 0) sweep += 2 * Math.PI;
        angularText = (sweep * 180 / Math.PI).toFixed(ds.precision) + '°';
      }
      this.drawDimText(angularText, textWorld);
    } else {
      this.strokeLine(e.p1, e.p2);
      const s1 = store.worldToScreen(e.p1), s2 = store.worldToScreen(e.p2);
      const sa = Math.atan2(s2.y - s1.y, s2.x - s1.x);
      if (e.dimType === 'radius') {
        this.drawArrowhead(s2, sa, arrowLen);
      } else {
        this.drawArrowhead(s1, sa + Math.PI, arrowLen);
        this.drawArrowhead(s2, sa, arrowLen);
      }
      let fallbackText = e.textOverride;
      if (!fallbackText) {
        const d = dist(e.p1, e.p2);
        if (e.dimType === 'radius') {
          fallbackText = 'R' + d.toFixed(ds.precision);
        } else if (e.dimType === 'diameter') {
          fallbackText = '⌀' + d.toFixed(ds.precision);
        } else {
          fallbackText = d.toFixed(ds.precision);
        }
      }
      this.drawDimText(fallbackText, e.textPos);
    }
  }

  private drawExtLine(origin: Point, dimPt: Point, gap: number) {
    const dx = dimPt.x - origin.x, dy = dimPt.y - origin.y;
    const d = Math.hypot(dx, dy);
    if (d < gap) return;
    const ux = dx / d, uy = dy / d;
    this.strokeLine(
      { x: origin.x + ux * gap, y: origin.y + uy * gap },
      { x: dimPt.x + ux * gap * 0.5, y: dimPt.y + uy * gap * 0.5 }
    );
  }

  private drawDimText(text: string, worldPos: Point) {
    if (!text) return;
    const ds = store.currentDimStyle;
    const sp = store.worldToScreen(worldPos);
    const fontSize = Math.min(24, Math.max(8, ds.textHeight * store.view.zoom));
    this.ctx.font = `${fontSize}px monospace`;
    this.ctx.fillText(text, sp.x - this.ctx.measureText(text).width / 2, sp.y - 4);
  }

  private drawArrowhead(tip: Point, ang: number, len: number) {
    const ctx = this.ctx;
    const hw = len * 0.3;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - len * ca - hw * sa, tip.y - len * sa + hw * ca);
    ctx.lineTo(tip.x - len * ca + hw * sa, tip.y - len * sa - hw * ca);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }
}
