import { store, nextId } from './store';
import { Entity, Point } from './types';

export interface ShelterMeta {
  address: string;
  jibun: string;
  parcelArea: number;
  landUseZone: string;
}

export interface ShelterState {
  active: boolean;
  width: number;
  height: number;
  rotation: number;
  position: Point;
  dragging: boolean;
  meta: ShelterMeta;
}

export const shelterState: ShelterState = {
  active: false,
  width: 5.3,
  height: 6.0,
  rotation: 0,
  position: { x: 0, y: 0 },
  dragging: true,
  meta: { address: '', jibun: '', parcelArea: 0, landUseZone: '' },
};

const AREA_LIMIT = 33;
const SIZE_STEP = 0.1;
const ROTATION_STEP = 15;

export function shelterArea(): number {
  return shelterState.width * shelterState.height;
}

export function shelterOverLimit(): boolean {
  return shelterArea() > AREA_LIMIT;
}

export function shelterCorners(): Point[] {
  const { position, width, height, rotation } = shelterState;
  const hw = width / 2;
  const hh = height / 2;
  const rad = rotation * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const local = [
    { x: -hw, y: -hh },
    { x:  hw, y: -hh },
    { x:  hw, y:  hh },
    { x: -hw, y:  hh },
  ];
  return local.map(c => ({
    x: position.x + c.x * cos - c.y * sin,
    y: position.y + c.x * sin + c.y * cos,
  }));
}

function logSize(log: (msg: string) => void) {
  const area = shelterArea();
  const msg = `쉼터: ${shelterState.width.toFixed(1)}m × ${shelterState.height.toFixed(1)}m = ${area.toFixed(1)}m²`;
  if (shelterOverLimit()) {
    log(`⚠ WARNING: ${msg} (EXCEEDS ${AREA_LIMIT}m² LIMIT!)`);
  } else {
    log(msg);
  }
}

export function handleShelterKey(key: string, log: (msg: string) => void): boolean {
  if (!shelterState.active) return false;

  if (key === 'Escape') { cancelShelter(log); return true; }

  // Q = rotate CCW (+15°), E = rotate CW (-15°)
  if (key === 'q' || key === 'Q') {
    shelterState.rotation = (shelterState.rotation + ROTATION_STEP) % 360;
    log(`쉼터 rotation: ${shelterState.rotation}°`);
    store.emit();
    return true;
  }
  if (key === 'e' || key === 'E') {
    shelterState.rotation = (shelterState.rotation - ROTATION_STEP + 360) % 360;
    log(`쉼터 rotation: ${shelterState.rotation}°`);
    store.emit();
    return true;
  }

  // WASD = resize
  if (key === 'w' || key === 'W') {
    shelterState.height = +(shelterState.height + SIZE_STEP).toFixed(1);
    logSize(log); store.emit(); return true;
  }
  if (key === 's' || key === 'S') {
    shelterState.height = Math.max(0.5, +(shelterState.height - SIZE_STEP).toFixed(1));
    logSize(log); store.emit(); return true;
  }
  if (key === 'a' || key === 'A') {
    shelterState.width = +(shelterState.width + SIZE_STEP).toFixed(1);
    logSize(log); store.emit(); return true;
  }
  if (key === 'd' || key === 'D') {
    shelterState.width = Math.max(0.5, +(shelterState.width - SIZE_STEP).toFixed(1));
    logSize(log); store.emit(); return true;
  }
  return false;
}

export function handleShelterClick(worldPoint: Point, log: (msg: string) => void): boolean {
  if (!shelterState.active) return false;
  if (shelterState.dragging) {
    // Place at current position
    shelterState.position = { ...worldPoint };
    shelterState.dragging = false;
    finalizeShelter(log);
    return true;
  }
  if (pointInShelter(worldPoint)) {
    shelterState.dragging = true;
    store.emit();
    return true;
  }
  return false;
}

export function handleShelterMove(worldPoint: Point) {
  if (!shelterState.active || !shelterState.dragging) return;
  shelterState.position = { ...worldPoint };
}

function pointInShelter(p: Point): boolean {
  const corners = shelterCorners();
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const xi = corners[i].x, yi = corners[i].y;
    const xj = corners[j].x, yj = corners[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function ensureShelterLayer() {
  if (!store.layers.find(l => l.name === '쉼터')) {
    store.layers.push({
      name: '쉼터', color: '#00ff00', visible: true, locked: false,
      frozen: false, current: false, lineweight: 2, plot: true,
    });
  }
}

export function startShelterMode(position: Point, log: (msg: string) => void, meta?: ShelterMeta) {
  shelterState.active = true;
  shelterState.width = 5.3;
  shelterState.height = 6.0;
  shelterState.rotation = 0;
  shelterState.position = { ...position };
  shelterState.dragging = true;
  shelterState.meta = meta || { address: '', jibun: '', parcelArea: 0, landUseZone: '' };
  ensureShelterLayer();
  store.emit();
  log('쉼터 건물배치도 — Click to place, Esc to cancel');
  log('WASD=size(W=H+ S=H- A=W+ D=W-)  Q=rotate CCW  E=rotate CW');
  logSize(log);
}

export function finalizeShelter(log: (msg: string) => void) {
  if (!shelterState.active) return;
  ensureShelterLayer();

  const corners = shelterCorners();
  const area = shelterArea();
  const { position, width, height, rotation } = shelterState;

  store.pushUndo('SHELTER');

  store.entities.push({
    id: nextId(), type: 'polyline', layer: '쉼터',
    color: 'bylayer', lineweight: 2, linetype: 'continuous',
    visible: true, selected: false,
    points: corners, bulges: [0, 0, 0, 0], closed: true,
  } as Entity);

  const rad = rotation * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  store.entities.push({
    id: nextId(), type: 'text', layer: '쉼터',
    color: '#ffff00', lineweight: 1, linetype: 'continuous',
    visible: true, selected: false,
    position: { x: position.x, y: position.y },
    text: '가설건축물', height: 1.2, rotation,
  } as Entity);

  const dimOffsetW = height / 2 + 1.5;
  const dimOffsetH = width / 2 + 1.5;

  store.entities.push({
    id: nextId(), type: 'text', layer: '쉼터',
    color: '#00ffff', lineweight: 1, linetype: 'continuous',
    visible: true, selected: false,
    position: { x: position.x - dimOffsetW * sin, y: position.y + dimOffsetW * cos },
    text: `${(width * 1000).toFixed(0)}`, height: 1.0, rotation,
  } as Entity);

  store.entities.push({
    id: nextId(), type: 'text', layer: '쉼터',
    color: '#00ffff', lineweight: 1, linetype: 'continuous',
    visible: true, selected: false,
    position: { x: position.x + dimOffsetH * cos, y: position.y + dimOffsetH * sin },
    text: `${(height * 1000).toFixed(0)}`, height: 1.0, rotation: rotation + 90,
  } as Entity);

  store.entities.push({
    id: nextId(), type: 'text', layer: '쉼터',
    color: '#ffff00', lineweight: 1, linetype: 'continuous',
    visible: true, selected: false,
    position: { x: position.x - (height / 2 + 3) * sin, y: position.y + (height / 2 + 3) * cos },
    text: `${width.toFixed(1)} × ${height.toFixed(1)}m = ${area.toFixed(1)}m²`,
    height: 0.8, rotation: 0,
  } as Entity);

  drawShelterAnnotations(width, height, area);

  shelterState.active = false;
  shelterState.dragging = false;
  store.emit();

  if (shelterOverLimit()) {
    log(`⚠ 쉼터 placed: ${width.toFixed(1)}m × ${height.toFixed(1)}m = ${area.toFixed(1)}m² — EXCEEDS ${AREA_LIMIT}m² LIMIT!`);
  } else {
    log(`쉼터 placed: ${width.toFixed(1)}m × ${height.toFixed(1)}m = ${area.toFixed(1)}m²`);
  }
}

export function cancelShelter(log: (msg: string) => void) {
  shelterState.active = false;
  shelterState.dragging = false;
  store.emit();
  log('쉼터 placement cancelled');
}

// ── Annotation Drawing (A3 border, 건축개요, 배수계통도, title/scale) ──

function ensureAnnotLayer(name: string, color: string) {
  if (!store.layers.find(l => l.name === name)) {
    store.layers.push({
      name, color, visible: true, locked: false,
      frozen: false, current: false, lineweight: 1, plot: true,
    });
  }
}

function aLine(x1: number, y1: number, x2: number, y2: number, layer: string, color = 'bylayer', lw = 1) {
  store.entities.push({
    id: nextId(), type: 'line', layer, color, lineweight: lw, linetype: 'continuous',
    visible: true, selected: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
  } as Entity);
}

function aText(x: number, y: number, text: string, height: number, layer: string, color = 'bylayer', rotation = 0) {
  store.entities.push({
    id: nextId(), type: 'text', layer, color, lineweight: 1, linetype: 'continuous',
    visible: true, selected: false, position: { x, y }, text, height, rotation,
  } as Entity);
}

function aRect(x1: number, y1: number, x2: number, y2: number, layer: string, color = 'bylayer', lw = 1) {
  store.entities.push({
    id: nextId(), type: 'polyline', layer, color, lineweight: lw, linetype: 'continuous',
    visible: true, selected: false,
    points: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
    bulges: [0, 0, 0, 0], closed: true,
  } as Entity);
}

function drawShelterAnnotations(sw: number, sh: number, area: number) {
  let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
  for (const ent of store.entities) {
    if (ent.layer !== 'CADASTRAL-BDRY' || ent.type !== 'polyline') continue;
    for (const p of (ent as any).points) {
      bMinX = Math.min(bMinX, p.x); bMinY = Math.min(bMinY, p.y);
      bMaxX = Math.max(bMaxX, p.x); bMaxY = Math.max(bMaxY, p.y);
    }
  }
  if (!isFinite(bMinX)) {
    const pos = shelterState.position;
    bMinX = pos.x - 50; bMinY = pos.y - 40;
    bMaxX = pos.x + 50; bMaxY = pos.y + 40;
  }

  const A3W = 168, A3H = 118.8;
  const cx = (bMinX + bMaxX) / 2, cy = (bMinY + bMaxY) / 2;
  const bL = cx - A3W / 2, bB = cy - A3H / 2, bR = cx + A3W / 2, bT = cy + A3H / 2;

  const LB = 'BORDER', LT = '건축개요', LD = '배수계통도';
  ensureAnnotLayer(LB, '#ffffff');
  ensureAnnotLayer(LT, '#ffffff');
  ensureAnnotLayer(LD, '#00ffff');

  // A3 outer border
  aRect(bL, bB, bR, bT, LB, 'bylayer', 3);

  // 건축개요 at top-left
  drawBuildingOverview(bL + 3, bT - 3, sw, sh, area);

  // 배수계통도 at bottom-right
  drawDrainageDiagram(bR - 52, bB + 42);

  // Title "건물배치도" at bottom center
  aText(cx - 15, bB + 7, '건 물 배 치 도', 4.0, LB, '#ffffff');

  // Scale notation
  aText(cx + 10, bB + 6, '축척 : 1/ 400 (A3)', 1.6, LB, '#ffffff');

  // Scale bar
  const sbx = cx + 10, sby = bB + 3.5;
  aLine(sbx, sby, sbx + 20, sby, LB, '#ffffff', 2);
  aLine(sbx, sby - 0.5, sbx, sby + 0.5, LB, '#ffffff');
  aLine(sbx + 10, sby - 0.5, sbx + 10, sby + 0.5, LB, '#ffffff');
  aLine(sbx + 20, sby - 0.5, sbx + 20, sby + 0.5, LB, '#ffffff');
  aText(sbx - 0.5, sby + 0.8, '0', 0.8, LB, '#ffffff');
  aText(sbx + 8.5, sby + 0.8, '10m', 0.8, LB, '#ffffff');
  aText(sbx + 18, sby + 0.8, '20m', 0.8, LB, '#ffffff');

  // North arrow (triangle) at bottom-center left of title
  const nax = cx - 20, nay = bB + 6;
  aLine(nax, nay, nax, nay + 6, LB, '#ffffff', 2);
  aLine(nax - 1.5, nay + 4, nax, nay + 6, LB, '#ffffff', 2);
  aLine(nax + 1.5, nay + 4, nax, nay + 6, LB, '#ffffff', 2);
  aText(nax - 0.5, nay + 7, 'N', 1.5, LB, '#ffffff');

  // Compass rose as entities (upper-right area)
  drawCompassEntities((bMaxX + bR) / 2, bT - 20, 4);
}

function drawCompassEntities(cx: number, cy: number, r: number) {
  const L = 'BORDER';
  store.entities.push({
    id: nextId(), type: 'circle', layer: L, color: '#888888', lineweight: 1,
    linetype: 'continuous', visible: true, selected: false,
    center: { x: cx, y: cy }, radius: r,
  } as Entity);
  // N arrow
  aLine(cx, cy, cx, cy + r, L, '#ff0000', 2);
  aLine(cx - r * 0.25, cy + r * 0.7, cx, cy + r, L, '#ff0000', 2);
  aLine(cx + r * 0.25, cy + r * 0.7, cx, cy + r, L, '#ff0000', 2);
  // S
  aLine(cx, cy, cx, cy - r, L, '#ffffff');
  // E
  aLine(cx, cy, cx + r, cy, L, '#ffffff');
  // W
  aLine(cx, cy, cx - r, cy, L, '#ffffff');
  // Labels
  aText(cx - 0.5, cy + r + 1, 'N', 1.5, L, '#ff4444');
  aText(cx - 0.5, cy - r - 2.5, 'S', 1.2, L, '#ffffff');
  aText(cx + r + 1, cy - 0.5, 'E', 1.2, L, '#ffffff');
  aText(cx - r - 2.5, cy - 0.5, 'W', 1.2, L, '#ffffff');
}

function drawBuildingOverview(ox: number, oy: number, sw: number, sh: number, area: number) {
  const L = '건축개요';
  const rh = 2.4;
  const tw = 65;
  const th = 1.1;
  const R = ox + tw;
  const areaStr = area.toFixed(2);
  const sizeStr = `${sh.toFixed(1)} X ${sw.toFixed(1)}`;
  const m = shelterState.meta;

  // Title
  aText(ox + 2, oy, '건 축 개 요', 2.0, L, '#00ffff');
  aLine(ox, oy + 0.5, R, oy + 0.5, L, '#ff00ff', 2);
  aLine(ox, oy - 2.5, R, oy - 2.5, L, '#ff00ff', 2);

  let y = oy - 3.5;
  const c1 = ox + 11;

  // ── 공사명 ──
  aLine(ox, y, R, y, L);
  aText(ox + 0.5, y - rh + 0.6, '공 사 명', th, L, '#ffff00');
  aLine(c1, y, c1, y - rh, L);
  const projName = m.address ? `${m.jibun || ''} 가설건축물 축조공사` : '가설건축물 축조공사';
  aText(c1 + 0.5, y - rh + 0.6, projName, th, L);
  y -= rh;

  // ── 대지위치 ──
  aLine(ox, y, R, y, L);
  aText(ox + 0.5, y - rh + 0.6, '대 지 위 치', th, L, '#ffff00');
  aLine(c1, y, c1, y - rh, L);
  if (m.address) aText(c1 + 0.5, y - rh + 0.6, m.address, 0.9, L);
  y -= rh;

  // ── 대지면적 (jibun row + 2 blank + 합계) ──
  const daRows = 4;
  aLine(ox, y, R, y, L);
  aText(ox + 0.5, y - rh * 2 + 0.6, '대 지 면 적', th, L, '#ffff00');
  aLine(c1, y, c1, y - rh * daRows, L);
  const c2 = ox + 20, c3 = ox + 46, c4 = ox + 58;
  aLine(c2, y, c2, y - rh * (daRows - 1), L);
  aLine(c3, y, c3, y - rh * (daRows - 1), L);
  aLine(c4, y, c4, y - rh * daRows, L);
  // first row: user's parcel
  if (m.jibun) aText(c1 + 0.5, y - rh + 0.6, m.jibun, th, L);
  aText(c2 + 0.5, y - rh + 0.6, '공부상면적 (등기부등본 참조)', 0.8, L);
  if (m.parcelArea > 0) aText(c3 + 0.5, y - rh + 0.6, m.parcelArea.toFixed(1), th, L);
  aText(c4 + 0.5, y - rh + 0.6, 'm²', th, L);
  y -= rh;
  aLine(c1, y, R, y, L);
  y -= rh;
  aLine(c1, y, R, y, L);
  y -= rh;
  aLine(c1, y, R, y, L);
  // 합계 row
  aText(c2 + 5, y - rh + 0.6, '합 계', th, L, '#ffff00');
  if (m.parcelArea > 0) aText(c3 + 0.5, y - rh + 0.6, m.parcelArea.toFixed(1), th, L);
  aText(c4 + 0.5, y - rh + 0.6, 'm²', th, L);
  y -= rh;

  // ── 지역지구 ──
  aLine(ox, y, R, y, L);
  aText(ox + 0.5, y - rh + 0.6, '지 역 지 구', th, L, '#ffff00');
  aLine(c1, y, c1, y - rh, L);
  aText(c1 + 0.5, y - rh + 0.6, m.landUseZone || '', 0.7, L);
  y -= rh;

  // ── 바닥면적 (header + data + 합계 + empty) ──
  const flRows = 4;
  aLine(ox, y, R, y, L);
  aText(ox + 0.5, y - rh * 2 + 0.6, '바 닥 면 적', th, L, '#ffff00');
  aLine(c1, y, c1, y - rh * flRows, L);
  const fc2 = ox + 18, fc3 = ox + 35, fc4 = ox + 50;
  aLine(fc2, y, fc2, y - rh * flRows, L);
  aLine(fc3, y, fc3, y - rh * flRows, L);
  aLine(fc4, y, fc4, y - rh * flRows, L);
  aText(c1 + 0.5, y - rh + 0.6, '층 별', th, L);
  aText(fc2 + 0.5, y - rh + 0.6, '용 도', th, L);
  aText(fc3 + 0.5, y - rh + 0.6, '산출근거', th, L);
  aText(fc4 + 0.5, y - rh + 0.6, '면 적', th, L);
  y -= rh;
  aLine(c1, y, R, y, L);
  aText(c1 + 1, y - rh + 0.6, '1층', th, L);
  aText(fc2 + 0.5, y - rh + 0.6, '가설건축물(체류형쉼터)', 0.8, L);
  aText(fc3 + 0.5, y - rh + 0.6, sizeStr, th, L);
  aText(fc4 + 0.5, y - rh + 0.6, areaStr, th, L);
  y -= rh;
  aLine(c1, y, R, y, L);
  y -= rh;
  aLine(c1, y, R, y, L);
  aText(fc2 + 2, y - rh + 0.6, '합 계', th, L);
  aText(fc4 + 0.5, y - rh + 0.6, areaStr, th, L);
  y -= rh;

  // ── 건축면적 ──
  aLine(ox, y, R, y, L);
  aText(ox + 0.5, y - rh + 0.6, '건 축 면 적', th, L, '#ffff00');
  aLine(c1, y, c1, y - rh, L);
  aText(c1 + 0.5, y - rh + 0.6, '바닥면적합계와동일', th, L);
  aLine(fc4, y, fc4, y - rh, L);
  aText(fc4 + 0.5, y - rh + 0.6, areaStr, th, L);
  y -= rh;

  // ── 연면적 ──
  aLine(ox, y, R, y, L);
  aText(ox + 0.5, y - rh + 0.6, '연 면 적', th, L, '#ffff00');
  aLine(c1, y, c1, y - rh, L);
  aText(c1 + 0.5, y - rh + 0.6, '바닥면적합계와동일', th, L);
  aLine(fc4, y, fc4, y - rh, L);
  aText(fc4 + 0.5, y - rh + 0.6, areaStr, th, L);
  y -= rh;

  // ── 건폐율 ──
  aLine(ox, y, R, y, L);
  aText(ox + 0.5, y - rh + 0.6, '건 폐 율', th, L, '#ffff00');
  aLine(c1, y, c1, y - rh, L);
  y -= rh;

  // ── 용적율 ──
  aLine(ox, y, R, y, L);
  aText(ox + 0.5, y - rh + 0.6, '용 적 율', th, L, '#ffff00');
  aLine(c1, y, c1, y - rh, L);
  y -= rh;

  // ── 비고 ──
  const notes = [
    '구조: 경량철골조',
    '소화기, 단독경보형감지기 설치.',
    '기존 진입로 포함 없음.',
    '절·성토, 정지, 포장 없음.',
    `기존 가설건축물 20m²농막 취소 후`,
    `가설건축물(체류형쉼터)${area.toFixed(1)}m²로 전환.`,
  ];
  aLine(ox, y, R, y, L);
  aText(ox + 0.5, y - rh + 0.6, '비 고', th, L, '#ffff00');
  aLine(c1, y, c1, y - rh * notes.length, L);
  for (const note of notes) {
    aText(c1 + 0.5, y - rh + 0.6, note, 0.8, L);
    y -= rh;
  }

  // Bottom + left/right borders
  aLine(ox, y, R, y, L);
  aLine(ox, oy + 0.5, ox, y, L);
  aLine(R, oy + 0.5, R, y, L);
}

function drawDrainageDiagram(ox: number, oy: number) {
  const L = '배수계통도';
  const th = 0.9;
  const GRN = '#00ff00';
  const CYN = '#00ffff';
  const YLW = '#ffff00';

  // Title
  aText(ox + 32, oy - 38, '배수계통도', 2.5, L, GRN);

  // Legend box
  aRect(ox + 2, oy - 8, ox + 44, oy, L, CYN);
  aText(ox + 3, oy - 2, 'S : 오수관-양변기,대변기,소변기에 연결', 0.8, L, GRN);
  aText(ox + 3, oy - 4.5, 'D : 생활하수관-세면기,욕조,바닥배수구 및 배수금구에서 연결', 0.65, L, GRN);
  aText(ox + 3, oy - 7, 'V : 통기관', 0.8, L, GRN);

  // Floor levels
  const flR = oy - 14;  // 지붕층 F.L
  const fl1 = oy - 24;  // 1층 F.L
  const grY = oy - 34;  // ground level

  aLine(ox + 20, flR, ox + 48, flR, L, YLW);
  aText(ox + 40, flR + 1, '지붕층 F.L', th, L, GRN);

  aLine(ox + 20, fl1, ox + 48, fl1, L, YLW);
  aText(ox + 42, fl1 + 1, '1층 F.L', th, L, GRN);

  // Main vertical stack
  const px = ox + 22;
  aLine(px, flR + 3, px, grY, L, CYN, 2);

  // 50A V.T.R label
  aText(px + 1, flR + 2, '50A V.T.R', 0.7, L, GRN);

  // Pipe labels S, D, V near roof
  aText(px + 1, flR - 1.5, 'S', 0.7, L, YLW);
  aText(px + 3, flR - 1.5, 'D', 0.7, L, YLW);
  aText(px + 5, flR - 1.5, 'V', 0.7, L, YLW);

  // Horizontal pipe dimensions at roof
  aText(px + 1, flR - 4, '100  100  50', 0.7, L, GRN);

  // Horizontal pipe to fixtures on 1층
  aLine(px, fl1 + 1, ox + 46, fl1 + 1, L, CYN);

  // Bathtub (large rectangle)
  const bx = ox + 30;
  aRect(bx, fl1 - 3, bx + 6, fl1, L, CYN);
  aLine(bx, fl1, bx + 6, fl1 - 3, L, CYN);

  // Sink/washbasin (small rectangle)
  const sx = ox + 37;
  aRect(sx, fl1 - 2.5, sx + 3.5, fl1, L, CYN);
  aLine(sx + 0.5, fl1 - 2, sx + 3, fl1 - 0.5, L, CYN);

  // Toilet (circle + rectangle)
  const tx = ox + 42;
  aRect(tx, fl1 - 3.5, tx + 3, fl1, L, CYN);
  store.entities.push({
    id: nextId(), type: 'circle', layer: L, color: CYN, lineweight: 1,
    linetype: 'continuous', visible: true, selected: false,
    center: { x: tx + 1.5, y: fl1 - 2 }, radius: 1.2,
  } as Entity);

  // Vertical drops from horizontal pipe to fixtures
  aLine(bx + 3, fl1 + 1, bx + 3, fl1, L, CYN);
  aLine(sx + 1.5, fl1 + 1, sx + 1.5, fl1, L, CYN);
  aLine(tx + 1.5, fl1 + 1, tx + 1.5, fl1, L, CYN);

  // Horizontal pipe at ground level
  aLine(ox + 4, grY, px + 6, grY, L, CYN, 2);

  // Pipe dimension labels at ground
  aLine(px, fl1, px, grY, L, CYN, 2);
  aText(px + 1, fl1 - 5, '100  100', 0.7, L, GRN);

  // Vertical pipe from main to 정화조
  aLine(px, grY, px, grY - 5, L, CYN, 2);
  aText(px - 3, grY - 2.5, '100', 0.7, L, GRN);
  aText(px + 1, grY - 2.5, '100', 0.7, L, GRN);

  // 정화조 box with X
  aRect(px - 3, grY - 8, px + 3, grY - 5, L, CYN);
  aLine(px - 3, grY - 8, px + 3, grY - 5, L, CYN);
  aLine(px - 3, grY - 5, px + 3, grY - 8, L, CYN);
  aText(px - 1.5, grY - 9.5, '정화조', 0.9, L, GRN);

  // 시맨홀 box (leftmost)
  const m1x = ox + 4;
  aRect(m1x, grY - 4, m1x + 5, grY, L, CYN);
  aLine(m1x, grY - 4, m1x + 5, grY, L, CYN);
  aLine(m1x, grY, m1x + 5, grY - 4, L, CYN);
  aText(m1x, grY + 1, '시맨홀', 0.9, L, GRN);

  // 오수맨홀 box
  const m2x = ox + 12;
  aRect(m2x, grY - 4, m2x + 5, grY, L, CYN);
  aLine(m2x, grY - 4, m2x + 5, grY, L, CYN);
  aLine(m2x, grY, m2x + 5, grY - 4, L, CYN);
  aText(m2x, grY + 1, '오수맨홀', 0.9, L, GRN);

  // Pipe connections between manholes
  aLine(m1x + 5, grY - 2, m2x, grY - 2, L, CYN);
  aLine(m2x + 5, grY - 2, px, grY - 2, L, CYN);
  aText(m1x + 5.5, grY - 1, '100', 0.7, L, GRN);
  aText(m2x + 5.5, grY - 1, '100', 0.7, L, GRN);

  // Outer border for the diagram
  aRect(ox, oy - 40, ox + 50, oy + 1, L, CYN);
}

// ── Rendering ──

export function renderShelterOverlay(ctx: CanvasRenderingContext2D, w: number, h: number) {
  if (!shelterState.active) return;
  drawShelterRect(ctx);
  drawCompassRose(ctx, w);
  drawAreaInfo(ctx, w, h);
}

function drawCompassRose(ctx: CanvasRenderingContext2D, canvasW: number) {
  const cx = canvasW - 65;
  const cy = 65;
  const r = 30;

  ctx.save();

  ctx.beginPath();
  ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fill();
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // N pointer (red)
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx - 7, cy);
  ctx.lineTo(cx, cy - 8);
  ctx.closePath();
  ctx.fillStyle = '#ff3333';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + 7, cy);
  ctx.lineTo(cx, cy - 8);
  ctx.closePath();
  ctx.fillStyle = '#cc0000';
  ctx.fill();

  // S pointer (white)
  ctx.beginPath();
  ctx.moveTo(cx, cy + r);
  ctx.lineTo(cx - 7, cy);
  ctx.lineTo(cx, cy + 8);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy + r);
  ctx.lineTo(cx + 7, cy);
  ctx.lineTo(cx, cy + 8);
  ctx.closePath();
  ctx.fillStyle = '#cccccc';
  ctx.fill();

  // E pointer
  ctx.beginPath();
  ctx.moveTo(cx + r, cy);
  ctx.lineTo(cx, cy - 7);
  ctx.lineTo(cx + 8, cy);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + r, cy);
  ctx.lineTo(cx, cy + 7);
  ctx.lineTo(cx + 8, cy);
  ctx.closePath();
  ctx.fillStyle = '#cccccc';
  ctx.fill();

  // W pointer
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx, cy - 7);
  ctx.lineTo(cx - 8, cy);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx, cy + 7);
  ctx.lineTo(cx - 8, cy);
  ctx.closePath();
  ctx.fillStyle = '#cccccc';
  ctx.fill();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fillStyle = '#ffff00';
  ctx.fill();

  // Labels
  ctx.font = 'bold 13px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#ff4444';
  ctx.fillText('N', cx, cy - r - 12);
  ctx.fillStyle = '#dddddd';
  ctx.fillText('S', cx, cy + r + 12);
  ctx.fillText('E', cx + r + 13, cy);
  ctx.fillText('W', cx - r - 13, cy);

  // Tick marks for 45° angles
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 0.5;
  for (let a = 45; a < 360; a += 90) {
    const rad = a * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx + (r + 1) * Math.cos(rad), cy - (r + 1) * Math.sin(rad));
    ctx.lineTo(cx + (r + 5) * Math.cos(rad), cy - (r + 5) * Math.sin(rad));
    ctx.stroke();
  }

  ctx.restore();
}

function drawShelterRect(ctx: CanvasRenderingContext2D) {
  const corners = shelterCorners();
  const sc = corners.map(c => store.worldToScreen(c));
  const centerSc = store.worldToScreen(shelterState.position);
  const isOver = shelterOverLimit();

  ctx.save();

  // Fill
  ctx.beginPath();
  ctx.moveTo(sc[0].x, sc[0].y);
  for (let i = 1; i < sc.length; i++) ctx.lineTo(sc[i].x, sc[i].y);
  ctx.closePath();
  ctx.fillStyle = isOver ? 'rgba(255, 50, 50, 0.2)' : 'rgba(0, 255, 0, 0.15)';
  ctx.fill();

  // Outline
  ctx.strokeStyle = isOver ? '#ff3333' : '#00ff00';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Edge normals for dimension label offset
  const bDx = sc[1].x - sc[0].x, bDy = sc[1].y - sc[0].y;
  const bLen = Math.hypot(bDx, bDy) || 1;
  const bNx = -bDy / bLen, bNy = bDx / bLen;

  const rDx = sc[2].x - sc[1].x, rDy = sc[2].y - sc[1].y;
  const rLen = Math.hypot(rDx, rDy) || 1;
  const rNx = -rDy / rLen, rNy = rDx / rLen;

  const wMid = { x: (sc[0].x + sc[1].x) / 2, y: (sc[0].y + sc[1].y) / 2 };
  const hMid = { x: (sc[1].x + sc[2].x) / 2, y: (sc[1].y + sc[2].y) / 2 };

  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#00ffff';

  const off = 16;
  ctx.fillText(`${(shelterState.width * 1000).toFixed(0)}`, wMid.x + bNx * off, wMid.y + bNy * off);
  ctx.fillText(`${(shelterState.height * 1000).toFixed(0)}`, hMid.x + rNx * off, hMid.y + rNy * off);

  // Center label
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#ffff00';
  ctx.fillText('가설건축물', centerSc.x, centerSc.y);

  ctx.restore();
}

function drawAreaInfo(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const area = shelterArea();
  const isOver = shelterOverLimit();
  const pw = 320, ph = 70;
  const px = w - pw - 10, py = h - ph - 30;

  ctx.save();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.strokeStyle = isOver ? '#ff3333' : '#00aa00';
  ctx.lineWidth = 1.5;
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeRect(px, py, pw, ph);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`쉼터: ${shelterState.width.toFixed(1)}m × ${shelterState.height.toFixed(1)}m`, px + 8, py + 6);

  ctx.font = '13px monospace';
  ctx.fillStyle = isOver ? '#ff4444' : '#00ff00';
  ctx.fillText(`면적: ${area.toFixed(1)}m²  /  제한: ${AREA_LIMIT}m²`, px + 8, py + 24);

  if (isOver) {
    ctx.fillStyle = '#ff0000';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(`⚠ 면적 초과! (${(area - AREA_LIMIT).toFixed(1)}m² over)`, px + 8, py + 44);
  } else {
    ctx.fillStyle = '#888888';
    ctx.font = '11px monospace';
    ctx.fillText(`WASD=size Q=CCW E=CW | 각도:${shelterState.rotation}° | Click=place`, px + 8, py + 44);
  }

  ctx.restore();
}
