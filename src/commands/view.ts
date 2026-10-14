import { Point } from '../types';
import { store } from '../store';
import { entityBounds } from '../geometry';
import { CommandEngine } from './engine';

export function registerViewCommands(engine: CommandEngine) {

  engine.register('ZOOM', ['Z'], () => {
    engine.prompt('ZOOM [All/Extents/Window/Previous/Scale/Center/Realtime] <Extents>:');
    engine.waitForInput('Zoom:', (input) => {
      const lower = input.toLowerCase();
      if (lower === 'r' || lower === 'realtime') {
        store.pushView();
        engine.prompt('ZOOM Realtime: drag up to zoom in, down to zoom out. Press Enter/Esc to exit.');
        let lastY: number | null = null;
        engine.onMove((pt) => {
          const canvas = document.getElementById('cad-canvas') as HTMLCanvasElement;
          if (!canvas || lastY === null) return;
          const screenPt = store.worldToScreen(pt);
          const dy = lastY - screenPt.y;
          if (Math.abs(dy) > 1) {
            const factor = 1 + dy * 0.005;
            store.view.zoom *= factor;
            store.view.zoom = Math.max(0.01, Math.min(1000, store.view.zoom));
            store.emit();
          }
          lastY = screenPt.y;
        });
        engine.waitForClick((pt) => {
          lastY = store.worldToScreen(pt).y;
        });
        engine.waitForInput('Zoom RT:', (_) => {
          lastY = null;
          engine.prompt('Zoom realtime ended');
          engine.complete();
          return true;
        });
        return true;
      }
      if (lower === 'e' || lower === 'extents' || lower === '') {
        store.pushView();
        zoomExtents();
        engine.prompt('Zoom extents');
      } else if (lower === 'a' || lower === 'all') {
        store.pushView();
        store.view = { panX: -500, panY: 500, zoom: 0.5 };
        store.emit();
        engine.prompt('Zoom all');
      } else if (lower === 'w' || lower === 'window') {
        engine.prompt('Specify first corner:');
        engine.waitForClick((c1) => {
          engine.prompt('Specify opposite corner:');
          engine.onMove((p) => {
            engine.renderer.selectionBox = { p1: c1, p2: p };
          });
          engine.waitForClick((c2) => {
            engine.renderer.selectionBox = null;
            const canvas = document.getElementById('cad-canvas') as HTMLCanvasElement;
            if (!canvas) { engine.complete(); return; }
            const rect = canvas.getBoundingClientRect();
            const minX = Math.min(c1.x, c2.x), maxX = Math.max(c1.x, c2.x);
            const minY = Math.min(c1.y, c2.y), maxY = Math.max(c1.y, c2.y);
            const extW = maxX - minX || 1, extH = maxY - minY || 1;
            store.pushView();
            const zoom = Math.min(rect.width / extW, rect.height / extH);
            store.view.zoom = zoom;
            store.view.panX = minX;
            store.view.panY = maxY;
            store.emit();
            engine.prompt('Zoom window');
            engine.complete();
          });
        });
        return true;
      } else if (lower === 'p' || lower === 'previous') {
        const prev = store.popView();
        if (prev) {
          store.view = prev;
          store.emit();
          engine.prompt('Zoom previous');
        } else {
          engine.prompt('No previous view');
        }
      } else if (lower === 's' || lower === 'scale') {
        engine.prompt('Enter scale factor (e.g. 2 = zoom in 2x, 0.5 = zoom out):');
        engine.waitForInput('Scale:', (val) => {
          const factor = parseFloat(val);
          if (isNaN(factor) || factor <= 0) {
            engine.prompt('Invalid scale factor');
            engine.complete();
            return true;
          }
          const canvas = document.getElementById('cad-canvas') as HTMLCanvasElement;
          if (!canvas) { engine.complete(); return true; }
          const rect = canvas.getBoundingClientRect();
          const cx = rect.width / 2, cy = rect.height / 2;
          const worldCenter = store.screenToWorld(cx, cy);
          store.pushView();
          store.view.zoom *= factor;
          store.view.zoom = Math.max(0.01, Math.min(1000, store.view.zoom));
          const newCenter = store.screenToWorld(cx, cy);
          store.view.panX -= newCenter.x - worldCenter.x;
          store.view.panY -= newCenter.y - worldCenter.y;
          store.emit();
          engine.prompt(`Zoom scale ${factor}x`);
          engine.complete();
          return true;
        });
        return true;
      } else if (lower === 'c' || lower === 'center') {
        engine.prompt('Specify center point:');
        engine.waitForClick((centerPt) => {
          engine.prompt('Enter magnification or height <current>:');
          engine.waitForInput('Magnification:', (val) => {
            const canvas = document.getElementById('cad-canvas') as HTMLCanvasElement;
            if (!canvas) { engine.complete(); return true; }
            const rect = canvas.getBoundingClientRect();
            store.pushView();
            if (val !== '') {
              const mag = parseFloat(val);
              if (!isNaN(mag) && mag > 0) {
                store.view.zoom = rect.height / mag;
              }
            }
            store.view.panX = centerPt.x - rect.width / (2 * store.view.zoom);
            store.view.panY = centerPt.y + rect.height / (2 * store.view.zoom);
            store.emit();
            engine.prompt('Zoom center');
            engine.complete();
            return true;
          });
        });
        return true;
      } else {
        const factor = parseFloat(lower);
        if (!isNaN(factor) && factor > 0) {
          const canvas = document.getElementById('cad-canvas') as HTMLCanvasElement;
          if (canvas) {
            const rect = canvas.getBoundingClientRect();
            const cx = rect.width / 2, cy = rect.height / 2;
            const worldCenter = store.screenToWorld(cx, cy);
            store.pushView();
            store.view.zoom *= factor;
            store.view.zoom = Math.max(0.01, Math.min(1000, store.view.zoom));
            const newCenter = store.screenToWorld(cx, cy);
            store.view.panX -= newCenter.x - worldCenter.x;
            store.view.panY -= newCenter.y - worldCenter.y;
            store.emit();
          }
          engine.prompt(`Zoom ${factor}x`);
        } else {
          engine.prompt('Unknown ZOOM option');
        }
      }
      engine.complete();
      return true;
    });
  });

  // === VIEW (named views) ===
  engine.register('VIEW', ['V'], () => {
    engine.prompt('VIEW [Save/Restore/Delete/List] <List>:');
    engine.waitForInput('Option:', (input) => {
      const lower = input.toLowerCase();
      if (lower === '' || lower === 'list' || lower === 'l') {
        if (store.namedViews.size === 0) {
          engine.prompt('No named views defined');
        } else {
          for (const [name, v] of store.namedViews) {
            engine.prompt(`  "${name}" — pan(${v.panX.toFixed(1)}, ${v.panY.toFixed(1)}) zoom=${v.zoom.toFixed(3)}`);
          }
        }
        engine.complete();
        return true;
      }
      if (lower === 'save' || lower === 's') {
        engine.prompt('Enter view name:');
        engine.waitForInput('Name:', (name) => {
          if (!name) { engine.complete(); return true; }
          store.namedViews.set(name, { ...store.view });
          engine.prompt(`View "${name}" saved`);
          engine.complete();
          return true;
        });
        return true;
      }
      if (lower === 'restore' || lower === 'r') {
        if (store.namedViews.size > 0) {
          engine.prompt(`Available: ${Array.from(store.namedViews.keys()).join(', ')}`);
        }
        engine.prompt('Enter view name to restore:');
        engine.waitForInput('Name:', (name) => {
          const v = store.namedViews.get(name);
          if (!v) { engine.prompt(`View "${name}" not found`); engine.complete(); return true; }
          store.pushView();
          store.view = { ...v };
          store.emit();
          engine.prompt(`View "${name}" restored`);
          engine.complete();
          return true;
        });
        return true;
      }
      if (lower === 'delete' || lower === 'd') {
        engine.prompt('Enter view name to delete:');
        engine.waitForInput('Name:', (name) => {
          if (store.namedViews.delete(name)) {
            engine.prompt(`View "${name}" deleted`);
          } else {
            engine.prompt(`View "${name}" not found`);
          }
          engine.complete();
          return true;
        });
        return true;
      }
      engine.prompt(`Invalid option "${input}". [Save/Restore/Delete/List]`);
      engine.complete();
      return true;
    });
  });

  engine.register('PAN', ['P'], () => {
    store.tool = 'pan';
    store.pushView();
    engine.prompt('PAN Press Esc or Enter when done. Click and drag to pan.');
    engine.waitForInput('PAN:', (_input) => {
      store.tool = 'idle';
      engine.prompt('PAN complete');
      engine.complete();
      return true;
    });
  });

  // === REGENALL ===
  engine.register('REGENALL', ['REA'], () => {
    store.emit();
    engine.prompt('REGENALL: Drawing regenerated');
    engine.complete();
  });
}

export function zoomExtents() {
  const canvas = document.getElementById('cad-canvas') as HTMLCanvasElement;
  if (!canvas) return;
  if (store.entities.length === 0) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of store.entities) {
    const b = entityBounds(e);
    if (!b) continue;
    minX = Math.min(minX, b.min.x); minY = Math.min(minY, b.min.y);
    maxX = Math.max(maxX, b.max.x); maxY = Math.max(maxY, b.max.y);
  }
  if (!isFinite(minX)) return;

  const padding = 50;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width - padding * 2;
  const h = rect.height - padding * 2;
  const extW = maxX - minX || 1;
  const extH = maxY - minY || 1;
  const zoom = Math.min(w / extW, h / extH);

  store.view.zoom = zoom;
  store.view.panX = minX - padding / zoom;
  store.view.panY = maxY + padding / zoom;
  store.emit();
}
