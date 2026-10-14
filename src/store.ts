import { Entity, Layer, ViewState, ToolState, SnapMode, Point, DimStyle, TextStyle, AttributeDef } from './types';

let _id = 0;
export function nextId(): string { return `e${++_id}`; }

export interface UndoEntry { entities: Entity[]; label: string; }

class Store {
  entities: Entity[] = [];
  layers: Layer[] = [{ name: '0', color: '#ffffff', visible: true, locked: false, frozen: false, current: true, lineweight: 1, plot: true }];
  view: ViewState = { panX: 0, panY: 0, zoom: 1 };
  tool: ToolState = 'idle';
  snapModes: Set<SnapMode> = new Set(['endpoint', 'midpoint', 'center', 'intersection', 'perpendicular', 'quadrant', 'nearest']);
  orthoOn = false;
  gridOn = true;
  gridSpacing = 10;
  ltScale = 1;
  snapToGrid = false;
  snapOverride: SnapMode | null = null;
  lastPoint: Point = { x: 0, y: 0 };
  lastCommand: string = '';
  unitPrecision = 4;
  unitType: 'decimal' | 'architectural' | 'engineering' | 'fractional' | 'scientific' = 'decimal';
  angleFormat: 'decimal' | 'dms' | 'grads' | 'radians' = 'decimal';
  anglePrecision = 0;
  angleBase = 0;
  angleDirection: 'ccw' | 'cw' = 'ccw';
  coordDisplayMode: 'cartesian' | 'polar' | 'off' = 'cartesian';
  blockDefs: Map<string, Entity[]> = new Map();
  blockAttribs: Map<string, AttributeDef[]> = new Map();
  groups: Map<string, string[]> = new Map();
  dimStyles: DimStyle[] = [{ name: 'Standard', textHeight: 0.08, arrowSize: 0.05, extensionOffset: 0.025, precision: 0, color: '#00ffff' }];
  currentDimStyle: DimStyle = { name: 'Standard', textHeight: 0.08, arrowSize: 0.05, extensionOffset: 0.025, precision: 0, color: '#00ffff' };
  currentColor: string = 'bylayer';
  textStyles: TextStyle[] = [{ name: 'Standard', fontFamily: 'monospace', height: 2.5, widthFactor: 1, oblique: 0 }];
  currentTextStyle: string = 'Standard';
  namedViews: Map<string, ViewState> = new Map();
  drawingLimits: { min: Point; max: Point } = { min: { x: 0, y: 0 }, max: { x: 420, y: 297 } };
  limitsOn = false;
  fillOn = true;
  basePoint: Point = { x: 0, y: 0 };
  pdmode = 3;
  pdsize = 5;
  qtextOn = false;
  attDispMode: 'normal' | 'on' | 'off' = 'normal';
  sessionStart: number = Date.now();
  clipboard: Entity[] = [];
  clipboardBase: Point = { x: 0, y: 0 };
  viewRes = 100;
  aperture = 15;
  isolatedLayers: string[] = [];
  previousSelection: string[] = [];
  hiddenEntityIds: Set<string> = new Set();
  lwDisplay: boolean = false;
  gripsEnabled: boolean = true;
  activeGrip: { entityId: string; point: Point } | null = null;
  hoveredEntityId: string | null = null;
  polarTrackingOn = false;
  polarTrackingAngle = 90;
  mirrText: boolean = true;
  layerStates: Map<string, { layers: Layer[] }> = new Map();
  dwgProps: { title: string; author: string; subject: string; comments: string } = { title: '', author: '', subject: '', comments: '' };

  rasterOverlays: { id: string; layer: string; image: HTMLImageElement; bounds: { minX: number; minY: number; maxX: number; maxY: number } }[] = [];

  // UCS (User Coordinate System)
  ucsOrigin: Point = { x: 0, y: 0 };
  ucsAngle: number = 0;
  savedUCS: Map<string, { origin: Point; angle: number }> = new Map();

  isUCS(): boolean {
    return this.ucsOrigin.x !== 0 || this.ucsOrigin.y !== 0 || this.ucsAngle !== 0;
  }

  wcsToUcs(p: Point): Point {
    const dx = p.x - this.ucsOrigin.x;
    const dy = p.y - this.ucsOrigin.y;
    if (this.ucsAngle === 0) return { x: dx, y: dy };
    const rad = -this.ucsAngle * Math.PI / 180;
    return {
      x: dx * Math.cos(rad) - dy * Math.sin(rad),
      y: dx * Math.sin(rad) + dy * Math.cos(rad),
    };
  }

  ucsToWcs(p: Point): Point {
    const rad = this.ucsAngle * Math.PI / 180;
    const rx = p.x * Math.cos(rad) - p.y * Math.sin(rad);
    const ry = p.x * Math.sin(rad) + p.y * Math.cos(rad);
    return {
      x: rx + this.ucsOrigin.x,
      y: ry + this.ucsOrigin.y,
    };
  }

  private viewStack: ViewState[] = [];

  pushView() {
    this.viewStack.push({ ...this.view });
    if (this.viewStack.length > 20) this.viewStack.shift();
  }

  popView(): ViewState | null {
    return this.viewStack.pop() || null;
  }

  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private listeners: (() => void)[] = [];

  on(fn: () => void) { this.listeners.push(fn); }
  emit() { this.listeners.forEach(fn => fn()); }

  currentLayer(): Layer { return this.layers.find(l => l.current) || this.layers[0]; }

  pushUndo(label: string) {
    this.undoStack.push({ entities: JSON.parse(JSON.stringify(this.entities)), label });
    this.redoStack = [];
    if (this.undoStack.length > 100) this.undoStack.shift();
  }

  undo(): string | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ entities: JSON.parse(JSON.stringify(this.entities)), label: entry.label });
    this.entities = entry.entities;
    this.emit();
    return entry.label;
  }

  redo(): string | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ entities: JSON.parse(JSON.stringify(this.entities)), label: entry.label });
    this.entities = entry.entities;
    this.emit();
    return entry.label;
  }

  addEntity(e: Entity) {
    this.entities.push(e);
    this.emit();
  }

  removeEntity(id: string) {
    this.entities = this.entities.filter(e => e.id !== id);
    this.emit();
  }

  clearSelection() {
    const sel = this.entities.filter(e => e.selected);
    if (sel.length > 0) this.previousSelection = sel.map(e => e.id);
    this.entities.forEach(e => e.selected = false);
    this.emit();
  }

  selectedEntities(): Entity[] {
    return this.entities.filter(e => e.selected);
  }

  worldToScreen(p: Point): Point {
    return {
      x: (p.x - this.view.panX) * this.view.zoom,
      y: -(p.y - this.view.panY) * this.view.zoom,
    };
  }

  screenToWorld(sx: number, sy: number): Point {
    return {
      x: sx / this.view.zoom + this.view.panX,
      y: -(sy / this.view.zoom) + this.view.panY,
    };
  }
}

export const store = new Store();
