import { Renderer } from './renderer';
import { createCommandEngine, zoomExtents } from './commands/index';
import { store } from './store';
import { findSnap } from './snap';
import { entityBounds, pointOnEntity as pointOnEntityCheck, getGripPoints, moveGrip, dist } from './geometry';
import { Point, Entity } from './types';
import { openCadastralDialog } from './cadastral';
import { shelterState, handleShelterKey, handleShelterClick, handleShelterMove } from './shelter';

const canvas = document.getElementById('cad-canvas') as HTMLCanvasElement;
const cmdInput = document.getElementById('cmd-input') as HTMLInputElement;
const cmdHistory = document.getElementById('cmd-history') as HTMLDivElement;
const coordDisplay = document.getElementById('coord-display') as HTMLSpanElement;
const snapDisplay = document.getElementById('snap-display') as HTMLSpanElement;
const orthoDisplay = document.getElementById('ortho-display') as HTMLSpanElement;
const gridDisplay = document.getElementById('grid-display') as HTMLSpanElement;
const gridSnapDisplay = document.getElementById('gridsnap-display') as HTMLSpanElement;
const polarDisplay = document.getElementById('polar-display') as HTMLSpanElement;
const lwtToggle = document.getElementById('lwt-toggle') as HTMLSpanElement;
const layerDisplay = document.getElementById('layer-display') as HTMLSpanElement;
const contextMenu = document.getElementById('context-menu') as HTMLDivElement;
const menubar = document.getElementById('menubar') as HTMLDivElement;

const renderer = new Renderer(canvas);

function appendHistory(msg: string) {
  const line = document.createElement('div');
  line.textContent = msg;
  cmdHistory.appendChild(line);
  cmdHistory.scrollTop = cmdHistory.scrollHeight;
}

function promptFn(msg: string) {
  appendHistory(msg);
}

function inputFn(prompt: string, _handler: (input: string) => boolean) {
  cmdInput.placeholder = prompt;
}

const engine = createCommandEngine(renderer, promptFn, inputFn);

// === CANVAS MOUSE HANDLING ===

let isPanning = false;
let panStart = { x: 0, y: 0 };
let panViewStart = { panX: 0, panY: 0 };

let isPanningCmd = false;

let isDraggingSelBox = false;
let selBoxStart: Point = { x: 0, y: 0 };
const SEL_BOX_THRESHOLD = 5;

let gripEdit: { entity: Entity; gripIndex: number; origin: Point } | null = null;

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const world = store.screenToWorld(sx, sy);

  let constrained = world;
  if (store.orthoOn && engine.isActive) {
    constrained = applyOrtho(world);
  }

  if (store.polarTrackingOn && engine.isActive && !store.orthoOn) {
    const base = store.lastPoint;
    const dx = constrained.x - base.x;
    const dy = constrained.y - base.y;
    const cursorAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    const increment = store.polarTrackingAngle;
    const tolerance = 5;
    let bestAngle = -1;
    let bestDiff = tolerance;
    for (let a = 0; a < 360; a += increment) {
      let diff = Math.abs(cursorAngle - a);
      if (diff > 180) diff = 360 - diff;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestAngle = a;
      }
    }
    if (bestAngle >= 0) {
      const d = Math.hypot(dx, dy);
      const rad = bestAngle * Math.PI / 180;
      const projDist = dx * Math.cos(rad) + dy * Math.sin(rad);
      constrained = {
        x: base.x + projDist * Math.cos(rad),
        y: base.y + projDist * Math.sin(rad),
      };
      renderer.polarTrackLine = {
        from: base,
        to: constrained,
        angle: bestAngle,
        distance: Math.abs(projDist),
      };
    } else {
      renderer.polarTrackLine = null;
    }
  } else {
    renderer.polarTrackLine = null;
  }

  const snap = findSnap(constrained, { x: sx, y: sy });
  renderer.snapResult = snap;
  renderer.cursorWorld = snap.point;

  if (store.coordDisplayMode === 'cartesian') {
    const p = store.unitPrecision;
    const ucs = store.wcsToUcs(snap.point);
    coordDisplay.textContent = `${ucs.x.toFixed(p)}, ${ucs.y.toFixed(p)}, ${'0'.padEnd(p + 2, p > 0 ? '0' : '')}`;
  } else if (store.coordDisplayMode === 'polar') {
    const base = store.wcsToUcs(store.lastPoint);
    const cur = store.wcsToUcs(snap.point);
    const dx = cur.x - base.x, dy = cur.y - base.y;
    const d = Math.hypot(dx, dy);
    const a = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    coordDisplay.textContent = `${d.toFixed(store.unitPrecision)}<${a.toFixed(1)}°`;
  } else {
    coordDisplay.textContent = '';
  }

  if (isPanning || isPanningCmd) {
    const dx = (e.clientX - panStart.x) / store.view.zoom;
    const dy = (e.clientY - panStart.y) / store.view.zoom;
    store.view.panX = panViewStart.panX - dx;
    store.view.panY = panViewStart.panY + dy;
  }

  if (isDraggingSelBox) {
    renderer.selectionBox = { p1: selBoxStart, p2: snap.point };
  }

  if (gripEdit) {
    renderer.gripRubberBand = { start: gripEdit.origin, end: snap.point };
  }

  if (!engine.isActive && !isPanning && !isPanningCmd && !isDraggingSelBox && !gripEdit) {
    const hoverTol = 10 / store.view.zoom;
    let hoverHit: Entity | null = null;
    for (let i = store.entities.length - 1; i >= 0; i--) {
      const ent = store.entities[i];
      if (!ent.visible || ent.selected) continue;
      if (store.hiddenEntityIds.has(ent.id)) continue;
      const eLayer = store.layers.find(l => l.name === ent.layer);
      if (eLayer && eLayer.frozen) continue;
      if (pointOnEntityCheck(snap.point, ent, hoverTol)) {
        hoverHit = ent;
        break;
      }
    }
    store.hoveredEntityId = hoverHit ? hoverHit.id : null;
  } else {
    store.hoveredEntityId = null;
  }

  handleShelterMove(snap.point);
  engine.handleMove(snap.point);
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY };
    panViewStart = { panX: store.view.panX, panY: store.view.panY };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
  if (e.button === 0 && store.tool === 'pan') {
    isPanningCmd = true;
    panStart = { x: e.clientX, y: e.clientY };
    panViewStart = { panX: store.view.panX, panY: store.view.panY };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
  if (e.button === 0) {
    store.hoveredEntityId = null;
    const snap = renderer.snapResult;
    const pt = snap ? snap.point : renderer.cursorWorld;

    if (shelterState.active) {
      handleShelterClick(pt, promptFn);
      cmdInput.focus();
      return;
    }

    if (gripEdit) {
      store.pushUndo('GRIP');
      moveGrip(gripEdit.entity, gripEdit.gripIndex, pt);
      store.emit();
      gripEdit = null;
      renderer.hotGrip = null;
      renderer.gripRubberBand = null;
      promptFn('');
      cmdInput.focus();
      return;
    }

    if (!engine.isActive) {
      const gripTol = 8 / store.view.zoom;
      for (const ent of store.entities) {
        if (!ent.visible || !ent.selected) continue;
        const grips = getGripPoints(ent);
        for (let gi = 0; gi < grips.length; gi++) {
          if (dist(pt, grips[gi]) <= gripTol) {
            gripEdit = { entity: ent, gripIndex: gi, origin: grips[gi] };
            renderer.hotGrip = { entityId: ent.id, gripIndex: gi };
            promptFn('** STRETCH **  Specify stretch point:');
            cmdInput.focus();
            return;
          }
        }
      }

      const tol = 10 / store.view.zoom;
      let hit: Entity | null = null;
      for (const ent of store.entities) {
        if (ent.visible && pointOnEntityCheck(pt, ent, tol)) {
          hit = ent; break;
        }
      }
      if (hit) {
        if (!e.shiftKey) store.clearSelection();
        hit.selected = !hit.selected;
        store.emit();
        const count = store.selectedEntities().length;
        if (count > 0) promptFn(`${count} found`);
      } else {
        isDraggingSelBox = true;
        selBoxStart = pt;
        store.clearSelection();
        store.emit();
      }
    } else {
      engine.handleClick(pt);
    }
    cmdInput.focus();
  }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY);
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 1) {
    isPanning = false;
    canvas.style.cursor = 'none';
  }
  if (e.button === 0 && isPanningCmd) {
    isPanningCmd = false;
    canvas.style.cursor = store.tool === 'pan' ? 'grab' : 'none';
  }
  if (e.button === 0 && isDraggingSelBox) {
    isDraggingSelBox = false;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const endWorld = store.screenToWorld(sx, sy);
    const s1 = store.worldToScreen(selBoxStart);
    const s2 = store.worldToScreen(endWorld);
    const screenDist = Math.hypot(s2.x - s1.x, s2.y - s1.y);

    if (screenDist > SEL_BOX_THRESHOLD) {
      const leftToRight = s2.x > s1.x;
      const boxMinX = Math.min(selBoxStart.x, endWorld.x);
      const boxMaxX = Math.max(selBoxStart.x, endWorld.x);
      const boxMinY = Math.min(selBoxStart.y, endWorld.y);
      const boxMaxY = Math.max(selBoxStart.y, endWorld.y);

      for (const ent of store.entities) {
        if (!ent.visible) continue;
        const b = entityBounds(ent);
        if (!b) continue;
        if (leftToRight) {
          if (b.min.x >= boxMinX && b.max.x <= boxMaxX &&
              b.min.y >= boxMinY && b.max.y <= boxMaxY) {
            ent.selected = true;
          }
        } else {
          if (b.max.x >= boxMinX && b.min.x <= boxMaxX &&
              b.max.y >= boxMinY && b.min.y <= boxMaxY) {
            ent.selected = true;
          }
        }
      }
      const count = store.selectedEntities().length;
      if (count > 0) promptFn(`${count} found`);
      store.emit();
    }
    renderer.selectionBox = null;
  }
  cmdInput.focus();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const worldBefore = store.screenToWorld(sx, sy);

  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  store.view.zoom *= factor;
  store.view.zoom = Math.max(0.01, Math.min(1000, store.view.zoom));

  const worldAfter = store.screenToWorld(sx, sy);
  store.view.panX -= worldAfter.x - worldBefore.x;
  store.view.panY -= worldAfter.y - worldBefore.y;
}, { passive: false });

// === COMMAND HISTORY (Up/Down arrows) ===

const cmdHistoryList: string[] = [];
let cmdHistoryIdx = -1;

// === COMMAND LINE ===

function submitCommand() {
  const val = cmdInput.value;
  cmdInput.value = '';

  if (gripEdit) {
    if (val.trim() === '') {
      store.pushUndo('GRIP');
      moveGrip(gripEdit.entity, gripEdit.gripIndex, renderer.cursorWorld);
      store.emit();
      gripEdit = null;
      renderer.hotGrip = null;
      renderer.gripRubberBand = null;
      cmdInput.placeholder = 'Command:';
      return;
    }
    const coordMatch = val.match(/^(-?[\d.]+)\s*,\s*(-?[\d.]+)$/);
    if (coordMatch) {
      const pt = { x: parseFloat(coordMatch[1]), y: parseFloat(coordMatch[2]) };
      store.pushUndo('GRIP');
      moveGrip(gripEdit.entity, gripEdit.gripIndex, pt);
      store.emit();
      gripEdit = null;
      renderer.hotGrip = null;
      renderer.gripRubberBand = null;
      cmdInput.placeholder = 'Command:';
      return;
    }
    const relMatch = val.match(/^@(-?[\d.]+)\s*,\s*(-?[\d.]+)$/);
    if (relMatch) {
      const pt = {
        x: gripEdit.origin.x + parseFloat(relMatch[1]),
        y: gripEdit.origin.y + parseFloat(relMatch[2]),
      };
      store.pushUndo('GRIP');
      moveGrip(gripEdit.entity, gripEdit.gripIndex, pt);
      store.emit();
      gripEdit = null;
      renderer.hotGrip = null;
      renderer.gripRubberBand = null;
      cmdInput.placeholder = 'Command:';
      return;
    }
    promptFn('Invalid point. Specify stretch point or press Escape:');
    return;
  }

  if (val.trim()) {
    appendHistory(`Command: ${val}`);
    cmdHistoryList.push(val);
    if (cmdHistoryList.length > 50) cmdHistoryList.shift();
  }
  cmdHistoryIdx = -1;
  engine.handleInput(val);
  cmdInput.placeholder = 'Command:';
}

cmdInput.addEventListener('keydown', (e) => {
  if (shelterState.active) {
    if (handleShelterKey(e.key, promptFn)) {
      e.preventDefault();
      cmdInput.value = '';
      return;
    }
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (cmdHistoryList.length === 0) return;
    if (cmdHistoryIdx === -1) cmdHistoryIdx = cmdHistoryList.length;
    if (cmdHistoryIdx > 0) {
      cmdHistoryIdx--;
      cmdInput.value = cmdHistoryList[cmdHistoryIdx];
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (cmdHistoryIdx === -1) return;
    if (cmdHistoryIdx < cmdHistoryList.length - 1) {
      cmdHistoryIdx++;
      cmdInput.value = cmdHistoryList[cmdHistoryIdx];
    } else {
      cmdHistoryIdx = -1;
      cmdInput.value = '';
    }
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    submitCommand();
  } else if (e.key === ' ' && !cmdInput.value.includes(',') && !cmdInput.value.includes('@') && !cmdInput.value.includes('<')) {
    e.preventDefault();
    submitCommand();
  } else if (e.key === 'Escape') {
    if (contextMenu.classList.contains('open')) { contextMenu.classList.remove('open'); return; }
    closeAllMenus();
    if (gripEdit) {
      gripEdit = null;
      renderer.hotGrip = null;
      renderer.gripRubberBand = null;
      appendHistory('*Cancel*');
      cmdInput.value = '';
      cmdInput.placeholder = 'Command:';
      return;
    }
    engine.cancel();
    appendHistory('*Cancel*');
    cmdInput.value = '';
    cmdInput.placeholder = 'Command:';
  }
});

// Global keyboard
document.addEventListener('keydown', (e) => {
  if (shelterState.active && document.activeElement !== cmdInput) {
    if (handleShelterKey(e.key, promptFn)) {
      e.preventDefault();
      return;
    }
  }

  if (e.key === 'Delete' && !engine.isActive) {
    const sel = store.selectedEntities();
    if (sel.length > 0) {
      e.preventDefault();
      store.pushUndo('ERASE');
      for (const ent of sel) store.removeEntity(ent.id);
      store.emit();
      appendHistory(`${sel.length} object(s) erased`);
      cmdInput.focus();
      return;
    }
  }

  if (e.ctrlKey && e.key === 'c') {
    const sel = store.selectedEntities();
    if (sel.length > 0) {
      e.preventDefault();
      store.clipboard = JSON.parse(JSON.stringify(sel));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const ent of sel) {
        const b = entityBounds(ent);
        if (b) { minX = Math.min(minX, b.min.x); minY = Math.min(minY, b.min.y); maxX = Math.max(maxX, b.max.x); maxY = Math.max(maxY, b.max.y); }
      }
      store.clipboardBase = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      appendHistory(`${sel.length} object(s) copied to clipboard`);
      return;
    }
  }

  if (e.ctrlKey && e.key === 'v') {
    if (store.clipboard.length > 0) {
      e.preventDefault();
      engine.handleInput('PASTECLIP');
      cmdInput.focus();
      return;
    }
  }

  if (e.ctrlKey && e.key === 'z') { e.preventDefault(); engine.handleInput('UNDO'); return; }
  if (e.ctrlKey && e.key === 'y') { e.preventDefault(); engine.handleInput('REDO'); return; }

  if (e.ctrlKey && e.key === 'x') {
    const sel = store.selectedEntities();
    if (sel.length > 0) {
      e.preventDefault();
      store.clipboard = JSON.parse(JSON.stringify(sel));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const ent of sel) {
        const b = entityBounds(ent);
        if (b) { minX = Math.min(minX, b.min.x); minY = Math.min(minY, b.min.y); maxX = Math.max(maxX, b.max.x); maxY = Math.max(maxY, b.max.y); }
      }
      store.clipboardBase = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      store.pushUndo('CUTCLIP');
      for (const ent of sel) store.removeEntity(ent.id);
      store.emit();
      appendHistory(`${sel.length} object(s) cut to clipboard`);
      cmdInput.focus();
      return;
    }
  }

  // Don't intercept if focused on a dialog input
  const ae = document.activeElement;
  if (ae && ae !== cmdInput && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) {
    if (e.key === 'Escape') {
      const overlay = document.getElementById('cloud-overlay');
      if (overlay?.classList.contains('open')) { overlay.classList.remove('open'); }
    }
    return;
  }

  if (document.activeElement === cmdInput) {
    if (e.key === 'F1') { e.preventDefault(); showHelp(); return; }
    if (e.key === 'F3') { e.preventDefault(); toggleOsnap(); return; }
    if (e.key === 'F6') { e.preventDefault(); toggleCoordDisplay(); return; }
    if (e.key === 'F7') { e.preventDefault(); engine.handleInput('GRID'); return; }
    if (e.key === 'F8') { e.preventDefault(); engine.handleInput('ORTHO'); return; }
    if (e.key === 'F9') { e.preventDefault(); toggleGridSnap(); return; }
    if (e.key === 'F10') { e.preventDefault(); togglePolarTracking(); return; }
    return;
  }

  if (e.key === 'Escape') {
    if (contextMenu.classList.contains('open')) { contextMenu.classList.remove('open'); return; }
    closeAllMenus();
    if (gripEdit) {
      gripEdit = null;
      renderer.hotGrip = null;
      renderer.gripRubberBand = null;
      appendHistory('*Cancel*');
      return;
    }
    engine.cancel();
    appendHistory('*Cancel*');
    return;
  }

  if (e.key === 'F1') { e.preventDefault(); showHelp(); return; }
  if (e.key === 'F3') { e.preventDefault(); toggleOsnap(); return; }
  if (e.key === 'F6') { e.preventDefault(); toggleCoordDisplay(); return; }
  if (e.key === 'F7') { e.preventDefault(); engine.handleInput('GRID'); return; }
  if (e.key === 'F8') { e.preventDefault(); engine.handleInput('ORTHO'); return; }
  if (e.key === 'F9') { e.preventDefault(); toggleGridSnap(); return; }
  if (e.key === 'F10') { e.preventDefault(); togglePolarTracking(); return; }

  if (e.key === 'Enter') {
    e.preventDefault();
    cmdInput.focus();
    submitCommand();
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    cmdInput.focus();
    submitCommand();
    return;
  }

  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    cmdInput.focus();
    cmdInput.value += e.key;
    e.preventDefault();
  }
});

// === STATUS BAR TOGGLES ===

snapDisplay.addEventListener('click', () => toggleOsnap());
orthoDisplay.addEventListener('click', () => { engine.handleInput('ORTHO'); });
gridDisplay.addEventListener('click', () => { engine.handleInput('GRID'); });
gridSnapDisplay.addEventListener('click', () => toggleGridSnap());
if (polarDisplay) polarDisplay.addEventListener('click', () => togglePolarTracking());
lwtToggle.addEventListener('click', () => { store.lwDisplay = !store.lwDisplay; store.emit(); });

// === RENDER LOOP ===

function frame() {
  renderer.resize();
  renderer.render();

  snapDisplay.textContent = store.snapModes.size > 0 ? 'OSNAP' : 'osnap';
  snapDisplay.className = store.snapModes.size > 0 ? 'status-toggle active' : 'status-toggle';
  orthoDisplay.textContent = store.orthoOn ? 'ORTHO' : 'ortho';
  orthoDisplay.className = store.orthoOn ? 'status-toggle active' : 'status-toggle';
  gridDisplay.textContent = store.gridOn ? 'GRID' : 'grid';
  gridDisplay.className = store.gridOn ? 'status-toggle active' : 'status-toggle';
  gridSnapDisplay.textContent = store.snapToGrid ? 'SNAP' : 'snap';
  gridSnapDisplay.className = store.snapToGrid ? 'status-toggle active' : 'status-toggle';
  if (polarDisplay) {
    polarDisplay.textContent = store.polarTrackingOn ? 'POLAR' : 'polar';
    polarDisplay.className = store.polarTrackingOn ? 'status-toggle active' : 'status-toggle';
  }
  lwtToggle.textContent = store.lwDisplay ? 'LWT' : 'lwt';
  lwtToggle.className = store.lwDisplay ? 'status-toggle active' : 'status-toggle';
  const curLayer = store.currentLayer();
  layerDisplay.textContent = curLayer.name;
  layerDisplay.style.color = curLayer.color === '#ffffff' ? '#000' : curLayer.color;

  requestAnimationFrame(frame);
}

// === ORTHO ===

function applyOrtho(world: Point): Point {
  const base = store.lastPoint;
  const dx = world.x - base.x;
  const dy = world.y - base.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: world.x, y: base.y };
  } else {
    return { x: base.x, y: world.y };
  }
}

// === DXF FILE I/O ===

const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3002' : '';

async function dxfOpen() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.dxf';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    promptFn(`Opening ${file.name}...`);
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch(`${API_BASE}/api/dxf/import`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.entities) throw new Error('No entities in response');
      store.pushUndo('OPEN');
      store.entities = data.entities;
      if (data.layers) {
        store.layers = data.layers.map((l: any) => ({
          name: l.name, color: l.color || '#ffffff',
          visible: true, locked: false, frozen: false, current: l.name === '0',
          lineweight: l.lineweight || 1, plot: true,
        }));
      }
      store.emit();
      zoomExtents();
      promptFn(`Opened ${file.name}: ${data.count} entities`);
    } catch (e: any) {
      promptFn(`Error: ${e.message}`);
    }
  };
  input.click();
}

async function dxfSave(layerFilter?: string[]) {
  promptFn('Saving DXF...');
  try {
    const plottableLayers = new Set(store.layers.filter(l => l.plot !== false).map(l => l.name));
    let entities = store.entities.filter(e => plottableLayers.has(e.layer));
    if (layerFilter && layerFilter.length > 0) {
      entities = entities.filter(e => layerFilter.includes(e.layer));
    }
    const res = await fetch(`${API_BASE}/api/dxf/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entities: entities,
        layers: store.layers,
        filename: 'drawing.dxf',
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'drawing.dxf'; a.click();
    URL.revokeObjectURL(url);
    promptFn('DXF saved');
  } catch (e: any) {
    promptFn(`Error: ${e.message}`);
  }
}

// ── Cloud Storage ──

function cloudDialog(): { overlay: HTMLElement; dialog: HTMLElement } {
  const overlay = document.getElementById('cloud-overlay')!;
  const dialog = document.getElementById('cloud-dialog')!;
  return { overlay, dialog };
}

function closeCloudDialog() {
  cloudDialog().overlay.classList.remove('open');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function cloudSave() {
  const { overlay, dialog } = cloudDialog();
  dialog.innerHTML = `
    <div class="cloud-dialog-title">
      <span>Save to Cloud</span>
      <button id="cloud-close">&times;</button>
    </div>
    <div class="cloud-dialog-body">
      <div style="margin-bottom:4px">Filename:</div>
      <input class="cloud-save-input" id="cloud-save-name" value="drawing.dxf" />
      <div class="cloud-btn-row">
        <button class="cloud-btn primary" id="cloud-save-ok">Save</button>
        <button class="cloud-btn" id="cloud-save-cancel">Cancel</button>
      </div>
    </div>`;
  overlay.classList.add('open');

  dialog.querySelector('#cloud-close')!.addEventListener('click', closeCloudDialog);
  dialog.querySelector('#cloud-save-cancel')!.addEventListener('click', closeCloudDialog);

  dialog.querySelector('#cloud-save-ok')!.addEventListener('click', async () => {
    const nameInput = dialog.querySelector('#cloud-save-name') as HTMLInputElement;
    const filename = nameInput.value.trim() || 'drawing.dxf';
    closeCloudDialog();
    promptFn('Saving to cloud...');
    try {
      const res = await fetch(`${API_BASE}/api/cloud/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entities: store.entities,
          layers: store.layers,
          filename,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      promptFn(`Saved to cloud: ${data.filename} (${data.entity_count} entities)`);
    } catch (e: any) {
      promptFn(`Error: ${e.message}`);
    }
  });

  const nameInput = dialog.querySelector('#cloud-save-name') as HTMLInputElement;
  nameInput.select();
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dialog.querySelector<HTMLButtonElement>('#cloud-save-ok')!.click();
    if (e.key === 'Escape') closeCloudDialog();
  });
}

async function cloudOpen() {
  const { overlay, dialog } = cloudDialog();
  dialog.innerHTML = `
    <div class="cloud-dialog-title">
      <span>Open from Cloud</span>
      <button id="cloud-close">&times;</button>
    </div>
    <div class="cloud-dialog-body">
      <div class="cloud-file-list" id="cloud-file-list">
        <div class="cloud-empty">Loading...</div>
      </div>
      <div class="cloud-btn-row">
        <button class="cloud-btn primary" id="cloud-open-ok" disabled>Open</button>
        <button class="cloud-btn" id="cloud-open-delete" disabled>Delete</button>
        <button class="cloud-btn" id="cloud-open-cancel">Cancel</button>
      </div>
    </div>`;
  overlay.classList.add('open');

  dialog.querySelector('#cloud-close')!.addEventListener('click', closeCloudDialog);
  dialog.querySelector('#cloud-open-cancel')!.addEventListener('click', closeCloudDialog);

  let selectedId: string | null = null;

  async function loadList() {
    const listEl = dialog.querySelector('#cloud-file-list')!;
    try {
      const res = await fetch(`${API_BASE}/api/cloud/list`);
      const data = await res.json();
      if (!data.files || data.files.length === 0) {
        listEl.innerHTML = '<div class="cloud-empty">No files saved in cloud storage.</div>';
        return;
      }
      listEl.innerHTML = data.files.map((f: any) => `
        <div class="cloud-file-row" data-id="${f.id}">
          <span class="cloud-file-name">${f.filename}</span>
          <span class="cloud-file-meta">${f.entity_count} ent &middot; ${formatFileSize(f.file_size)} &middot; ${formatDate(f.uploaded_at)}</span>
        </div>`).join('');

      listEl.addEventListener('click', (e) => {
        const row = (e.target as HTMLElement).closest('.cloud-file-row') as HTMLElement;
        if (!row) return;
        listEl.querySelectorAll('.cloud-file-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        selectedId = row.dataset.id!;
        (dialog.querySelector('#cloud-open-ok') as HTMLButtonElement).disabled = false;
        (dialog.querySelector('#cloud-open-delete') as HTMLButtonElement).disabled = false;
      });

      listEl.addEventListener('dblclick', (e) => {
        const row = (e.target as HTMLElement).closest('.cloud-file-row') as HTMLElement;
        if (!row) return;
        selectedId = row.dataset.id!;
        dialog.querySelector<HTMLButtonElement>('#cloud-open-ok')!.click();
      });
    } catch {
      listEl.innerHTML = '<div class="cloud-empty">Failed to load file list.</div>';
    }
  }

  await loadList();

  dialog.querySelector('#cloud-open-ok')!.addEventListener('click', async () => {
    if (!selectedId) return;
    closeCloudDialog();
    promptFn('Opening from cloud...');
    try {
      const res = await fetch(`${API_BASE}/api/cloud/open/${selectedId}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.entities) throw new Error('No entities in response');
      store.pushUndo('CLOUD_OPEN');
      store.entities = data.entities;
      if (data.layers) {
        store.layers = data.layers.map((l: any) => ({
          name: l.name, color: l.color || '#ffffff',
          visible: true, locked: false, frozen: false, current: l.name === '0',
          lineweight: l.lineweight || 1, plot: true,
        }));
      }
      store.emit();
      zoomExtents();
      promptFn(`Opened ${data.filename}: ${data.count} entities`);
    } catch (e: any) {
      promptFn(`Error: ${e.message}`);
    }
  });

  dialog.querySelector('#cloud-open-delete')!.addEventListener('click', async () => {
    if (!selectedId) return;
    if (!confirm('Delete this file from cloud storage?')) return;
    try {
      await fetch(`${API_BASE}/api/cloud/delete/${selectedId}`, { method: 'DELETE' });
      selectedId = null;
      (dialog.querySelector('#cloud-open-ok') as HTMLButtonElement).disabled = true;
      (dialog.querySelector('#cloud-open-delete') as HTMLButtonElement).disabled = true;
      await loadList();
    } catch (e: any) {
      promptFn(`Error: ${e.message}`);
    }
  });
}

// Expose to toolbar buttons
(window as any).dxfOpen = dxfOpen;
(window as any).dxfSave = dxfSave;
(window as any).__store = store;
(window as any).__engine = engine;
(window as any).__shelterState = shelterState;
(window as any).__findSnap = findSnap;

// ── MCP Live Sync (SSE) ──
const mcpLogEntries: string[] = [];
let mcpDebugPanel: HTMLDivElement | null = null;

function mcpLog(msg: string) {
  const ts = new Date().toLocaleTimeString();
  mcpLogEntries.push(`[${ts}] ${msg}`);
  if (mcpLogEntries.length > 500) mcpLogEntries.shift();
  if (mcpDebugPanel) {
    const log = mcpDebugPanel.querySelector('.mcp-log') as HTMLElement;
    if (log) {
      log.textContent = mcpLogEntries.join('\n');
      log.scrollTop = log.scrollHeight;
    }
  }
}

function toggleMcpDebug() {
  if (mcpDebugPanel) {
    mcpDebugPanel.remove();
    mcpDebugPanel = null;
    appendHistory('[MCP] Debug panel closed');
    return;
  }
  mcpDebugPanel = document.createElement('div');
  mcpDebugPanel.style.cssText = 'position:fixed;top:40px;right:0;width:480px;height:70vh;background:#1a1a2e;border:1px solid #444;z-index:9999;display:flex;flex-direction:column;font-family:monospace;font-size:12px;';
  mcpDebugPanel.innerHTML = `
    <div style="padding:6px 10px;background:#2a2a4a;color:#0ff;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
      <span>MCP Debug Log</span>
      <button style="background:none;border:1px solid #666;color:#fff;cursor:pointer;padding:2px 8px;" onclick="this.closest('div').parentElement.remove();window.__mcpCloseDebug()">✕</button>
    </div>
    <pre class="mcp-log" style="flex:1;overflow:auto;margin:0;padding:8px;color:#ccc;white-space:pre-wrap;word-break:break-all;"></pre>
  `;
  document.body.appendChild(mcpDebugPanel);
  (window as any).__mcpCloseDebug = () => { mcpDebugPanel = null; };
  const log = mcpDebugPanel.querySelector('.mcp-log') as HTMLElement;
  log.textContent = mcpLogEntries.join('\n');
  log.scrollTop = log.scrollHeight;
  mcpLog('Debug panel opened');
  if (store.entities.length > 0) {
    mcpLog(`Current state: ${store.entities.length} entities`);
    for (const e of store.entities) {
      mcpLog(entitySummary(e));
    }
  }
  appendHistory('[MCP] Debug panel opened');
}

function entitySummary(e: any): string {
  switch (e.type) {
    case 'line': return `  #${e.id} line (${e.start.x},${e.start.y})→(${e.end.x},${e.end.y})`;
    case 'circle': return `  #${e.id} circle center=(${e.center.x},${e.center.y}) r=${e.radius}`;
    case 'arc': return `  #${e.id} arc center=(${e.center.x},${e.center.y}) r=${e.radius} ${(e.startAngle*180/Math.PI).toFixed(1)}°→${(e.endAngle*180/Math.PI).toFixed(1)}°`;
    case 'polyline': return `  #${e.id} polyline ${e.points?.length}pts closed=${e.closed}`;
    case 'text': return `  #${e.id} text "${e.text}" at (${e.position.x},${e.position.y})`;
    case 'rect': return `  #${e.id} rect (${e.corner1.x},${e.corner1.y})→(${e.corner2.x},${e.corner2.y})`;
    default: return `  #${e.id} ${e.type}`;
  }
}

(window as any).toggleMcpDebug = toggleMcpDebug;
{
  const API = window.location.hostname === 'localhost' ? 'http://localhost:3002' : '';
  const sse = new EventSource(`${API}/api/live/events`);
  sse.addEventListener('sync', (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data);
      mcpLog(`sync received: ${data.entities?.length ?? 0} entities`);
      for (const e of (data.entities || [])) {
        mcpLog(entitySummary(e));
      }
      if (data.entities) {
        store.pushUndo('MCP sync');
        store.entities = data.entities;
      }
      if (data.layers) {
        store.layers = data.layers.map((l: any) => ({
          name: l.name, color: l.color || '#ffffff',
          visible: l.visible !== false, locked: !!l.locked,
          frozen: !!l.frozen, current: !!l.current,
          lineweight: l.lineweight || 1, plot: l.plot !== false,
        }));
      }
      store.emit();
      engine.handleInput('ZOOM');
      engine.handleInput('e');
      appendHistory(`[MCP] synced ${store.entities.length} entities`);
    } catch (_) { /* ignore parse errors */ }
  });
  sse.addEventListener('connected', () => {
    appendHistory('[MCP] live sync connected');
  });
  // Fetch current MCP state on page load (SSE events may be delayed by CDN buffering)
  fetch(`${API}/api/live/state`).then(r => r.json()).then(data => {
    if (data.entities && data.entities.length > 0 && store.entities.length === 0) {
      store.pushUndo('MCP sync');
      store.entities = data.entities;
      if (data.layers) {
        store.layers = data.layers.map((l: any) => ({
          name: l.name, color: l.color || '#ffffff',
          visible: l.visible !== false, locked: !!l.locked,
          frozen: !!l.frozen, current: !!l.current,
          lineweight: l.lineweight || 1, plot: l.plot !== false,
        }));
      }
      store.emit();
      engine.handleInput('ZOOM');
      engine.handleInput('e');
      appendHistory(`[MCP] loaded ${store.entities.length} entities`);
    }
  }).catch(() => {});
  sse.onerror = () => {
    // SSE auto-reconnects; no action needed
  };
}

// === TOOLBAR CUSTOM EVENTS ===

document.addEventListener('soncad-cadastral', ((e: CustomEvent) => {
  openCadastralDialog(promptFn);
}) as EventListener);

// === HELP ===

function showHelp() {
  appendHistory('--- SonCAD 쉼터배치도 도면 ---');
  appendHistory('지적도:  지적도 toolbar button → VWorld 지적도 다운로드/삽입');
  appendHistory('쉼터:   쉼터배치 toolbar button → 건물배치도 작성 모드');
  appendHistory('Drawing: LINE(L) PLINE(PL) RECTANG(REC) CIRCLE(C) ARC(A) TEXT(DT)');
  appendHistory('Modify:  MOVE(M) COPY(CO) ROTATE(RO) SCALE(SC) MIRROR(MI) OFFSET(O) ERASE(E)');
  appendHistory('Edit:    TRIM(TR) FILLET(F)');
  appendHistory('Dim:     DIMLINEAR(DLI) DIMALIGNED(DAL) DIST(DI) AREA(AA)');
  appendHistory('View:    ZOOM(Z) PAN(P)');
  appendHistory('Layers:  LAYER(LA)');
  appendHistory('I/O:     File → Open DXF / Save DXF');
  appendHistory('Utility: UNDO(U) REDO OSNAP(OS) GRID(G) ORTHO');
  appendHistory('Shortcuts: Ctrl+Z=Undo Ctrl+Y=Redo  F3=Osnap F7=Grid F8=Ortho');
}

function showMechDrawing() {
  const { overlay, dialog } = cloudDialog();
  dialog.className = 'cloud-dialog mech-dialog';
  dialog.innerHTML = `
    <div class="cloud-dialog-title">
      <span>Mechanical Drawing — Image to DXF via MCP + LLM</span>
      <button id="mech-close">&times;</button>
    </div>
    <div class="mech-body">
      <h3>Exercise 1 — Flange Gasket</h3>
      <div class="mech-img-wrap">
        <img src="/images/mech_drawing_01.png" alt="Mechanical drawing: 5-bolt flange gasket with dimensions" />
      </div>
      <p>Dimensions: R27.5 (center bore), R45 (outer), R5 (bolt holes), R10/R17/R18 (fillets &amp; lobes), 5 bolts at 60&deg; spacing, gap 8mm.</p>

      <h3>Conversion Process: Image &rarr; DXF</h3>
      <div class="mech-flow">
        <div class="mech-step">
          <div class="mech-step-num">1</div>
          <div class="mech-step-title">Image Input</div>
          <div class="mech-step-desc">PDF page or photo of a mechanical drawing</div>
        </div>
        <div class="mech-arrow">&rarr;</div>
        <div class="mech-step active">
          <div class="mech-step-num">2</div>
          <div class="mech-step-title">LLM Vision</div>
          <div class="mech-step-desc">Claude reads dimensions, geometry, annotations</div>
        </div>
        <div class="mech-arrow">&rarr;</div>
        <div class="mech-step">
          <div class="mech-step-num">3</div>
          <div class="mech-step-title">MCP Commands</div>
          <div class="mech-step-desc">AI calls add_circle, add_line, add_arc, add_polygon...</div>
        </div>
        <div class="mech-arrow">&rarr;</div>
        <div class="mech-step">
          <div class="mech-step-num">4</div>
          <div class="mech-step-title">DXF Output</div>
          <div class="mech-step-desc">Live sync to canvas &rarr; export_dxf</div>
        </div>
      </div>

      <h3>Step 1 &mdash; User Prompt</h3>
      <div class="mech-prompt-box">
        "Look at this mechanical drawing image. Analyze the dimensions and geometry, then recreate it in SonCAD using MCP tools. The drawing shows a 5-bolt flange gasket."
      </div>

      <h3>Step 2 &mdash; LLM Analyzes the Image</h3>
      <p>Claude's vision model reads the drawing and extracts:</p>
      <div class="mech-code"><span class="comment">// Claude's analysis of the image:</span>
{
  <span class="str">"type"</span>: <span class="str">"5-bolt flange gasket"</span>,
  <span class="str">"center"</span>: { <span class="str">"x"</span>: <span class="val">0</span>, <span class="str">"y"</span>: <span class="val">0</span> },
  <span class="str">"center_bore_radius"</span>: <span class="val">27.5</span>,
  <span class="str">"outer_radius"</span>: <span class="val">45</span>,
  <span class="str">"bolt_circle_radius"</span>: <span class="val">45</span>,
  <span class="str">"bolt_hole_radius"</span>: <span class="val">5</span>,
  <span class="str">"bolt_count"</span>: <span class="val">5</span>,
  <span class="str">"lobe_outer_radius"</span>: <span class="val">18</span>,
  <span class="str">"lobe_inner_radius"</span>: <span class="val">10</span>,
  <span class="str">"fillet_radius"</span>: <span class="val">17</span>,
  <span class="str">"angular_spacing"</span>: <span class="val">60</span>,
  <span class="str">"gap"</span>: <span class="val">8</span>
}</div>

      <h3>Step 3 &mdash; MCP Tool Calls</h3>
      <p>Claude generates a sequence of MCP commands:</p>
      <div class="mech-code"><span class="comment">// 1. Center bore</span>
<span class="fn">add_circle</span>({ center_x: <span class="val">0</span>, center_y: <span class="val">0</span>, radius: <span class="val">27.5</span> })

<span class="comment">// 2. Outer profile circle</span>
<span class="fn">add_circle</span>({ center_x: <span class="val">0</span>, center_y: <span class="val">0</span>, radius: <span class="val">45</span> })

<span class="comment">// 3. Bolt holes at 5 positions (72° apart)</span>
<span class="fn">add_circle</span>({ center_x: <span class="val">0</span>,    center_y: <span class="val">45</span>,   radius: <span class="val">5</span> })
<span class="fn">add_circle</span>({ center_x: <span class="val">42.8</span>, center_y: <span class="val">13.9</span>, radius: <span class="val">5</span> })
<span class="fn">add_circle</span>({ center_x: <span class="val">26.5</span>, center_y: <span class="val">-36.4</span>, radius: <span class="val">5</span> })
<span class="fn">add_circle</span>({ center_x: <span class="val">-26.5</span>, center_y: <span class="val">-36.4</span>, radius: <span class="val">5</span> })
<span class="fn">add_circle</span>({ center_x: <span class="val">-42.8</span>, center_y: <span class="val">13.9</span>, radius: <span class="val">5</span> })

<span class="comment">// 4. Lobe arcs around each bolt</span>
<span class="fn">add_arc</span>({ center_x: <span class="val">0</span>, center_y: <span class="val">45</span>, radius: <span class="val">18</span>,
         start_angle: <span class="val">210</span>, end_angle: <span class="val">330</span> })
<span class="comment">// ... repeated for all 5 positions</span>

<span class="comment">// 5. Center lines</span>
<span class="fn">add_line</span>({ start_x: <span class="val">0</span>, start_y: <span class="val">-55</span>, end_x: <span class="val">0</span>, end_y: <span class="val">55</span> })
<span class="fn">add_line</span>({ start_x: <span class="val">-55</span>, start_y: <span class="val">0</span>, end_x: <span class="val">55</span>, end_y: <span class="val">0</span> })

<span class="comment">// 6. Dimension annotations</span>
<span class="fn">add_dimension</span>({ dim_type: <span class="str">"aligned"</span>, ... })

<span class="comment">// 7. Export to DXF</span>
<span class="fn">export_dxf</span>({ filename: <span class="str">"flange_gasket.dxf"</span> })</div>

      <h3>Step 4 &mdash; Try It Live</h3>
      <p>Click to draw this flange gasket on the SonCAD canvas right now:</p>
      <div class="mcp-demo-section">
        <button class="mech-btn" data-mech="flange">Draw Flange Gasket</button>
        <button class="mech-btn" data-mech="clear">Clear Canvas</button>
        <p>This simulates the exact MCP calls Claude would make after analyzing the image.</p>
      </div>

      <h3>How to Use With Your Own Drawings</h3>
      <div class="mech-code"><span class="comment"># In Claude Code with SonCAD MCP configured:</span>

<span class="comment"># 1. Extract a page from PDF</span>
pdftoppm -png -f <span class="val">5</span> -l <span class="val">5</span> drawing.pdf page

<span class="comment"># 2. Ask Claude to convert it</span>
<span class="str">"Look at page-005.png. Recreate this mechanical
 drawing in SonCAD using MCP tools. Extract all
 dimensions and geometry from the image."</span>

<span class="comment"># 3. Claude reads the image, calls MCP tools,</span>
<span class="comment">#    drawing appears live on canvas</span>

<span class="comment"># 4. Export the result</span>
<span class="str">"Export the drawing as flange_gasket.dxf"</span></div>

      <div class="cloud-btn-row" style="margin-top:10px;">
        <button class="cloud-btn primary" id="mech-ok">Close</button>
      </div>
    </div>`;
  overlay.classList.add('open');

  const close = () => { overlay.classList.remove('open'); dialog.className = 'cloud-dialog'; cmdInput.focus(); };
  dialog.querySelector('#mech-close')!.addEventListener('click', close);
  dialog.querySelector('#mech-ok')!.addEventListener('click', close);

  let demoId = 2000;
  function ent(type: string, props: any) {
    return {
      id: String(demoId++), type, layer: '0', color: '#ffffff',
      lineweight: 1, linetype: 'Continuous', visible: true, selected: false,
      ...props,
    };
  }

  dialog.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.mech-btn') as HTMLElement;
    if (!btn || btn.classList.contains('running')) return;
    const demo = btn.dataset.mech;
    if (!demo) return;

    btn.classList.add('running');
    setTimeout(() => btn.classList.remove('running'), 500);

    if (demo === 'clear') {
      store.pushUndo('CLEAR');
      store.entities = [];
      store.emit();
      appendHistory('[Mech Demo] canvas cleared');
      return;
    }

    if (demo === 'flange') {
      demoId = 2000;
      const s: any[] = [];
      const cx = 0, cy = 0;
      const boltR = 45;
      const boreR = 27.5;
      const boltHoleR = 5;
      const lobeR = 18;
      const filletR = 10;
      const nBolts = 5;

      // Center bore
      s.push(ent('circle', { center: { x: cx, y: cy }, radius: boreR, color: '#00ff00' }));

      // Outer lobe arcs + bolt holes
      for (let i = 0; i < nBolts; i++) {
        const angle = (90 + i * 360 / nBolts) * Math.PI / 180;
        const bx = cx + boltR * Math.cos(angle);
        const by = cy + boltR * Math.sin(angle);

        // Bolt hole
        s.push(ent('circle', { center: { x: bx, y: by }, radius: boltHoleR, color: '#00ffff' }));

        // Lobe arc around bolt
        const lobeDeg = 360 / nBolts;
        const startA = ((90 + i * lobeDeg) - lobeDeg / 2 + 180) % 360;
        const endA = ((90 + i * lobeDeg) + lobeDeg / 2 + 180) % 360;
        s.push(ent('arc', {
          center: { x: bx, y: by },
          radius: lobeR,
          startAngle: startA,
          endAngle: endA,
          color: '#00ff00',
        }));
      }

      // Connecting arcs between lobes (inner fillet arcs)
      for (let i = 0; i < nBolts; i++) {
        const a1 = (90 + i * 360 / nBolts) * Math.PI / 180;
        const a2 = (90 + ((i + 1) % nBolts) * 360 / nBolts) * Math.PI / 180;
        const midA = (a1 + a2) / 2;
        if (i === nBolts - 1) {
          const a2w = a2 + 2 * Math.PI;
          const mw = (a1 + a2w) / 2;
          const fx = cx + (boltR - 8) * Math.cos(mw);
          const fy = cy + (boltR - 8) * Math.sin(mw);
          s.push(ent('arc', {
            center: { x: fx, y: fy },
            radius: filletR,
            startAngle: (mw * 180 / Math.PI + 90) % 360,
            endAngle: (mw * 180 / Math.PI + 270) % 360,
            color: '#888800',
          }));
        } else {
          const fx = cx + (boltR - 8) * Math.cos(midA);
          const fy = cy + (boltR - 8) * Math.sin(midA);
          s.push(ent('arc', {
            center: { x: fx, y: fy },
            radius: filletR,
            startAngle: (midA * 180 / Math.PI + 90) % 360,
            endAngle: (midA * 180 / Math.PI + 270) % 360,
            color: '#888800',
          }));
        }
      }

      // Center lines (dashed)
      s.push(ent('line', { start: { x: cx, y: cy - 58 }, end: { x: cx, y: cy + 58 }, color: '#ff0000' }));
      s.push(ent('line', { start: { x: cx - 58, y: cy }, end: { x: cx + 58, y: cy }, color: '#ff0000' }));

      // Dimension text annotations
      s.push(ent('text', { position: { x: 2, y: -28 }, text: 'R27.5', height: 3, rotation: 0, color: '#00ff00' }));
      s.push(ent('text', { position: { x: 30, y: -10 }, text: 'R45', height: 3, rotation: 0, color: '#00ff00' }));
      s.push(ent('text', { position: { x: -18, y: 48 }, text: 'R5', height: 2.5, rotation: 0, color: '#00ffff' }));
      s.push(ent('text', { position: { x: 20, y: 50 }, text: 'R18', height: 2.5, rotation: 0, color: '#00ff00' }));
      s.push(ent('text', { position: { x: -40, y: -45 }, text: 'R10', height: 2.5, rotation: 0, color: '#888800' }));
      s.push(ent('text', { position: { x: 0, y: -62 }, text: 'Exercise 1: Flange Gasket', height: 3, rotation: 0, color: '#ffffff' }));

      store.pushUndo('MCP demo');
      store.entities = s;
      store.emit();
      engine.handleInput('ZOOM');
      engine.handleInput('e');
      appendHistory(`[Mech Demo] flange gasket: ${s.length} entities drawn via MCP simulation`);
    }
  });
}

function mcpDemoSync(ents: any[], layers?: any[]) {
  const payload: any = { entities: ents };
  if (layers) payload.layers = layers;
  store.pushUndo('MCP demo');
  store.entities = ents;
  store.emit();
  engine.handleInput('ZOOM');
  engine.handleInput('e');
  appendHistory(`[MCP Demo] synced ${ents.length} entities`);
}

function showMcpTutorial() {
  const { overlay, dialog } = cloudDialog();
  dialog.style.width = '620px';
  dialog.innerHTML = `
    <div class="cloud-dialog-title">
      <span>MCP Tutorial — AI-Powered CAD</span>
      <button id="mcp-tut-close">&times;</button>
    </div>
    <div class="mcp-tutorial-body">
      <h3>What is MCP?</h3>
      <p>MCP (Model Context Protocol) lets AI assistants like <b>Claude</b> control SonCAD directly.
      Instead of clicking buttons, you describe what you want in natural language and the AI draws it for you.</p>

      <h3>Quick Start</h3>
      <p>1. Start the SonCAD backend and MCP server:</p>
      <pre>cd soncad
python backend/main.py &amp;       # backend on :3002
node mcp-server/index.mjs      # MCP stdio server</pre>
      <p>2. Add to your Claude Code MCP config (<code>~/.claude.json</code>):</p>
      <pre>{
  "mcpServers": {
    "soncad": {
      "command": "node",
      "args": ["/path/to/soncad/mcp-server/index.mjs"]
    }
  }
}</pre>
      <p>3. Open SonCAD in browser, then ask Claude:</p>
      <pre>"Draw a 10m x 8m rectangle for a building footprint"</pre>

      <h3>Try It — Drawing Tools</h3>
      <p>Click a button to see MCP draw entities on the canvas in real-time:</p>
      <div class="mcp-demo-section">
        <button class="mcp-demo-btn" data-demo="rectangle">add_rectangle</button>
        <button class="mcp-demo-btn" data-demo="lines">add_line (x3)</button>
        <button class="mcp-demo-btn" data-demo="circle">add_circle</button>
        <button class="mcp-demo-btn" data-demo="polygon">add_polygon (hex)</button>
        <button class="mcp-demo-btn" data-demo="text">add_text</button>
        <p>Each button simulates what the AI does through MCP tools.</p>
      </div>

      <h3>Try It — Building Layout</h3>
      <p>MCP can compose multiple tools to create a shelter floor plan:</p>
      <div class="mcp-demo-section">
        <button class="mcp-demo-btn" data-demo="shelter">Shelter Layout (walls + rooms + labels)</button>
        <button class="mcp-demo-btn" data-demo="site-plan">Site Plan (building + parking + trees)</button>
        <p>These demos combine rectangle, line, circle, and text tools — just like Claude would.</p>
      </div>

      <h3>Try It — Modify</h3>
      <p>After drawing, MCP can move, copy, rotate, scale, and mirror entities:</p>
      <div class="mcp-demo-section">
        <button class="mcp-demo-btn" data-demo="modify">Draw + Copy + Rotate demo</button>
        <p>Draws a shape, then copies and rotates it — showing modify tools in action.</p>
      </div>

      <h3>All MCP Tools Reference</h3>
      <ul>
        <li><span class="tool-name">Drawing:</span> add_line, add_polyline, add_rectangle, add_circle, add_arc, add_text, add_dimension, add_polygon, add_ellipse, add_hatch, add_point</li>
        <li><span class="tool-name">Modify:</span> move_entity, copy_entity, rotate_entity, scale_entity, mirror_entity, erase_entity</li>
        <li><span class="tool-name">Query:</span> list_entities, get_entity, get_drawing_bounds</li>
        <li><span class="tool-name">Layers:</span> list_layers, create_layer, set_current_layer</li>
        <li><span class="tool-name">I/O:</span> export_dxf, import_dxf, clear_drawing, get_entity_json</li>
        <li><span class="tool-name">Cloud:</span> cloud_save, cloud_open, cloud_list</li>
        <li><span class="tool-name">Advanced:</span> generate_floorplan, screenshot</li>
      </ul>

      <h3>Live Sync</h3>
      <p>All MCP changes sync to the browser in real-time via SSE.
      Look for <code>[MCP] synced</code> messages in the command line below.</p>

      <div class="cloud-btn-row" style="margin-top:8px;">
        <button class="cloud-btn" id="mcp-tut-clear">Clear Canvas</button>
        <button class="cloud-btn primary" id="mcp-tut-ok">Close</button>
      </div>
    </div>`;
  overlay.classList.add('open');

  const close = () => { overlay.classList.remove('open'); dialog.style.width = ''; cmdInput.focus(); };
  dialog.querySelector('#mcp-tut-close')!.addEventListener('click', close);
  dialog.querySelector('#mcp-tut-ok')!.addEventListener('click', close);
  dialog.querySelector('#mcp-tut-clear')!.addEventListener('click', () => {
    store.pushUndo('CLEAR');
    store.entities = [];
    store.emit();
    appendHistory('[MCP Demo] canvas cleared');
  });

  let demoId = 1000;
  function ent(type: string, props: any) {
    return {
      id: String(demoId++), type, layer: '0', color: '#ffffff',
      lineweight: 1, linetype: 'Continuous', visible: true, selected: false,
      ...props,
    };
  }

  dialog.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.mcp-demo-btn') as HTMLElement;
    if (!btn || btn.classList.contains('running')) return;
    const demo = btn.dataset.demo;
    if (!demo) return;

    btn.classList.add('running');
    setTimeout(() => btn.classList.remove('running'), 400);

    demoId = Math.max(demoId, store.entities.length > 0
      ? Math.max(...store.entities.map(e => parseInt(e.id, 10) || 0)) + 1 : 1000);

    const existing = [...store.entities];

    switch (demo) {
      case 'rectangle': {
        existing.push(ent('rect', { corner1: { x: 0, y: 0 }, corner2: { x: 10, y: 8 }, color: '#00ff00' }));
        mcpDemoSync(existing);
        break;
      }
      case 'lines': {
        existing.push(ent('line', { start: { x: 0, y: 0 }, end: { x: 12, y: 0 }, color: '#ffff00' }));
        existing.push(ent('line', { start: { x: 12, y: 0 }, end: { x: 6, y: 8 }, color: '#ffff00' }));
        existing.push(ent('line', { start: { x: 6, y: 8 }, end: { x: 0, y: 0 }, color: '#ffff00' }));
        mcpDemoSync(existing);
        break;
      }
      case 'circle': {
        existing.push(ent('circle', { center: { x: 5, y: 5 }, radius: 4, color: '#00ffff' }));
        mcpDemoSync(existing);
        break;
      }
      case 'polygon': {
        const sides = 6, r = 4, cx = 5, cy = 5;
        const pts = [];
        for (let i = 0; i < sides; i++) {
          const a = 2 * Math.PI * i / sides;
          pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
        existing.push(ent('polyline', { points: pts, bulges: new Array(sides).fill(0), closed: true, color: '#ff00ff' }));
        mcpDemoSync(existing);
        break;
      }
      case 'text': {
        existing.push(ent('text', { position: { x: 2, y: 10 }, text: 'SonCAD MCP Demo', height: 1.0, rotation: 0, color: '#ffffff' }));
        mcpDemoSync(existing);
        break;
      }
      case 'shelter': {
        const s: any[] = [];
        s.push(ent('rect', { corner1: { x: 0, y: 0 }, corner2: { x: 10, y: 8 }, color: '#00ff00' }));
        s.push(ent('line', { start: { x: 5, y: 0 }, end: { x: 5, y: 8 }, color: '#00ff00' }));
        s.push(ent('line', { start: { x: 0, y: 4 }, end: { x: 5, y: 4 }, color: '#00ff00' }));
        s.push(ent('line', { start: { x: 5, y: 5 }, end: { x: 10, y: 5 }, color: '#00ff00' }));
        s.push(ent('text', { position: { x: 1.5, y: 6 }, text: 'Room 1', height: 0.5, rotation: 0, color: '#ffff00' }));
        s.push(ent('text', { position: { x: 1.5, y: 2 }, text: 'Room 2', height: 0.5, rotation: 0, color: '#ffff00' }));
        s.push(ent('text', { position: { x: 6.5, y: 6.5 }, text: 'Kitchen', height: 0.4, rotation: 0, color: '#ffff00' }));
        s.push(ent('text', { position: { x: 6.5, y: 2.5 }, text: 'Bath', height: 0.4, rotation: 0, color: '#ffff00' }));
        s.push(ent('text', { position: { x: 2, y: 9 }, text: 'Shelter Floor Plan', height: 0.6, rotation: 0, color: '#ffffff' }));
        mcpDemoSync(s);
        break;
      }
      case 'site-plan': {
        const s: any[] = [];
        s.push(ent('rect', { corner1: { x: 0, y: 0 }, corner2: { x: 30, y: 25 }, color: '#444444' }));
        s.push(ent('rect', { corner1: { x: 5, y: 8 }, corner2: { x: 18, y: 20 }, color: '#00ff00' }));
        s.push(ent('text', { position: { x: 8, y: 14 }, text: 'Building', height: 0.8, rotation: 0, color: '#ffffff' }));
        s.push(ent('rect', { corner1: { x: 20, y: 2 }, corner2: { x: 28, y: 8 }, color: '#888800' }));
        s.push(ent('text', { position: { x: 21.5, y: 5 }, text: 'Parking', height: 0.5, rotation: 0, color: '#ffff00' }));
        for (let i = 0; i < 3; i++) {
          s.push(ent('line', { start: { x: 22 + i * 2, y: 2 }, end: { x: 22 + i * 2, y: 8 }, color: '#888800' }));
        }
        s.push(ent('circle', { center: { x: 3, y: 22 }, radius: 1.5, color: '#00aa00' }));
        s.push(ent('circle', { center: { x: 27, y: 22 }, radius: 1.5, color: '#00aa00' }));
        s.push(ent('circle', { center: { x: 27, y: 12 }, radius: 1.2, color: '#00aa00' }));
        s.push(ent('text', { position: { x: 1, y: -1.5 }, text: 'Site Plan — MCP Demo', height: 0.8, rotation: 0, color: '#ffffff' }));
        s.push(ent('line', { start: { x: 0, y: -0.5 }, end: { x: 30, y: -0.5 }, color: '#666666' }));
        mcpDemoSync(s);
        break;
      }
      case 'modify': {
        const s: any[] = [];
        s.push(ent('rect', { corner1: { x: 0, y: 0 }, corner2: { x: 4, y: 3 }, color: '#00ff00' }));
        s.push(ent('text', { position: { x: 0.5, y: 1.2 }, text: 'Original', height: 0.4, rotation: 0, color: '#ffff00' }));
        s.push(ent('rect', { corner1: { x: 6, y: 0 }, corner2: { x: 10, y: 3 }, color: '#00ffff' }));
        s.push(ent('text', { position: { x: 6.5, y: 1.2 }, text: 'Copied +6,0', height: 0.4, rotation: 0, color: '#00ffff' }));
        const cx = 8, cy = 8, r = 2;
        const pts = [];
        for (let i = 0; i < 4; i++) {
          const a = 2 * Math.PI * i / 4 + Math.PI / 4;
          pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
        s.push(ent('polyline', { points: pts, bulges: [0, 0, 0, 0], closed: true, color: '#ff00ff' }));
        s.push(ent('text', { position: { x: 6.8, y: 7.8 }, text: 'Rotated 45°', height: 0.35, rotation: 0, color: '#ff00ff' }));
        mcpDemoSync(s);
        break;
      }
    }
  });
}

function toggleOsnap() {
  if (store.snapModes.size > 0) {
    store.snapModes.clear();
    promptFn('Osnap OFF');
  } else {
    store.snapModes = new Set(['endpoint', 'midpoint', 'center', 'intersection', 'perpendicular', 'quadrant', 'nearest']);
    promptFn('Osnap ON');
  }
}

function toggleCoordDisplay() {
  const modes: Array<'cartesian' | 'polar' | 'off'> = ['cartesian', 'polar', 'off'];
  const idx = modes.indexOf(store.coordDisplayMode);
  store.coordDisplayMode = modes[(idx + 1) % modes.length];
  promptFn(`Coordinate display: ${store.coordDisplayMode.toUpperCase()}`);
}

function toggleGridSnap() {
  store.snapToGrid = !store.snapToGrid;
  promptFn(`Grid Snap ${store.snapToGrid ? 'ON' : 'OFF'}`);
}

function togglePolarTracking() {
  store.polarTrackingOn = !store.polarTrackingOn;
  if (store.polarTrackingOn) store.orthoOn = false;
  promptFn(`Polar Tracking ${store.polarTrackingOn ? 'ON' : 'OFF'} (${store.polarTrackingAngle}°)`);
}

// === DROPDOWN MENUS ===

let activeMenu: HTMLElement | null = null;

function closeAllMenus() {
  document.querySelectorAll('.menu-dropdown').forEach(d => d.classList.remove('open'));
  document.querySelectorAll('#menubar > span').forEach(s => s.classList.remove('menu-open'));
  activeMenu = null;
}

function openMenu(span: HTMLElement) {
  closeAllMenus();
  const dropdown = span.querySelector('.menu-dropdown') as HTMLElement;
  if (!dropdown) return;
  dropdown.classList.add('open');
  span.classList.add('menu-open');
  activeMenu = span;
  const rect = span.getBoundingClientRect();
  dropdown.style.left = '0px';
}

menubar.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).closest('.menu-item') || (e.target as HTMLElement).closest('.menu-sep')) return;
  const span = (e.target as HTMLElement).closest('#menubar > span') as HTMLElement;
  if (!span) return;
  e.preventDefault();
  e.stopPropagation();
  if (activeMenu === span) {
    closeAllMenus();
  } else {
    openMenu(span);
  }
});

menubar.addEventListener('mouseover', (e) => {
  if (!activeMenu) return;
  const span = (e.target as HTMLElement).closest('#menubar > span') as HTMLElement;
  if (span && span !== activeMenu) {
    openMenu(span);
  }
});

menubar.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest('.menu-item') as HTMLElement;
  if (!item || item.classList.contains('disabled')) return;
  e.stopPropagation();
  closeAllMenus();
  const cmdName = item.dataset.cmd;
  const action = item.dataset.action;
  if (cmdName) {
    engine.handleInput(cmdName);
    cmdInput.focus();
  } else if (action) {
    handleMenuAction(action);
    cmdInput.focus();
  }
});

function showPromptExamples() {
  const { overlay, dialog } = cloudDialog();
  dialog.className = 'cloud-dialog prompt-dialog';
  dialog.innerHTML = `
    <div class="cloud-dialog-title">
      <span>Design with Prompt — Copy &amp; Paste to Claude.ai</span>
      <button id="prompt-ex-close">&times;</button>
    </div>
    <div class="prompt-body">
      <p style="color:#999;margin-bottom:10px;">Copy any prompt below and paste it into <b>Claude.ai</b> with the SonCAD MCP server connected.
      Claude will analyze your request, push entities via MCP, take a screenshot to verify, and iterate until correct.</p>

      <h3>Mechanical Parts</h3>

      <div class="prompt-card">
        <div class="prompt-card-title">1. L-Bracket with Fillet</div>
        <div class="prompt-card-desc">Classic L-shaped bracket with bolt holes and filleted inner corner.</div>
        <div class="prompt-card-text">Draw an L-bracket mechanical part with these specs:
- Overall shape: an L-bracket (vertical arm 30mm wide × 100mm tall, horizontal arm 80mm wide × 30mm tall)
- Inner corner: 10mm radius fillet (smooth arc, NOT a full circle)
- 4 bolt holes: 2 in the vertical arm (Ø8, centered at x=15), 2 in the horizontal arm (Ø8, centered at y=15)
- Origin at bottom-left corner

After pushing the entities, call take_screenshot to verify the result. Check that:
1. The fillet is a small 90° arc at the inner corner, not a full circle or 270° sweep
2. All lines connect properly
3. Bolt holes are circles, not arcs

If the arc looks wrong, fix the startAngle/endAngle and re-push. Iterate until the screenshot looks correct.<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">line</span><span class="prompt-tag">arc</span><span class="prompt-tag">circle</span><span class="prompt-tag">fillet</span></div>
      </div>

      <div class="prompt-card">
        <div class="prompt-card-title">2. Flange Plate</div>
        <div class="prompt-card-desc">Circular flange with bolt circle and center bore.</div>
        <div class="prompt-card-text">Draw a circular flange plate:
- Outer diameter: 120mm
- Center bore: Ø30
- Bolt circle: 6 equally spaced bolt holes (Ø10) on a 90mm diameter circle
- Add center crosshair lines extending 10mm past the outer circle
- Add dimension text labels: "Ø120" near outer edge, "Ø30" near bore, "6xØ10 PCD90" near a bolt hole

Call take_screenshot after drawing to verify hole spacing and labels.<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">circle</span><span class="prompt-tag">text</span><span class="prompt-tag">pattern</span></div>
      </div>

      <div class="prompt-card">
        <div class="prompt-card-title">3. Shaft with Keyway</div>
        <div class="prompt-card-desc">Cross-section of a stepped shaft with keyway slot.</div>
        <div class="prompt-card-text">Draw a cross-section view of a stepped shaft:
- Main shaft: Ø50 circle at center (0,0)
- Step-down: Ø35 circle (concentric, shown as dashed/lighter)
- Keyway: rectangular slot 14mm wide × 5.5mm deep cut from the top of the Ø50 circle
- Center point marker at origin
- Dimension labels: "Ø50", "Ø35", "14×5.5 KEYWAY"

Call take_screenshot to verify the keyway is properly positioned at the top of the shaft.<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">circle</span><span class="prompt-tag">line</span><span class="prompt-tag">text</span></div>
      </div>

      <div class="prompt-card">
        <div class="prompt-card-title">4. Mounting Bracket (U-shape)</div>
        <div class="prompt-card-desc">U-shaped channel bracket with mounting holes and fillets.</div>
        <div class="prompt-card-text">Draw a U-shaped mounting bracket (front view):
- Overall width: 100mm, height: 60mm, wall thickness: 8mm
- U-opening faces upward, inner width 84mm, inner height 52mm
- 4 fillet arcs (R5) at all inner corners of the U-channel
- 2 mounting holes (Ø6) in the base, spaced 60mm apart, centered
- Origin at bottom-left corner of outer profile

Call take_screenshot to verify fillets are smooth 90° arcs and the U-channel looks correct.
If any fillet appears as a full circle, fix the arc angles and re-push.<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">line</span><span class="prompt-tag">arc</span><span class="prompt-tag">circle</span><span class="prompt-tag">fillet</span></div>
      </div>

      <div class="prompt-card">
        <div class="prompt-card-title">5. Gasket with Bolt Pattern</div>
        <div class="prompt-card-desc">Rectangular gasket with rounded corners and bolt holes.</div>
        <div class="prompt-card-text">Draw a rectangular gasket:
- Outer rectangle: 150mm × 80mm with R10 rounded corners (use arcs at all 4 corners)
- Center cutout: 100mm × 40mm rectangle (centered, sharp corners)
- 8 bolt holes (Ø8): 2 per side, evenly spaced along each long and short edge
- Origin at center of the gasket

Call take_screenshot to verify:
1. Rounded corners are smooth quarter-circle arcs
2. Center cutout is properly centered
3. All 8 bolt holes are present and evenly spaced<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">line</span><span class="prompt-tag">arc</span><span class="prompt-tag">circle</span><span class="prompt-tag">rounded corners</span></div>
      </div>

      <h3>Architectural / Layout</h3>

      <div class="prompt-card">
        <div class="prompt-card-title">6. Studio Apartment Floor Plan</div>
        <div class="prompt-card-desc">Simple one-room layout with kitchen, bathroom, and furniture.</div>
        <div class="prompt-card-text">Draw a studio apartment floor plan (top-down view):
- Overall: 8m × 5m outer walls (wall thickness: 200mm, use double lines)
- Entry door: 900mm opening on the south wall, left side
- Bathroom: 2m × 2.5m partition in the bottom-right corner, with door opening
- Kitchen counter: L-shaped polyline along the top-left corner, 600mm deep
- Labels: "LIVING/BEDROOM", "BATH", "KITCHEN" in each zone
- Window: 1.5m opening on the east wall (show as thin line)
- Scale: 1 unit = 1mm

Call take_screenshot to verify room proportions and label placement.<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">line</span><span class="prompt-tag">polyline</span><span class="prompt-tag">text</span><span class="prompt-tag">architecture</span></div>
      </div>

      <div class="prompt-card">
        <div class="prompt-card-title">7. Parking Lot Layout</div>
        <div class="prompt-card-desc">Parking area with numbered stalls, driving lanes, and markings.</div>
        <div class="prompt-card-text">Draw a small parking lot layout:
- 8 parking stalls in a single row, each 2.5m × 5m
- Driving lane: 6m wide in front of the stalls
- Number each stall: "P1" through "P8"
- Handicap stall: P1 is wider (3.5m) with "HC" label
- Entry/exit arrows: lines with arrowhead at the lane ends
- Boundary: outer rectangle around the entire lot

Call take_screenshot to verify stall spacing and numbering.<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">line</span><span class="prompt-tag">text</span><span class="prompt-tag">layout</span></div>
      </div>

      <h3>Electronic / Schematic</h3>

      <div class="prompt-card">
        <div class="prompt-card-title">8. Simple Circuit Symbol</div>
        <div class="prompt-card-desc">A resistor, capacitor, and LED in series circuit.</div>
        <div class="prompt-card-text">Draw a simple series circuit (schematic style):
- Horizontal wire from left (0,0) to (20,0)
- Resistor symbol at (20,0) to (40,0): zigzag pattern using polyline (4 peaks)
- Wire from (40,0) to (60,0)
- Capacitor symbol at (60,0): two parallel vertical lines with gap
- Wire from (60,0) to (80,0)
- LED symbol at (80,0): triangle with line, plus two small arrows
- Wire back to start
- Labels: "R1 10kΩ", "C1 100nF", "D1 LED"
- "+" and "-" at battery terminals

Call take_screenshot to verify the symbols look correct and labels are readable.<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">polyline</span><span class="prompt-tag">line</span><span class="prompt-tag">text</span><span class="prompt-tag">schematic</span></div>
      </div>

      <h3>Patterns / Geometric</h3>

      <div class="prompt-card">
        <div class="prompt-card-title">9. Hexagonal Grid Pattern</div>
        <div class="prompt-card-desc">Honeycomb pattern for perforated sheet design.</div>
        <div class="prompt-card-text">Draw a hexagonal honeycomb perforation pattern:
- 5 × 4 grid of regular hexagons
- Each hexagon: 10mm flat-to-flat (inscribed circle diameter)
- Spacing: 2mm between hexagons
- Draw each hexagon as a closed polyline with 6 vertices
- Outer boundary: rectangle enclosing the entire pattern with 5mm margin
- Title text: "PERF PATTERN - HEX 10/2" at the bottom

Call take_screenshot to verify hexagons are regular and properly spaced.<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">polyline</span><span class="prompt-tag">text</span><span class="prompt-tag">pattern</span></div>
      </div>

      <div class="prompt-card">
        <div class="prompt-card-title">10. Gear Profile (Simplified)</div>
        <div class="prompt-card-desc">Simplified spur gear tooth profile for illustration.</div>
        <div class="prompt-card-text">Draw a simplified spur gear profile:
- Pitch circle: Ø60 (dashed or light color, as reference)
- Outer circle (addendum): Ø68
- Root circle (dedendum): Ø52
- 12 teeth: each tooth is a trapezoid shape protruding from the root circle to the outer circle
- Center bore: Ø15 with keyway (3mm × 3mm square notch at top)
- Label: "12T M5" near the gear

Call take_screenshot to verify tooth count and symmetry.
If teeth are uneven, recalculate the angular spacing (30° per tooth) and re-push.<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">circle</span><span class="prompt-tag">polyline</span><span class="prompt-tag">text</span><span class="prompt-tag">pattern</span></div>
      </div>

      <div class="prompt-card">
        <div class="prompt-card-title">11. Title Block / Drawing Border</div>
        <div class="prompt-card-desc">Standard A3 drawing border with title block and fields.</div>
        <div class="prompt-card-text">Draw a standard A3 drawing border (landscape):
- Outer border: 420mm × 297mm
- Inner margin: 10mm on all sides (leaves 400mm × 277mm drawing area)
- Title block: bottom-right corner, 180mm × 50mm, divided into rows:
  Row 1 (top, 15mm tall): "TITLE:" | (empty field 120mm wide)
  Row 2 (12mm tall): "DWG NO:" | "REV:" | "SHEET:"
  Row 3 (12mm tall): "DRAWN BY:" | "DATE:" | "SCALE:"
  Row 4 (11mm tall): "COMPANY NAME" centered across full width
- All text height: 3mm
- Company logo area: 25mm × 25mm box in bottom-left of title block

Call take_screenshot to verify proportions and text alignment.<span class="prompt-copy-btn">Copy</span></div>
        <div class="prompt-card-tags"><span class="prompt-tag">line</span><span class="prompt-tag">text</span><span class="prompt-tag">template</span></div>
      </div>

      <div class="cloud-btn-row" style="margin-top:12px;">
        <button class="cloud-btn primary" id="prompt-ex-ok">Close</button>
      </div>
    </div>`;
  overlay.classList.add('open');

  const close = () => { overlay.classList.remove('open'); dialog.className = 'cloud-dialog'; cmdInput.focus(); };
  dialog.querySelector('#prompt-ex-close')!.addEventListener('click', close);
  dialog.querySelector('#prompt-ex-ok')!.addEventListener('click', close);

  dialog.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.prompt-copy-btn') as HTMLElement;
    if (!btn) return;
    const textEl = btn.closest('.prompt-card-text') as HTMLElement;
    if (!textEl) return;
    const clone = textEl.cloneNode(true) as HTMLElement;
    const copyBtn = clone.querySelector('.prompt-copy-btn');
    if (copyBtn) copyBtn.remove();
    const text = clone.textContent || '';
    navigator.clipboard.writeText(text.trim()).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
    });
  });
}

function handleMenuAction(action: string) {
  switch (action) {
    case 'new':
      store.pushUndo('NEW');
      store.entities = [];
      store.emit();
      promptFn('New drawing');
      break;
    case 'open': dxfOpen(); break;
    case 'save': dxfSave(); break;
    case 'exit': promptFn('Close the browser tab to exit.'); break;
    case 'selectall':
      for (const e of store.entities) if (e.visible) e.selected = true;
      store.emit();
      promptFn(`${store.selectedEntities().length} selected`);
      break;
    case 'deselectall':
      store.clearSelection();
      store.emit();
      break;
    case 'zoomall':
      engine.handleInput('ZOOM');
      engine.handleInput('a');
      break;
    case 'help': showHelp(); break;
    case 'f3': toggleOsnap(); break;
    case 'f7': engine.handleInput('GRID'); break;
    case 'f8': engine.handleInput('ORTHO'); break;
    case 'f9': toggleGridSnap(); break;
    case 'cadastral': openCadastralDialog(promptFn); break;
    case 'cloud-open': cloudOpen(); break;
    case 'cloud-save': cloudSave(); break;
    case 'mcp-tutorial': showMcpTutorial(); break;
    case 'mech-drawing': showMechDrawing(); break;
    case 'prompt-examples': showPromptExamples(); break;
    case 'mcp-debug': toggleMcpDebug(); break;
  }
}

document.addEventListener('mousedown', (e) => {
  if (activeMenu && !(e.target as HTMLElement).closest('#menubar')) {
    closeAllMenus();
  }
  if (contextMenu.classList.contains('open') && !(e.target as HTMLElement).closest('#context-menu')) {
    contextMenu.classList.remove('open');
  }
});

// === CONTEXT MENU (Right-Click) ===

function showContextMenu(x: number, y: number) {
  const items: string[] = [];
  if (engine.isActive) {
    items.push(`<div class="menu-item" data-ctx="enter">Enter</div>`);
    items.push(`<div class="menu-item" data-ctx="cancel">Cancel</div>`);
  } else {
    const lastCmd = store.lastCommand;
    if (lastCmd) {
      items.push(`<div class="menu-item" data-ctx="repeat">Repeat ${lastCmd}</div>`);
      items.push(`<div class="menu-sep"></div>`);
    }
    const hasSel = store.selectedEntities().length > 0;
    if (hasSel) {
      items.push(`<div class="menu-item" data-ctx="cmd:MOVE">Move</div>`);
      items.push(`<div class="menu-item" data-ctx="cmd:COPY">Copy</div>`);
      items.push(`<div class="menu-item" data-ctx="cmd:ERASE">Erase</div>`);
      items.push(`<div class="menu-item" data-ctx="cmd:ROTATE">Rotate</div>`);
      items.push(`<div class="menu-item" data-ctx="cmd:SCALE">Scale</div>`);
      items.push(`<div class="menu-item" data-ctx="cmd:MIRROR">Mirror</div>`);
      items.push(`<div class="menu-sep"></div>`);
      items.push(`<div class="menu-item" data-ctx="deselect">Deselect All</div>`);
    } else {
      items.push(`<div class="menu-item" data-ctx="selectall">Select All</div>`);
      items.push(`<div class="menu-sep"></div>`);
      items.push(`<div class="menu-item" data-ctx="zoomall">Zoom All</div>`);
      items.push(`<div class="menu-item" data-ctx="cmd:ZOOM">Zoom Window</div>`);
      items.push(`<div class="menu-item" data-ctx="cmd:PAN">Pan</div>`);
    }
  }
  contextMenu.innerHTML = items.join('');
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.classList.add('open');

  requestAnimationFrame(() => {
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) contextMenu.style.left = (window.innerWidth - rect.width - 2) + 'px';
    if (rect.bottom > window.innerHeight) contextMenu.style.top = (window.innerHeight - rect.height - 2) + 'px';
  });
}

contextMenu.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest('.menu-item') as HTMLElement;
  if (!item) return;
  contextMenu.classList.remove('open');
  const ctx = item.dataset.ctx;
  if (!ctx) return;
  if (ctx === 'enter') {
    engine.handleInput('');
  } else if (ctx === 'cancel') {
    engine.cancel();
    appendHistory('*Cancel*');
  } else if (ctx === 'repeat') {
    if (store.lastCommand) engine.handleInput(store.lastCommand);
  } else if (ctx.startsWith('cmd:')) {
    engine.handleInput(ctx.slice(4));
  } else if (ctx === 'selectall') {
    for (const ent of store.entities) if (ent.visible) ent.selected = true;
    store.emit();
    promptFn(`${store.selectedEntities().length} selected`);
  } else if (ctx === 'deselect') {
    store.clearSelection();
    store.emit();
  } else if (ctx === 'zoomall') {
    engine.handleInput('ZOOM');
    engine.handleInput('a');
  }
  cmdInput.focus();
});

// === INIT ===

renderer.resize();
store.view = { panX: -200, panY: 200, zoom: 2 };
appendHistory('SonCAD — 쉼터배치도 도면 작성 (관공서 신고서류용)');
appendHistory('지적도 버튼으로 VWorld 지적도를 가져오고, 쉼터배치 버튼으로 배치도를 작성하세요.');
appendHistory('Type a command or press F1 for help.');
requestAnimationFrame(frame);

canvas.style.cursor = 'none';
cmdInput.focus();
