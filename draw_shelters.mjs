/**
 * Generate three 체류형쉼터 (<33㎡) floor plans as DXF files.
 * Uses SonCAD backend at http://localhost:3002/api/dxf/export
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'http://localhost:3002/api/dxf/export';

let _id = 0;
function nextId() { return `e${(++_id).toString().padStart(4, '0')}`; }

// ── Entity helpers ──

function base(layer, color) {
  return { id: nextId(), layer, color, lineweight: 1, linetype: 'continuous', visible: true, selected: false };
}

function line(x1, y1, x2, y2, layer = 'WALL', color = '#ffffff') {
  return { ...base(layer, color), type: 'line', start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

function rect(x1, y1, x2, y2, layer = 'WALL', color = '#ffffff') {
  return { ...base(layer, color), type: 'rect', corner1: { x: x1, y: y1 }, corner2: { x: x2, y: y2 } };
}

function pline(pts, closed, layer = 'WALL', color = '#ffffff') {
  return { ...base(layer, color), type: 'polyline', points: pts.map(([x, y]) => ({ x, y })), bulges: pts.map(() => 0), closed };
}

function arc(cx, cy, r, startDeg, endDeg, layer = 'DOOR', color = '#00ff00') {
  return { ...base(layer, color), type: 'arc', center: { x: cx, y: cy }, radius: r,
    startAngle: startDeg * Math.PI / 180, endAngle: endDeg * Math.PI / 180 };
}

function circle(cx, cy, r, layer = 'FIXTURE', color = '#00ffff') {
  return { ...base(layer, color), type: 'circle', center: { x: cx, y: cy }, radius: r };
}

function text(x, y, str, h = 0.15, layer = 'TEXT', color = '#ff00ff') {
  return { ...base(layer, color), type: 'text', position: { x, y }, text: str, height: h, rotation: 0 };
}

function dim(x1, y1, x2, y2, tx, ty, txt, layer = 'DIM', color = '#ff0000') {
  return { ...base(layer, color), type: 'dimension', dimType: 'linear',
    p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, textPos: { x: tx, y: ty }, textOverride: txt };
}

// ── Layers ──

const LAYERS = [
  { name: 'WALL',      color: '#ffffff', visible: true, locked: false, frozen: false, current: true,  lineweight: 2, plot: true },
  { name: 'DOOR',      color: '#00ff00', visible: true, locked: false, frozen: false, current: false, lineweight: 1, plot: true },
  { name: 'FIXTURE',   color: '#00ffff', visible: true, locked: false, frozen: false, current: false, lineweight: 1, plot: true },
  { name: 'FURNITURE', color: '#ffff00', visible: true, locked: false, frozen: false, current: false, lineweight: 1, plot: true },
  { name: 'DIM',       color: '#ff0000', visible: true, locked: false, frozen: false, current: false, lineweight: 1, plot: true },
  { name: 'TEXT',       color: '#ff00ff', visible: true, locked: false, frozen: false, current: false, lineweight: 1, plot: true },
];

// ══════════════════════════════════════════════════════════════════
// Shelter 1: 3.0m × 6.1m narrow layout (shelter1.png)
// ══════════════════════════════════════════════════════════════════

function shelter1(ox = 0, oy = 0) {
  const W = 3.0, H = 6.1;
  const e = [];

  // Outer walls
  e.push(pline([[ox, oy], [ox + W, oy], [ox + W, oy + H], [ox, oy + H]], true));

  // ── Bottom zone: Entrance + Dining (y: 0 → ~1.9) ──
  // Entrance door arc at bottom-left (0.6m from left, opens inward)
  e.push(arc(ox + 0.6, oy, 0.6, 0, 90, 'DOOR', '#00ff00'));
  // Dining table 1.9m × 0.9m, centered
  const tableX = ox + (W - 1.9) / 2;
  e.push(rect(tableX, oy + 0.3, tableX + 1.9, oy + 0.3 + 0.9, 'FURNITURE', '#ffff00'));
  // Round table element (decorative)
  e.push(circle(ox + W / 2, oy + 0.75, 0.15, 'FURNITURE', '#ffff00'));
  e.push(text(ox + W / 2 - 0.3, oy + 0.1, 'DINING', 0.12));

  // ── Partition wall: dining / kitchen at y ≈ 1.5 ──
  const partY1 = oy + 1.5;
  e.push(line(ox, partY1, ox + W, partY1));

  // ── Middle zone: Kitchen (y: 1.5 → 3.5) ──
  // Counter along left wall (1.7m long, 0.6m deep)
  e.push(rect(ox, partY1, ox + 0.6, partY1 + 1.7, 'FIXTURE', '#00ffff'));
  // Counter along right wall (1.043m, from image)
  e.push(rect(ox + W - 0.6, partY1, ox + W, partY1 + 1.043, 'FIXTURE', '#00ffff'));
  // Sink on right counter
  e.push(rect(ox + W - 0.5, partY1 + 0.3, ox + W - 0.15, partY1 + 0.7, 'FIXTURE', '#00ffff'));
  e.push(text(ox + 0.8, partY1 + 0.7, 'KITCHEN', 0.12));

  // ── Partition wall: kitchen / upper at y ≈ 3.5 ──
  const partY2 = oy + 3.5;
  e.push(line(ox, partY2, ox + W, partY2));

  // ── Upper zone: Bathroom + Bedroom (y: 3.5 → 6.1) ──
  // Bathroom partition (right side, 1.0m wide, 1.5m tall from top)
  const bathLeft = ox + W - 1.0;
  const bathBot = oy + H - 1.5;
  e.push(line(bathLeft, oy + H, bathLeft, bathBot)); // vertical
  e.push(line(bathLeft, bathBot, ox + W, bathBot));   // horizontal

  // Bathroom fixtures
  // Toilet (0.4 × 0.35)
  e.push(rect(bathLeft + 0.15, oy + H - 0.5, bathLeft + 0.55, oy + H - 0.15, 'FIXTURE', '#00ffff'));
  // Sink (0.4 × 0.3)
  e.push(rect(bathLeft + 0.15, bathBot + 0.1, bathLeft + 0.55, bathBot + 0.4, 'FIXTURE', '#00ffff'));
  // Shower/tub area marker
  e.push(circle(ox + W - 0.35, oy + H - 0.8, 0.05, 'FIXTURE', '#00ffff'));
  // Bathroom door arc
  e.push(arc(bathLeft, bathBot, 0.6, 0, 90, 'DOOR', '#00ff00'));
  e.push(text(bathLeft + 0.15, oy + H - 1.0, 'BATH', 0.1));

  // Bedroom area (left of bathroom, y: 3.5 → 6.1)
  // Bed 1.2m × 2.0m along left wall
  e.push(rect(ox + 0.1, partY2 + 0.5, ox + 0.1 + 1.2, partY2 + 0.5 + 2.0, 'FURNITURE', '#ffff00'));
  // Closet on left wall (0.6m × 0.844m)
  e.push(rect(ox, partY2 + 0.05, ox + 0.6, partY2 + 0.05 + 0.844, 'FIXTURE', '#00ffff'));
  e.push(text(ox + 0.3, partY2 + 1.5, 'BEDROOM', 0.12));

  // ── Dimensions ──
  // Overall width at bottom
  e.push(dim(ox, oy - 0.3, ox + W, oy - 0.3, ox + W / 2, oy - 0.5, '3,000'));
  // Overall height on left
  e.push(dim(ox - 0.3, oy, ox - 0.3, oy + H, ox - 0.5, oy + H / 2, '6,100'));
  // Top width
  e.push(dim(ox, oy + H + 0.3, ox + 2.6, oy + H + 0.3, ox + 1.3, oy + H + 0.5, '2,600'));

  // Total area label
  const area = (W * H).toFixed(1);
  e.push(text(ox + W / 2 - 0.5, oy - 0.8, `면적: ${area}㎡`, 0.12, 'TEXT', '#ff00ff'));

  return e;
}

// ══════════════════════════════════════════════════════════════════
// Shelter 2: 2.7m × 5.9m three-zone layout (shelter2.png)
// ══════════════════════════════════════════════════════════════════

function shelter2(ox = 0, oy = 0) {
  const W = 2.7, H = 5.9;
  const e = [];

  // Outer walls
  e.push(pline([[ox, oy], [ox + W, oy], [ox + W, oy + H], [ox, oy + H]], true));

  // ── Bottom zone: Kitchen/Living (y: 0 → 2.5) ──
  const kitH = 2.5;
  // Door arc at bottom-left
  e.push(arc(ox, oy, 0.7, 0, 90, 'DOOR', '#00ff00'));
  // Kitchen counter bottom-left (L-shape)
  e.push(pline([[ox, oy + 0.1], [ox + 0.6, oy + 0.1], [ox + 0.6, oy + 1.0], [ox, oy + 1.0]], false, 'FIXTURE', '#00ffff'));
  // Stove/cooktop
  e.push(rect(ox + 0.05, oy + 0.15, ox + 0.55, oy + 0.6, 'FIXTURE', '#00ffff'));
  // Dining table (1.0 × 0.6) with chairs
  e.push(rect(ox + W - 1.2, oy + 0.8, ox + W - 0.2, oy + 1.4, 'FURNITURE', '#ffff00'));
  // Sofa/seating along right wall
  e.push(rect(ox + W - 0.5, oy + 1.5, ox + W, oy + 2.3, 'FURNITURE', '#ffff00'));
  e.push(text(ox + 0.8, oy + 1.8, 'KITCHEN\n/LIVING', 0.12));

  // ── Partition: Kitchen / Bathroom at y = 2.5 ──
  const bathBot = oy + kitH;
  e.push(line(ox, bathBot, ox + W, bathBot));

  // ── Middle zone: Bathroom (y: 2.5 → 3.5, height 1.0m) ──
  const bathH = 1.0;
  // Door arc
  e.push(arc(ox, bathBot, 0.6, 0, 90, 'DOOR', '#00ff00'));
  // Toilet (center)
  e.push(rect(ox + 0.9, bathBot + 0.25, ox + 1.3, bathBot + 0.75, 'FIXTURE', '#00ffff'));
  // Sink (right side)
  e.push(rect(ox + W - 0.7, bathBot + 0.3, ox + W - 0.2, bathBot + 0.65, 'FIXTURE', '#00ffff'));
  // Shower (left side)
  e.push(rect(ox + 0.1, bathBot + 0.15, ox + 0.6, bathBot + 0.85, 'FIXTURE', '#00ffff'));
  e.push(text(ox + 0.7, bathBot + 0.35, 'BATH', 0.1));

  // ── Partition: Bathroom / Bedroom at y = 3.5 ──
  const bedBot = bathBot + bathH;
  e.push(line(ox, bedBot, ox + W, bedBot));

  // ── Top zone: Bedroom (y: 3.5 → 5.9, height 2.4m) ──
  // Bed (1.4 × 2.0)
  e.push(rect(ox + (W - 1.4) / 2, bedBot + 0.2, ox + (W - 1.4) / 2 + 1.4, bedBot + 0.2 + 2.0, 'FURNITURE', '#ffff00'));
  // Closet on right wall
  e.push(rect(ox + W - 0.4, bedBot + 0.1, ox + W, bedBot + 1.2, 'FIXTURE', '#00ffff'));
  // Window symbol on top wall
  e.push(line(ox + 0.5, oy + H, ox + W - 0.5, oy + H, 'DOOR', '#00ff00'));
  e.push(text(ox + 0.8, bedBot + 1.2, 'BEDROOM', 0.12));

  // ── Dimensions ──
  e.push(dim(ox, oy - 0.3, ox + W, oy - 0.3, ox + W / 2, oy - 0.5, '2,700'));
  e.push(dim(ox - 0.3, oy, ox - 0.3, oy + H, ox - 0.5, oy + H / 2, '5,900'));
  // Zone heights on right
  e.push(dim(ox + W + 0.3, oy, ox + W + 0.3, oy + kitH, ox + W + 0.5, oy + kitH / 2, '2,500'));
  e.push(dim(ox + W + 0.3, bathBot, ox + W + 0.3, bedBot, ox + W + 0.5, bathBot + bathH / 2, '1,000'));
  e.push(dim(ox + W + 0.3, bedBot, ox + W + 0.3, oy + H, ox + W + 0.5, bedBot + 1.2, '2,400'));

  const area = (W * H).toFixed(1);
  e.push(text(ox + W / 2 - 0.5, oy - 0.8, `면적: ${area}㎡`, 0.12, 'TEXT', '#ff00ff'));

  return e;
}

// ══════════════════════════════════════════════════════════════════
// Shelter 3: ~6.95m × 3.93m wide layout (shelter3.png)
// Dims: 0.15 + 0.8 + 2.8 + 3.05 + 0.15 = 6.95 wide
//        0.15 + 1.2 + 0.15 + 2.43 = 3.93 tall (but wall-to-wall ~3.78)
// ══════════════════════════════════════════════════════════════════

function shelter3(ox = 0, oy = 0) {
  // Outer dims including wall thickness 0.15
  const W = 6.95, H = 3.93;
  // Inner offsets
  const wt = 0.15; // wall thickness
  const e = [];

  // Outer walls
  e.push(pline([[ox, oy], [ox + W, oy], [ox + W, oy + H], [ox, oy + H]], true));

  // Inner boundary guide (for reference)
  const ix = ox + wt, iy = oy + wt;
  const iw = W - 2 * wt, ih = H - 2 * wt;

  // ── Horizontal partition at y = oy + wt + 2.43 (separating lower rooms from upper) ──
  const midY = iy + 2.43;
  // Partition runs from left inner to about x = ox + wt + 0.8 + 2.8
  const partEndX = ix + 0.8 + 2.8; // = ox + 0.15 + 3.6 = ox + 3.75
  e.push(line(ix, midY, partEndX, midY));
  // Continue partition as thinner wall from partEndX across remainder (for Cozinha/Sala boundary)
  // Actually from image, the partition goes all the way
  e.push(line(partEndX, midY, ox + W - wt, midY));

  // ── Vertical partitions ──
  // Left partition: separates QUARTO from BANHO/A.S., at x = ix + 0.8 (from bottom to midY)
  // Actually this is a narrow space. From image: 0.8m is the door/entry zone width
  // Vertical wall at x = ix + 0.8, from midY to top
  const vp1 = ix + 0.8;
  e.push(line(vp1, midY, vp1, oy + H - wt));

  // Another vertical: separates BANHO from A.S., at about x = vp1 + 1.2
  const vp2 = vp1 + 1.2;
  e.push(line(vp2, midY, vp2, oy + H - wt));

  // Vertical partition between left (QUARTO/BANHO) and right (SALA/COZINHA)
  // At x ≈ ox + 0.15 + 0.8 + 2.8 = ox + 3.75
  e.push(line(partEndX, oy + wt, partEndX, midY));

  // ── QUARTO (Bedroom) — bottom-left: ix to partEndX, iy to midY ──
  // Bed (1.4m × 2.0m)
  e.push(rect(ix + 0.8, iy + 0.2, ix + 0.8 + 2.0, iy + 0.2 + 1.4, 'FURNITURE', '#ffff00'));
  // Entry door arc at bottom-left
  e.push(arc(ix, iy, 0.7, 0, 90, 'DOOR', '#00ff00'));
  e.push(text(ix + 1.5, iy + 1.0, 'QUARTO', 0.15));

  // ── BANHO (Bathroom) — top-left: vp1 to vp2, midY to top ──
  // Toilet
  e.push(rect(vp1 + 0.15, midY + 0.3, vp1 + 0.55, midY + 0.7, 'FIXTURE', '#00ffff'));
  // Sink
  e.push(circle(vp1 + 0.6, oy + H - wt - 0.3, 0.15, 'FIXTURE', '#00ffff'));
  // Shower area
  e.push(rect(vp1 + 0.8, midY + wt, vp2 - 0.05, oy + H - wt - 0.05, 'FIXTURE', '#00ffff'));
  // Door arc
  e.push(arc(vp1, midY, 0.6, 270, 360, 'DOOR', '#00ff00'));
  e.push(text(vp1 + 0.2, midY + 0.5, 'BANHO', 0.1));

  // ── A.S. (Service area) — top-center: vp2 to partEndX, midY to top ──
  // Washing machine (0.6 × 0.6)
  e.push(rect(vp2 + 0.2, midY + 0.15, vp2 + 0.8, midY + 0.75, 'FIXTURE', '#00ffff'));
  e.push(text(vp2 + 0.3, oy + H - wt - 0.3, 'A.S.', 0.1));

  // ── COZINHA (Kitchen) — top-right: partEndX to right wall, midY to top ──
  // Kitchen counter along top wall (L-shape)
  e.push(rect(partEndX + wt, oy + H - wt - 0.5, ox + W - wt, oy + H - wt, 'FIXTURE', '#00ffff'));
  // Sink
  e.push(rect(partEndX + 0.5, oy + H - wt - 0.45, partEndX + 1.0, oy + H - wt - 0.1, 'FIXTURE', '#00ffff'));
  // Stove
  e.push(rect(ox + W - wt - 0.7, oy + H - wt - 0.45, ox + W - wt - 0.15, oy + H - wt - 0.1, 'FIXTURE', '#00ffff'));
  // Fridge along right wall
  e.push(rect(ox + W - wt - 0.6, midY + wt, ox + W - wt, midY + wt + 0.7, 'FIXTURE', '#00ffff'));
  e.push(text(partEndX + 1.2, midY + 0.5, 'COZINHA', 0.12));

  // ── SALA (Living room) — bottom-right: partEndX to right wall, iy to midY ──
  // Sofa (1.8 × 0.7) along right wall
  e.push(rect(ox + W - wt - 0.7, iy + 0.3, ox + W - wt, iy + 0.3 + 1.8, 'FURNITURE', '#ffff00'));
  // Coffee table (0.8 × 0.5)
  e.push(rect(partEndX + 0.8, iy + 0.8, partEndX + 0.8 + 0.8, iy + 0.8 + 0.5, 'FURNITURE', '#ffff00'));
  // Entry door at bottom-right
  e.push(arc(ox + W - wt, iy, 0.8, 90, 180, 'DOOR', '#00ff00'));
  e.push(text(partEndX + 1.0, iy + 1.5, 'SALA', 0.15));

  // ── Dimensions ──
  // Overall width
  e.push(dim(ox, oy - 0.3, ox + W, oy - 0.3, ox + W / 2, oy - 0.5, '6,950'));
  // Overall height
  e.push(dim(ox - 0.3, oy, ox - 0.3, oy + H, ox - 0.5, oy + H / 2, '3,930'));
  // Top zone widths
  e.push(dim(ox, oy + H + 0.3, ox + wt, oy + H + 0.3, ox + wt / 2, oy + H + 0.5, '150'));
  e.push(dim(ox + wt, oy + H + 0.3, ox + wt + 0.8, oy + H + 0.3, ox + wt + 0.4, oy + H + 0.5, '800'));
  e.push(dim(ox + wt + 0.8, oy + H + 0.3, ox + wt + 0.8 + 2.8, oy + H + 0.3, ox + wt + 0.8 + 1.4, oy + H + 0.5, '2,800'));
  e.push(dim(ox + wt + 3.6, oy + H + 0.3, ox + wt + 3.6 + 3.05, oy + H + 0.3, ox + wt + 3.6 + 1.5, oy + H + 0.5, '3,050'));

  const area = (W * H).toFixed(1);
  e.push(text(ox + W / 2 - 0.5, oy - 0.8, `면적: ${area}㎡ (<33㎡)`, 0.12, 'TEXT', '#ff00ff'));

  return e;
}

// ── Export a shelter to DXF ──

async function exportDXF(entities, filename) {
  const payload = { entities, layers: LAYERS, filename };
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`Error exporting ${filename}: ${res.status} ${await res.text()}`);
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const outPath = path.join(__dirname, 'shelters', filename);
  fs.writeFileSync(outPath, buf);
  console.log(`✓ ${filename} → ${outPath} (${entities.length} entities, ${buf.length} bytes)`);
}

// ── Main ──

async function main() {
  console.log('Generating 체류형쉼터 floor plans...\n');

  _id = 0;
  const s1 = shelter1(0, 0);
  await exportDXF(s1, 'shelter1.dxf');

  _id = 1000;
  const s2 = shelter2(10, 0);
  await exportDXF(s2, 'shelter2.dxf');

  _id = 2000;
  const s3 = shelter3(20, 0);
  await exportDXF(s3, 'shelter3.dxf');

  // Also export all three together
  _id = 0;
  const all = [...shelter1(0, 0)];
  _id = 1000;
  all.push(...shelter2(10, 0));
  _id = 2000;
  all.push(...shelter3(22, 0));
  await exportDXF(all, 'all_shelters.dxf');

  console.log('\nDone!');
}

main().catch(console.error);
