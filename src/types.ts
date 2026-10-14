export interface Point { x: number; y: number; }

export type EntityType = 'line' | 'circle' | 'arc' | 'polyline' | 'rect' | 'text' | 'ellipse' | 'dimension' | 'point' | 'hatch' | 'blockref' | 'region';

export interface BaseEntity {
  id: string;
  type: EntityType;
  layer: string;
  color: string;
  lineweight: number;
  linetype: string;
  visible: boolean;
  selected: boolean;
}

export interface LineEntity extends BaseEntity {
  type: 'line';
  start: Point;
  end: Point;
}

export interface CircleEntity extends BaseEntity {
  type: 'circle';
  center: Point;
  radius: number;
}

export interface ArcEntity extends BaseEntity {
  type: 'arc';
  center: Point;
  radius: number;
  startAngle: number;
  endAngle: number;
}

export interface PolylineEntity extends BaseEntity {
  type: 'polyline';
  points: Point[];
  bulges: number[];
  closed: boolean;
  fitPoints?: Point[];
}

export interface RectEntity extends BaseEntity {
  type: 'rect';
  corner1: Point;
  corner2: Point;
}

export interface TextEntity extends BaseEntity {
  type: 'text';
  position: Point;
  text: string;
  height: number;
  rotation: number;
  textStyle?: string;
}

export interface EllipseEntity extends BaseEntity {
  type: 'ellipse';
  center: Point;
  majorX: number;
  majorY: number;
  ratio: number;
  startParam: number;
  endParam: number;
}

export interface DimensionEntity extends BaseEntity {
  type: 'dimension';
  dimType: 'linear' | 'aligned' | 'radius' | 'diameter' | 'angular';
  p1: Point;
  p2: Point;
  textPos: Point;
  textOverride?: string;
  dimOverrides?: Partial<Omit<DimStyle, 'name'>>;
}

export interface PointEntity extends BaseEntity {
  type: 'point';
  position: Point;
  pdmode: number;
  pdsize: number;
}

export interface HatchEntity extends BaseEntity {
  type: 'hatch';
  boundaries: Point[][];
  patternName: string;
  patternScale: number;
  patternAngle: number;
}

export interface AttributeDef {
  tag: string;
  prompt: string;
  defaultValue: string;
  invisible: boolean;
}

export interface AttributeValue {
  tag: string;
  value: string;
}

export interface BlockRefEntity extends BaseEntity {
  type: 'blockref';
  blockName: string;
  insertPoint: Point;
  scaleX: number;
  scaleY: number;
  rotation: number;
  attributes?: AttributeValue[];
}

export interface RegionEntity extends BaseEntity {
  type: 'region';
  outerBoundary: Point[];
  holes: Point[][];
}

export interface TextStyle {
  name: string;
  fontFamily: string;
  height: number;
  widthFactor: number;
  oblique: number;
}

export interface DimStyle {
  name: string;
  textHeight: number;
  arrowSize: number;
  extensionOffset: number;
  precision: number;
  color: string;
}

export type Entity = LineEntity | CircleEntity | ArcEntity | PolylineEntity
  | RectEntity | TextEntity | EllipseEntity | DimensionEntity | PointEntity
  | HatchEntity | BlockRefEntity | RegionEntity;

export type SnapMode = 'endpoint' | 'midpoint' | 'center' | 'intersection'
  | 'perpendicular' | 'tangent' | 'quadrant' | 'nearest' | 'grid' | 'none';

export interface SnapResult {
  point: Point;
  mode: SnapMode;
  entityId?: string;
}

export interface Layer {
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
  frozen: boolean;
  current: boolean;
  lineweight: number;
  plot: boolean;
}

export interface ViewState {
  panX: number;
  panY: number;
  zoom: number;
}

export type ToolState = 'idle' | 'line' | 'circle' | 'arc' | 'polyline' | 'rect' | 'text'
  | 'move' | 'copy' | 'rotate' | 'scale' | 'mirror' | 'offset' | 'trim' | 'extend'
  | 'break' | 'fillet' | 'chamfer' | 'select' | 'dimension' | 'erase'
  | 'point' | 'polygon' | 'lengthen' | 'stretch' | 'layer'
  | 'hatch' | 'block' | 'insert' | 'properties' | 'options' | 'group'
  | 'ellipse' | 'array' | 'spline' | 'area' | 'pan' | 'plot' | 'boundary' | 'region';
