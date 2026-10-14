import { SnapMode } from '../types';
import { store } from '../store';
import { pointOnEntity } from '../geometry';
import { CommandEngine } from './engine';
import { startShelterMode } from '../shelter';

export function registerSettingsCommands(engine: CommandEngine) {

  engine.register('OSNAP', ['OS'], () => {
    const current = Array.from(store.snapModes).join(', ');
    engine.prompt(`OSNAP Current: ${current}. Enter modes (end,mid,cen,int,per,nea):`);
    engine.waitForInput('Osnap modes:', (input) => {
      if (input.toLowerCase() === 'none') {
        store.snapModes.clear();
        engine.prompt('All snaps off');
      } else {
        const modeMap: Record<string, SnapMode> = {
          end: 'endpoint', mid: 'midpoint', cen: 'center', int: 'intersection',
          per: 'perpendicular', tan: 'tangent', qua: 'quadrant', nea: 'nearest',
        };
        store.snapModes.clear();
        for (const token of input.split(',')) {
          const mode = modeMap[token.trim().toLowerCase()];
          if (mode) store.snapModes.add(mode);
        }
        engine.prompt(`Osnap: ${Array.from(store.snapModes).join(', ')}`);
      }
      engine.complete();
      return true;
    });
  });

  engine.register('ORTHO', ['F8', 'OR'], () => {
    store.orthoOn = !store.orthoOn;
    if (store.orthoOn) store.polarTrackingOn = false;
    engine.prompt(`ORTHO ${store.orthoOn ? 'on' : 'off'}`);
    engine.complete();
  });

  engine.register('POLARANG', [], () => {
    engine.prompt(`POLARANG Current polar tracking angle: ${store.polarTrackingAngle}°`);
    engine.prompt('Enter increment angle [90/45/30/15/10/5] or custom:');
    engine.waitForInput('Angle:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const val = parseFloat(input);
      if (isNaN(val) || val <= 0 || val > 360) {
        engine.prompt('Invalid angle. Must be between 0 and 360.');
        engine.complete();
        return true;
      }
      store.polarTrackingAngle = val;
      engine.prompt(`Polar tracking angle set to ${val}°`);
      engine.complete();
      return true;
    });
  });

  engine.register('POLARMODE', [], () => {
    store.polarTrackingOn = !store.polarTrackingOn;
    if (store.polarTrackingOn) store.orthoOn = false;
    engine.prompt(`Polar Tracking ${store.polarTrackingOn ? 'ON' : 'OFF'} (${store.polarTrackingAngle}°)`);
    engine.complete();
  });

  engine.register('GRID', ['G'], () => {
    store.gridOn = !store.gridOn;
    engine.prompt(`Grid ${store.gridOn ? 'on' : 'off'}`);
    engine.complete();
  });

  engine.register('SNAP', ['SN'], () => {
    engine.prompt(`SNAP Current spacing: ${store.gridSpacing}, Snap: ${store.snapToGrid ? 'ON' : 'OFF'}. Enter spacing or [ON/OFF]:`);
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const lower = input.toLowerCase();
      if (lower === 'on') { store.snapToGrid = true; engine.prompt('Snap ON'); engine.complete(); return true; }
      if (lower === 'off') { store.snapToGrid = false; engine.prompt('Snap OFF'); engine.complete(); return true; }
      const val = parseFloat(input);
      if (isNaN(val) || val <= 0) { engine.prompt('Must be a positive number'); engine.complete(); return true; }
      store.gridSpacing = val;
      store.snapToGrid = true;
      engine.prompt(`Snap spacing set to ${val}, Snap ON`);
      engine.complete();
      return true;
    };
  });

  engine.register('UNDO', ['U', 'CTRL+Z'], () => {
    const label = store.undo();
    engine.prompt(label ? `Undo: ${label}` : 'Nothing to undo');
    engine.complete();
  });

  engine.register('REDO', ['CTRL+Y'], () => {
    const label = store.redo();
    engine.prompt(label ? `Redo: ${label}` : 'Nothing to redo');
    engine.complete();
  });

  engine.register('OOPS', [], () => {
    const label = store.undo();
    if (label === 'ERASE') {
      engine.prompt('OOPS: Erased objects restored');
    } else if (label) {
      store.redo();
      engine.prompt('OOPS: No erased objects to restore (use UNDO instead)');
    } else {
      engine.prompt('Nothing to restore');
    }
    engine.complete();
  });

  // === LAYER (LA) ===
  engine.register('LAYER', ['LA'], () => {
    const current = store.currentLayer();
    engine.prompt(`LAYER Current: "${current.name}". Enter option [New/Set/Color/ON/OFF/Lock/Unlock/Rename/List]:`);
    engine.inputHandler = (input) => {
      const lower = input.toLowerCase();
      if (lower === '' || lower === 'list') {
        for (const l of store.layers) {
          const flags = [
            l.current ? 'Current' : '',
            l.visible ? 'On' : 'Off',
            l.locked ? 'Locked' : '',
            l.plot === false ? 'No-plot' : '',
          ].filter(Boolean).join(', ');
          engine.prompt(`  "${l.name}" Color: ${l.color} [${flags}]`);
        }
        engine.complete();
        return true;
      }
      if (lower === 'new' || lower === 'n') {
        engine.prompt('Enter new layer name:');
        engine.inputHandler = (name) => {
          if (!name) { engine.complete(); return true; }
          if (store.layers.find(l => l.name === name)) {
            engine.prompt(`Layer "${name}" already exists`);
          } else {
            store.layers.push({ name, color: '#ffffff', visible: true, locked: false, frozen: false, current: false, lineweight: 1, plot: true });
            engine.prompt(`Layer "${name}" created`);
          }
          engine.complete();
          return true;
        };
        return true;
      }
      if (lower === 'set' || lower === 's') {
        engine.prompt('Enter layer name to set current:');
        engine.inputHandler = (name) => {
          const layer = store.layers.find(l => l.name === name);
          if (!layer) { engine.prompt(`Layer "${name}" not found`); }
          else {
            store.layers.forEach(l => l.current = false);
            layer.current = true;
            engine.prompt(`Current layer: "${name}"`);
          }
          engine.complete();
          return true;
        };
        return true;
      }
      if (lower === 'color' || lower === 'c') {
        engine.prompt('Enter layer name:');
        engine.inputHandler = (name) => {
          const layer = store.layers.find(l => l.name === name);
          if (!layer) { engine.prompt(`Layer "${name}" not found`); engine.complete(); return true; }
          engine.prompt('Enter color (hex e.g. #ff0000, or name: red/green/blue/yellow/cyan/magenta/white):');
          engine.inputHandler = (colorInput) => {
            const colorMap: Record<string, string> = {
              red: '#ff0000', green: '#00ff00', blue: '#0000ff',
              yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff',
              white: '#ffffff', gray: '#808080', orange: '#ff8000',
            };
            const color = colorMap[colorInput.toLowerCase()] || colorInput;
            layer.color = color;
            store.emit();
            engine.prompt(`Layer "${name}" color set to ${color}`);
            engine.complete();
            return true;
          };
          return true;
        };
        return true;
      }
      if (lower === 'on') {
        engine.prompt('Enter layer name to turn ON:');
        engine.inputHandler = (name) => {
          const layer = store.layers.find(l => l.name === name);
          if (layer) { layer.visible = true; store.emit(); engine.prompt(`Layer "${name}" ON`); }
          else engine.prompt(`Layer "${name}" not found`);
          engine.complete();
          return true;
        };
        return true;
      }
      if (lower === 'off') {
        engine.prompt('Enter layer name to turn OFF:');
        engine.inputHandler = (name) => {
          const layer = store.layers.find(l => l.name === name);
          if (layer) { layer.visible = false; store.emit(); engine.prompt(`Layer "${name}" OFF`); }
          else engine.prompt(`Layer "${name}" not found`);
          engine.complete();
          return true;
        };
        return true;
      }
      if (lower === 'lock') {
        engine.prompt('Enter layer name to lock:');
        engine.inputHandler = (name) => {
          const layer = store.layers.find(l => l.name === name);
          if (layer) { layer.locked = true; engine.prompt(`Layer "${name}" locked`); }
          else engine.prompt(`Layer "${name}" not found`);
          engine.complete();
          return true;
        };
        return true;
      }
      if (lower === 'unlock') {
        engine.prompt('Enter layer name to unlock:');
        engine.inputHandler = (name) => {
          const layer = store.layers.find(l => l.name === name);
          if (layer) { layer.locked = false; engine.prompt(`Layer "${name}" unlocked`); }
          else engine.prompt(`Layer "${name}" not found`);
          engine.complete();
          return true;
        };
        return true;
      }
      if (lower === 'rename' || lower === 'r') {
        engine.prompt('Enter layer name to rename:');
        engine.inputHandler = (oldName) => {
          const layer = store.layers.find(l => l.name === oldName);
          if (!layer) { engine.prompt(`Layer "${oldName}" not found`); engine.complete(); return true; }
          engine.prompt('Enter new name:');
          engine.inputHandler = (newName) => {
            if (!newName) { engine.complete(); return true; }
            for (const e of store.entities) { if (e.layer === oldName) e.layer = newName; }
            layer.name = newName;
            store.emit();
            engine.prompt(`Layer renamed to "${newName}"`);
            engine.complete();
            return true;
          };
          return true;
        };
        return true;
      }
      engine.prompt(`Invalid option "${input}". [New/Set/Color/ON/OFF/Lock/Unlock/Rename/List]:`);
      return true;
    };
  });

  // === LINETYPE (LT) ===
  engine.register('LINETYPE', ['LT'], () => {
    const types = ['continuous', 'dashed', 'hidden', 'center', 'dashdot', 'phantom', 'dot', 'border', 'divide'];
    engine.prompt(`LINETYPE Available: ${types.join(', ')}. Enter linetype name:`);
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const lt = input.toLowerCase();
      if (!types.includes(lt)) { engine.prompt(`Unknown linetype "${input}"`); engine.complete(); return true; }
      const sel = store.selectedEntities();
      if (sel.length > 0) {
        store.pushUndo('LINETYPE');
        for (const e of sel) e.linetype = lt;
        store.emit();
        engine.prompt(`${sel.length} object(s) set to ${lt}`);
      } else {
        engine.prompt(`Default linetype set to ${lt} (select objects first to apply)`);
      }
      engine.complete();
      return true;
    };
  });

  // === LINEWEIGHT (LW) ===
  engine.register('LINEWEIGHT', ['LW', 'LWEIGHT'], () => {
    engine.prompt('LINEWEIGHT Enter lineweight value:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const lw = parseFloat(input);
      if (isNaN(lw) || lw < 0) { engine.prompt('Invalid lineweight'); engine.complete(); return true; }
      const sel = store.selectedEntities();
      if (sel.length > 0) {
        store.pushUndo('LINEWEIGHT');
        for (const e of sel) e.lineweight = lw;
        store.emit();
        engine.prompt(`${sel.length} object(s) lineweight set to ${lw}`);
      } else {
        engine.prompt('No objects selected');
      }
      engine.complete();
      return true;
    };
  });

  // === LWDISPLAY (LWT) — lineweight display toggle ===
  engine.register('LWDISPLAY', ['LWT'], () => {
    store.lwDisplay = !store.lwDisplay;
    engine.prompt(`Lineweight display: ${store.lwDisplay ? 'ON' : 'OFF'}`);
    store.emit();
    engine.complete();
  });

  // === MATCHPROP (MA) ===
  engine.register('MATCHPROP', ['MA'], () => {
    engine.prompt('MATCHPROP Select source object:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const source = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
      if (!source) { engine.prompt('No object found'); engine.complete(); return; }
      engine.prompt(`Source: ${source.type} on layer "${source.layer}". Select destination object(s):`);
      const applyMatch = () => {
        engine.inputHandler = (input) => {
          if (input === '') { engine.complete(); return true; }
          return false;
        };
        engine.waitForClick((pt2) => {
          const target = store.entities.find(e => e.visible && e.id !== source.id && pointOnEntity(pt2, e, tol));
          if (target) {
            store.pushUndo('MATCHPROP');
            target.layer = source.layer;
            target.color = source.color;
            target.linetype = source.linetype;
            target.lineweight = source.lineweight;
            store.emit();
            engine.prompt('Properties matched');
          }
          applyMatch();
        });
      };
      applyMatch();
    });
  });

  // === GROUP (G) ===
  engine.register('GROUP', ['GR'], () => {
    engine.prompt('GROUP Enter option [New/Add/Remove/List/Select]:');
    engine.inputHandler = (input) => {
      const lower = input.toLowerCase();
      if (lower === '' || lower === 'list') {
        if (store.groups.size === 0) {
          engine.prompt('No groups defined');
        } else {
          for (const [name, ids] of store.groups) {
            engine.prompt(`  "${name}" — ${ids.length} object(s)`);
          }
        }
        engine.complete();
        return true;
      }
      if (lower === 'new' || lower === 'n') {
        engine.prompt('Enter group name:');
        engine.inputHandler = (name) => {
          if (!name) { engine.complete(); return true; }
          engine.requireSelection((sel) => {
            store.groups.set(name, sel.map(e => e.id));
            store.clearSelection();
            engine.prompt(`Group "${name}" created with ${sel.length} object(s)`);
            engine.complete();
          });
          return true;
        };
        return true;
      }
      if (lower === 'add' || lower === 'a') {
        engine.prompt('Enter group name to add to:');
        engine.inputHandler = (name) => {
          const ids = store.groups.get(name);
          if (!ids) { engine.prompt(`Group "${name}" not found`); engine.complete(); return true; }
          engine.requireSelection((sel) => {
            for (const e of sel) { if (!ids.includes(e.id)) ids.push(e.id); }
            store.clearSelection();
            engine.prompt(`${sel.length} object(s) added to "${name}"`);
            engine.complete();
          });
          return true;
        };
        return true;
      }
      if (lower === 'remove' || lower === 'r') {
        engine.prompt('Enter group name to remove from:');
        engine.inputHandler = (name) => {
          const ids = store.groups.get(name);
          if (!ids) { engine.prompt(`Group "${name}" not found`); engine.complete(); return true; }
          engine.requireSelection((sel) => {
            const removeIds = new Set(sel.map(e => e.id));
            store.groups.set(name, ids.filter(id => !removeIds.has(id)));
            store.clearSelection();
            engine.prompt(`${sel.length} object(s) removed from "${name}"`);
            engine.complete();
          });
          return true;
        };
        return true;
      }
      if (lower === 'select' || lower === 's') {
        engine.prompt('Enter group name to select:');
        engine.inputHandler = (name) => {
          const ids = store.groups.get(name);
          if (!ids) { engine.prompt(`Group "${name}" not found`); engine.complete(); return true; }
          store.clearSelection();
          let count = 0;
          for (const e of store.entities) {
            if (ids.includes(e.id)) { e.selected = true; count++; }
          }
          store.emit();
          engine.prompt(`${count} object(s) selected from group "${name}"`);
          engine.complete();
          return true;
        };
        return true;
      }
      engine.prompt(`Invalid option "${input}". [New/Add/Remove/List/Select]:`);
      return true;
    };
  });

  // === STYLE (ST) ===
  engine.register('STYLE', ['ST'], () => {
    const cur = store.textStyles.find(s => s.name === store.currentTextStyle) || store.textStyles[0];
    engine.prompt(`STYLE Current: "${cur.name}" (${cur.fontFamily}, h=${cur.height}, w=${cur.widthFactor}). Enter option [New/Set/List/Delete]:`);
    engine.waitForInput('Option:', (input) => {
      const lower = input.toLowerCase();
      if (lower === '' || lower === 'list' || lower === 'l') {
        for (const s of store.textStyles) {
          const flag = s.name === store.currentTextStyle ? ' (current)' : '';
          engine.prompt(`  "${s.name}" font=${s.fontFamily} h=${s.height} w=${s.widthFactor} oblique=${s.oblique}°${flag}`);
        }
        engine.complete();
        return true;
      }
      if (lower === 'new' || lower === 'n') {
        engine.prompt('Enter new style name:');
        engine.waitForInput('Name:', (name) => {
          if (!name) { engine.complete(); return true; }
          if (store.textStyles.find(s => s.name.toLowerCase() === name.toLowerCase())) {
            engine.prompt(`Style "${name}" already exists`);
            engine.complete();
            return true;
          }
          engine.prompt('Enter font family <monospace>:');
          engine.waitForInput('Font:', (fontInput) => {
            const fontFamily = fontInput || 'monospace';
            engine.prompt('Enter default text height <2.5>:');
            engine.waitForInput('Height:', (hInput) => {
              const height = parseFloat(hInput) || 2.5;
              engine.prompt('Enter width factor <1>:');
              engine.waitForInput('Width factor:', (wInput) => {
                const widthFactor = parseFloat(wInput) || 1;
                engine.prompt('Enter oblique angle <0>:');
                engine.waitForInput('Oblique:', (oInput) => {
                  const oblique = parseFloat(oInput) || 0;
                  store.textStyles.push({ name, fontFamily, height, widthFactor, oblique });
                  store.currentTextStyle = name;
                  engine.prompt(`Style "${name}" created and set current`);
                  engine.complete();
                  return true;
                });
                return true;
              });
              return true;
            });
            return true;
          });
          return true;
        });
        return true;
      }
      if (lower === 'set' || lower === 's') {
        const names = store.textStyles.map(s => s.name).join(', ');
        engine.prompt(`Available styles: ${names}. Enter style name:`);
        engine.waitForInput('Style:', (name) => {
          const style = store.textStyles.find(s => s.name.toLowerCase() === name.toLowerCase());
          if (!style) { engine.prompt(`Style "${name}" not found`); engine.complete(); return true; }
          store.currentTextStyle = style.name;
          engine.prompt(`Current text style: "${style.name}"`);
          engine.complete();
          return true;
        });
        return true;
      }
      if (lower === 'delete' || lower === 'd') {
        engine.prompt('Enter style name to delete:');
        engine.waitForInput('Style:', (name) => {
          if (name.toLowerCase() === 'standard') { engine.prompt('Cannot delete Standard style'); engine.complete(); return true; }
          const idx = store.textStyles.findIndex(s => s.name.toLowerCase() === name.toLowerCase());
          if (idx < 0) { engine.prompt(`Style "${name}" not found`); engine.complete(); return true; }
          const styleName = store.textStyles[idx].name;
          store.textStyles.splice(idx, 1);
          if (store.currentTextStyle === styleName) store.currentTextStyle = 'Standard';
          engine.prompt(`Style "${styleName}" deleted`);
          engine.complete();
          return true;
        });
        return true;
      }
      engine.prompt(`Invalid option "${input}". [New/Set/List/Delete]`);
      engine.complete();
      return true;
    });
  });

  // === COLOR (COL) ===
  engine.register('COLOR', ['COL'], () => {
    engine.prompt(`COLOR Current: ${store.currentColor}. Enter new color [ByLayer/ByBlock/1-7/hex #rrggbb] <${store.currentColor}>:`);
    engine.waitForInput('Color:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const lower = input.toLowerCase();
      if (lower === 'bylayer') {
        store.currentColor = 'bylayer';
      } else if (lower === 'byblock') {
        store.currentColor = 'byblock';
      } else {
        store.currentColor = input.trim();
      }
      engine.prompt(`Current color set to "${store.currentColor}"`);
      engine.complete();
      return true;
    });
  });

  // === PURGE (PU) ===
  engine.register('PURGE', ['PU'], () => {
    engine.prompt('PURGE unused [Layers/Blocks/Groups/All] <All>:');
    engine.waitForInput('Purge:', (input) => {
      const lower = input.toLowerCase() || 'all';
      const usedLayers = new Set(store.entities.map(e => e.layer));
      const usedBlocks = new Set(
        store.entities.filter(e => e.type === 'blockref').map(e => (e as any).blockName as string)
      );
      const validEntityIds = new Set(store.entities.map(e => e.id));
      let purged = 0;

      if (lower === 'all' || lower === 'a' || lower === 'layers' || lower === 'l') {
        const toRemove = store.layers.filter(l => !usedLayers.has(l.name) && !l.current && l.name !== '0');
        for (const l of toRemove) {
          store.layers = store.layers.filter(la => la.name !== l.name);
          engine.prompt(`  Purged layer "${l.name}"`);
          purged++;
        }
      }

      if (lower === 'all' || lower === 'a' || lower === 'blocks' || lower === 'b') {
        for (const [name] of store.blockDefs) {
          if (!usedBlocks.has(name)) {
            store.blockDefs.delete(name);
            engine.prompt(`  Purged block "${name}"`);
            purged++;
          }
        }
      }

      if (lower === 'all' || lower === 'a' || lower === 'groups' || lower === 'g') {
        for (const [name, ids] of store.groups) {
          const alive = ids.filter(id => validEntityIds.has(id));
          if (alive.length === 0) {
            store.groups.delete(name);
            engine.prompt(`  Purged empty group "${name}"`);
            purged++;
          } else {
            store.groups.set(name, alive);
          }
        }
      }

      engine.prompt(purged > 0 ? `${purged} item(s) purged` : 'Nothing to purge');
      store.emit();
      engine.complete();
      return true;
    });
  });

  // === SAVEAS ===
  engine.register('SAVEAS', [], () => {
    engine.prompt('SAVEAS Enter format [DXF/SVG/JSON] <JSON>:');
    engine.waitForInput('Format:', (fmtInput) => {
      const fmt = fmtInput.toLowerCase() || 'json';
      engine.prompt('Enter filename:');
      engine.waitForInput('Filename:', (nameInput) => {
        const name = nameInput.trim() || 'drawing';
        if (fmt === 'dxf') {
          (window as any).dxfSave();
          engine.prompt('Saved as DXF');
        } else if (fmt === 'svg') {
          (window as any).plotSVG?.(name + '.svg');
          engine.prompt(`Saved as ${name}.svg`);
        } else if (fmt === 'json') {
          const data = {
            entities: store.entities,
            layers: store.layers,
            blockDefs: Array.from(store.blockDefs.entries()),
            groups: Array.from(store.groups.entries()),
            dimStyles: store.dimStyles,
            textStyles: store.textStyles,
            namedViews: Array.from(store.namedViews.entries()),
          };
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = name.endsWith('.json') ? name : name + '.json';
          a.click();
          URL.revokeObjectURL(url);
          engine.prompt(`Saved as ${a.download}`);
        } else {
          engine.prompt(`Unknown format "${fmt}". Use DXF, SVG, or JSON.`);
        }
        engine.complete();
        return true;
      });
      return true;
    });
  });

  // === RENAME (REN) ===
  engine.register('RENAME', ['REN'], () => {
    engine.prompt('RENAME [Block/Layer/Group/View/Dimstyle/Textstyle]:');
    engine.waitForInput('Type:', (input) => {
      const lower = input.toLowerCase();

      if (lower === 'layer' || lower === 'l') {
        engine.prompt('Enter current layer name:');
        engine.waitForInput('Old name:', (oldName) => {
          const layer = store.layers.find(l => l.name === oldName);
          if (!layer) { engine.prompt(`Layer "${oldName}" not found`); engine.complete(); return true; }
          engine.prompt('Enter new name:');
          engine.waitForInput('New name:', (newName) => {
            if (!newName) { engine.complete(); return true; }
            for (const e of store.entities) { if (e.layer === oldName) e.layer = newName; }
            layer.name = newName;
            store.emit();
            engine.prompt(`Layer renamed "${oldName}" → "${newName}"`);
            engine.complete();
            return true;
          });
          return true;
        });
        return true;
      }

      if (lower === 'block' || lower === 'b') {
        engine.prompt('Enter current block name:');
        engine.waitForInput('Old name:', (oldName) => {
          if (!store.blockDefs.has(oldName)) { engine.prompt(`Block "${oldName}" not found`); engine.complete(); return true; }
          engine.prompt('Enter new name:');
          engine.waitForInput('New name:', (newName) => {
            if (!newName) { engine.complete(); return true; }
            const def = store.blockDefs.get(oldName)!;
            store.blockDefs.delete(oldName);
            store.blockDefs.set(newName, def);
            for (const e of store.entities) {
              if (e.type === 'blockref' && e.blockName === oldName) e.blockName = newName;
            }
            store.emit();
            engine.prompt(`Block renamed "${oldName}" → "${newName}"`);
            engine.complete();
            return true;
          });
          return true;
        });
        return true;
      }

      if (lower === 'group' || lower === 'g') {
        engine.prompt('Enter current group name:');
        engine.waitForInput('Old name:', (oldName) => {
          if (!store.groups.has(oldName)) { engine.prompt(`Group "${oldName}" not found`); engine.complete(); return true; }
          engine.prompt('Enter new name:');
          engine.waitForInput('New name:', (newName) => {
            if (!newName) { engine.complete(); return true; }
            const ids = store.groups.get(oldName)!;
            store.groups.delete(oldName);
            store.groups.set(newName, ids);
            engine.prompt(`Group renamed "${oldName}" → "${newName}"`);
            engine.complete();
            return true;
          });
          return true;
        });
        return true;
      }

      if (lower === 'view' || lower === 'v') {
        engine.prompt('Enter current view name:');
        engine.waitForInput('Old name:', (oldName) => {
          if (!store.namedViews.has(oldName)) { engine.prompt(`View "${oldName}" not found`); engine.complete(); return true; }
          engine.prompt('Enter new name:');
          engine.waitForInput('New name:', (newName) => {
            if (!newName) { engine.complete(); return true; }
            const v = store.namedViews.get(oldName)!;
            store.namedViews.delete(oldName);
            store.namedViews.set(newName, v);
            engine.prompt(`View renamed "${oldName}" → "${newName}"`);
            engine.complete();
            return true;
          });
          return true;
        });
        return true;
      }

      if (lower === 'dimstyle' || lower === 'd') {
        engine.prompt('Enter current dim style name:');
        engine.waitForInput('Old name:', (oldName) => {
          const style = store.dimStyles.find(s => s.name === oldName);
          if (!style) { engine.prompt(`Dim style "${oldName}" not found`); engine.complete(); return true; }
          engine.prompt('Enter new name:');
          engine.waitForInput('New name:', (newName) => {
            if (!newName) { engine.complete(); return true; }
            style.name = newName;
            if (store.currentDimStyle.name === oldName) store.currentDimStyle.name = newName;
            engine.prompt(`Dim style renamed "${oldName}" → "${newName}"`);
            engine.complete();
            return true;
          });
          return true;
        });
        return true;
      }

      if (lower === 'textstyle' || lower === 't') {
        engine.prompt('Enter current text style name:');
        engine.waitForInput('Old name:', (oldName) => {
          const style = store.textStyles.find(s => s.name.toLowerCase() === oldName.toLowerCase());
          if (!style) { engine.prompt(`Text style "${oldName}" not found`); engine.complete(); return true; }
          engine.prompt('Enter new name:');
          engine.waitForInput('New name:', (newName) => {
            if (!newName) { engine.complete(); return true; }
            const prevName = style.name;
            style.name = newName;
            if (store.currentTextStyle === prevName) store.currentTextStyle = newName;
            for (const e of store.entities) {
              if (e.type === 'text' && e.textStyle === prevName) e.textStyle = newName;
            }
            engine.prompt(`Text style renamed "${prevName}" → "${newName}"`);
            engine.complete();
            return true;
          });
          return true;
        });
        return true;
      }

      engine.prompt(`Unknown type "${input}". [Block/Layer/Group/View/Dimstyle/Textstyle]`);
      engine.complete();
      return true;
    });
  });

  // === FILL ===
  engine.register('FILL', [], () => {
    engine.prompt(`FILL mode [ON/OFF] <${store.fillOn ? 'ON' : 'OFF'}>:`);
    engine.waitForInput('Fill:', (input) => {
      const lower = input.toLowerCase();
      if (lower === 'on' || lower === '') {
        store.fillOn = true;
        engine.prompt('Fill mode ON — solids/hatches are filled');
      } else if (lower === 'off') {
        store.fillOn = false;
        engine.prompt('Fill mode OFF — solids/hatches show outlines only');
      } else {
        engine.prompt('Enter ON or OFF');
      }
      store.emit();
      engine.complete();
      return true;
    });
  });

  // === BASE ===
  engine.register('BASE', [], () => {
    const bp = store.basePoint;
    engine.prompt(`BASE Current base point: (${bp.x}, ${bp.y}). Specify base point:`);
    engine.waitForClick((pt) => {
      store.basePoint = { x: pt.x, y: pt.y };
      engine.prompt(`Base point set to (${pt.x.toFixed(4)}, ${pt.y.toFixed(4)})`);
      engine.complete();
    });
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const pt = engine.parseCoordinate(input);
      if (pt) { engine.handleClick(pt); return true; }
      return false;
    };
  });

  // === MULTIPLE ===
  engine.register('MULTIPLE', ['MUL'], () => {
    engine.prompt('MULTIPLE Enter command name to repeat:');
    engine.waitForInput('Command:', (input) => {
      if (!input) { engine.complete(); return true; }
      const upper = input.toUpperCase();
      let cmdDef = engine.commands.get(upper);
      if (!cmdDef) {
        for (const [, def] of engine.commands) {
          if (def.aliases.some(a => a === upper)) { cmdDef = def; break; }
        }
      }
      if (!cmdDef) {
        engine.prompt(`Unknown command: ${input}`);
        engine.complete();
        return true;
      }
      const targetName = cmdDef.name;
      engine.prompt(`Repeating ${targetName}. Press Esc to stop.`);

      const origComplete = engine.complete.bind(engine);
      const runAgain = () => {
        const def = engine.commands.get(targetName);
        if (!def) { origComplete(); return; }
        engine.activeCommand = def.name;
        engine.complete = () => {
          engine.activeCommand = null;
          engine.clickHandler = null;
          engine.inputHandler = null;
          engine.cancelHandler = null;
          engine.moveHandler = null;
          engine.tempPoints = [];
          engine.renderer.rubberBand = null;
          engine.renderer.rubberCircle = null;
          engine.renderer.rubberArc = null;
          engine.renderer.rubberRect = null;
          engine.renderer.rubberPolyline = null;
          engine.renderer.rubberEllipse = null;
          store.tool = 'idle';
          engine.prompt(`${targetName} complete. Repeating...`);
          setTimeout(runAgain, 0);
        };
        def.execute();
      };

      const origCancel = engine.cancel.bind(engine);
      engine.cancelHandler = () => {
        engine.complete = origComplete;
        engine.cancel = origCancel;
        engine.prompt('MULTIPLE ended');
        origCancel();
      };

      engine.complete();
      runAgain();
      return true;
    });
  });

  // === DDPTYPE — Point display type/size ===
  engine.register('DDPTYPE', ['PTYPE'], () => {
    engine.prompt(`DDPTYPE Current: PDMODE=${store.pdmode}, PDSIZE=${store.pdsize}`);
    engine.prompt('Point styles: 0=dot, 1=none, 2=cross(+), 3=X');
    engine.prompt('Add 32 for circle, 64 for square, 96 for both');
    engine.prompt('Enter PDMODE value:');
    engine.waitForInput('PDMODE:', (modeInput) => {
      const mode = parseInt(modeInput);
      if (!isNaN(mode) && mode >= 0) {
        store.pdmode = mode;
      }
      engine.prompt(`Enter PDSIZE <${store.pdsize}>:`);
      engine.waitForInput('PDSIZE:', (sizeInput) => {
        const size = parseFloat(sizeInput);
        if (!isNaN(size) && size > 0) {
          store.pdsize = size;
        }
        for (const e of store.entities) {
          if (e.type === 'point') {
            e.pdmode = store.pdmode;
            e.pdsize = store.pdsize;
          }
        }
        store.emit();
        engine.prompt(`Point display: PDMODE=${store.pdmode}, PDSIZE=${store.pdsize}. ${store.entities.filter(e => e.type === 'point').length} point(s) updated.`);
        engine.complete();
        return true;
      });
      return true;
    });
  });

  // === REGEN / REDRAW ===
  engine.register('REGEN', ['RE'], () => {
    store.emit();
    engine.prompt('Regenerating model — done');
    engine.complete();
  });

  engine.register('REDRAW', ['R'], () => {
    store.emit();
    engine.prompt('Redrawing — done');
    engine.complete();
  });

  // === LIMITS ===
  engine.register('LIMITS', [], () => {
    const lim = store.drawingLimits;
    engine.prompt(`LIMITS Current: (${lim.min.x}, ${lim.min.y}) to (${lim.max.x}, ${lim.max.y})  Limits checking: ${store.limitsOn ? 'ON' : 'OFF'}`);
    engine.prompt('Enter option [ON/OFF] or specify lower-left corner:');
    engine.waitForInput('Lower-left:', (input) => {
      const lower = input.toLowerCase();
      if (lower === 'on') { store.limitsOn = true; engine.prompt('Limits checking ON'); engine.complete(); return true; }
      if (lower === 'off') { store.limitsOn = false; engine.prompt('Limits checking OFF'); engine.complete(); return true; }
      if (input === '') { engine.complete(); return true; }
      const ll = engine.parseCoordinate(input);
      if (!ll) { engine.prompt('Invalid coordinate'); engine.complete(); return true; }
      engine.prompt(`Upper-right corner <${lim.max.x},${lim.max.y}>:`);
      engine.waitForInput('Upper-right:', (input2) => {
        if (input2 === '') { engine.complete(); return true; }
        const ur = engine.parseCoordinate(input2);
        if (!ur) { engine.prompt('Invalid coordinate'); engine.complete(); return true; }
        store.drawingLimits = { min: ll, max: ur };
        engine.prompt(`Limits set: (${ll.x}, ${ll.y}) to (${ur.x}, ${ur.y})`);
        engine.complete();
        return true;
      });
      return true;
    });
  });

  // === QTEXT ===
  engine.register('QTEXT', ['QT'], () => {
    engine.prompt(`QTEXT Quick text mode: ${store.qtextOn ? 'ON' : 'OFF'}`);
    engine.prompt('Enter new value [ON/OFF] <toggle>:');
    engine.waitForInput('QTEXT:', (input) => {
      const lower = input.toLowerCase();
      if (lower === 'on') { store.qtextOn = true; }
      else if (lower === 'off') { store.qtextOn = false; }
      else if (lower === '') { store.qtextOn = !store.qtextOn; }
      else { engine.prompt('Invalid option. Use ON or OFF.'); engine.complete(); return true; }
      store.emit();
      engine.prompt(`Quick text mode ${store.qtextOn ? 'ON — text displayed as rectangles' : 'OFF — text displayed normally'}`);
      engine.complete();
      return true;
    });
  });

  // === ATTDISP ===
  engine.register('ATTDISP', [], () => {
    engine.prompt(`ATTDISP Attribute display mode: ${store.attDispMode.toUpperCase()}`);
    engine.prompt('  Normal = respect attribute visibility flags');
    engine.prompt('  ON     = display all attributes');
    engine.prompt('  OFF    = hide all attributes');
    engine.prompt('Enter mode [Normal/ON/OFF] <Normal>:');
    engine.waitForInput('Mode:', (input) => {
      const lower = input.toLowerCase();
      if (lower === 'on') { store.attDispMode = 'on'; }
      else if (lower === 'off') { store.attDispMode = 'off'; }
      else if (lower === 'normal' || lower === 'n' || lower === '') { store.attDispMode = 'normal'; }
      else { engine.prompt('Invalid mode. Use Normal, ON, or OFF.'); engine.complete(); return true; }
      store.emit();
      engine.prompt(`Attribute display: ${store.attDispMode.toUpperCase()}`);
      engine.complete();
      return true;
    });
  });

  // === SETVAR ===
  engine.register('SETVAR', [], () => {
    const vars: Record<string, { get: () => string; set: (v: string) => void }> = {
      DIMTXT: {
        get: () => String(store.currentDimStyle.textHeight),
        set: (v) => { const n = parseFloat(v); if (!isNaN(n) && n > 0) store.currentDimStyle.textHeight = n; },
      },
      DIMASZ: {
        get: () => String(store.currentDimStyle.arrowSize),
        set: (v) => { const n = parseFloat(v); if (!isNaN(n) && n > 0) store.currentDimStyle.arrowSize = n; },
      },
      DIMEXO: {
        get: () => String(store.currentDimStyle.extensionOffset),
        set: (v) => { const n = parseFloat(v); if (!isNaN(n) && n >= 0) store.currentDimStyle.extensionOffset = n; },
      },
      DIMDEC: {
        get: () => String(store.currentDimStyle.precision),
        set: (v) => { const n = parseInt(v); if (!isNaN(n) && n >= 0 && n <= 8) store.currentDimStyle.precision = n; },
      },
      GRIDSIZE: {
        get: () => String(store.gridSpacing),
        set: (v) => { const n = parseFloat(v); if (!isNaN(n) && n > 0) store.gridSpacing = n; },
      },
      LTSCALE: {
        get: () => String(store.ltScale),
        set: (v) => { const n = parseFloat(v); if (!isNaN(n) && n > 0) store.ltScale = n; },
      },
      ORTHOMODE: {
        get: () => store.orthoOn ? '1' : '0',
        set: (v) => { store.orthoOn = v === '1'; if (store.orthoOn) store.polarTrackingOn = false; },
      },
      POLARMODE: {
        get: () => store.polarTrackingOn ? '1' : '0',
        set: (v) => { store.polarTrackingOn = v === '1'; if (store.polarTrackingOn) store.orthoOn = false; },
      },
      POLARANG: {
        get: () => String(store.polarTrackingAngle),
        set: (v) => { const n = parseFloat(v); if (!isNaN(n) && n > 0 && n <= 360) store.polarTrackingAngle = n; },
      },
      GRIDMODE: {
        get: () => store.gridOn ? '1' : '0',
        set: (v) => { store.gridOn = v === '1'; },
      },
      SNAPMODE: {
        get: () => store.snapToGrid ? '1' : '0',
        set: (v) => { store.snapToGrid = v === '1'; },
      },
      FILLMODE: {
        get: () => store.fillOn ? '1' : '0',
        set: (v) => { store.fillOn = v === '1'; },
      },
      PDMODE: {
        get: () => String(store.pdmode),
        set: (v) => { const n = parseInt(v); if (!isNaN(n) && n >= 0) store.pdmode = n; },
      },
      PDSIZE: {
        get: () => String(store.pdsize),
        set: (v) => { const n = parseFloat(v); if (!isNaN(n) && n > 0) store.pdsize = n; },
      },
      QTEXTMODE: {
        get: () => store.qtextOn ? '1' : '0',
        set: (v) => { store.qtextOn = v === '1'; },
      },
      ATTDISP: {
        get: () => store.attDispMode,
        set: (v) => { const l = v.toLowerCase(); if (['normal', 'on', 'off'].includes(l)) store.attDispMode = l as any; },
      },
      LUPREC: {
        get: () => String(store.unitPrecision),
        set: (v) => { const n = parseInt(v); if (!isNaN(n) && n >= 0 && n <= 8) store.unitPrecision = n; },
      },
      LIMMIN: {
        get: () => `${store.drawingLimits.min.x},${store.drawingLimits.min.y}`,
        set: () => {},
      },
      LIMMAX: {
        get: () => `${store.drawingLimits.max.x},${store.drawingLimits.max.y}`,
        set: () => {},
      },
      VIEWRES: {
        get: () => String(store.viewRes),
        set: (v) => { const n = parseInt(v); if (!isNaN(n) && n > 0) store.viewRes = n; },
      },
      APERTURE: {
        get: () => String(store.aperture),
        set: (v) => { const n = parseInt(v); if (!isNaN(n) && n > 0 && n <= 50) store.aperture = n; },
      },
    };

    engine.prompt(`SETVAR Variables: ${Object.keys(vars).join(', ')}`);
    engine.prompt('Enter variable name:');
    engine.waitForInput('Variable:', (nameInput) => {
      if (nameInput === '') { engine.complete(); return true; }
      const upper = nameInput.toUpperCase();
      const v = vars[upper];
      if (!v) { engine.prompt(`Unknown variable "${nameInput}"`); engine.complete(); return true; }
      engine.prompt(`${upper} = ${v.get()}`);
      engine.prompt('Enter new value (or Enter to keep):');
      engine.waitForInput('Value:', (val) => {
        if (val === '') { engine.complete(); return true; }
        v.set(val);
        store.emit();
        engine.prompt(`${upper} = ${v.get()}`);
        engine.complete();
        return true;
      });
      return true;
    });
  });

  // === STATUS ===
  engine.register('STATUS', [], () => {
    const entityCounts: Record<string, number> = {};
    for (const e of store.entities) {
      entityCounts[e.type] = (entityCounts[e.type] || 0) + 1;
    }
    const elapsed = Math.floor((Date.now() - store.sessionStart) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    engine.prompt('=== Drawing Status ===');
    engine.prompt(`  Entities: ${store.entities.length}`);
    if (Object.keys(entityCounts).length > 0) {
      engine.prompt(`    ${Object.entries(entityCounts).map(([t, c]) => `${t}: ${c}`).join(', ')}`);
    }
    engine.prompt(`  Layers: ${store.layers.length} (current: "${store.currentLayer().name}")`);
    engine.prompt(`  Block defs: ${store.blockDefs.size}  Groups: ${store.groups.size}`);
    engine.prompt(`  Named views: ${store.namedViews.size}`);
    const lim = store.drawingLimits;
    engine.prompt(`  Limits: (${lim.min.x}, ${lim.min.y}) to (${lim.max.x}, ${lim.max.y})  Checking: ${store.limitsOn ? 'ON' : 'OFF'}`);
    engine.prompt(`  Grid: ${store.gridOn ? 'ON' : 'OFF'} (${store.gridSpacing})  Snap: ${store.snapToGrid ? 'ON' : 'OFF'}  Ortho: ${store.orthoOn ? 'ON' : 'OFF'}  Polar: ${store.polarTrackingOn ? 'ON' : 'OFF'} (${store.polarTrackingAngle}°)`);
    engine.prompt(`  Zoom: ${store.view.zoom.toFixed(3)}  Pan: (${store.view.panX.toFixed(1)}, ${store.view.panY.toFixed(1)})`);
    engine.prompt(`  Session time: ${mins}m ${secs}s`);
    engine.complete();
  });

  // === AUDIT ===
  engine.register('AUDIT', [], () => {
    engine.prompt('AUDIT Fix errors? [Yes/No] <N>:');
    engine.waitForInput('Fix:', (input) => {
      const autoFix = input.toLowerCase().startsWith('y');
      let issues = 0;
      let fixed = 0;

      const layerNames = new Set(store.layers.map(l => l.name));
      for (const e of store.entities) {
        if (!layerNames.has(e.layer)) {
          engine.prompt(`  Entity ${e.id}: on deleted layer "${e.layer}"`);
          issues++;
          if (autoFix) { e.layer = '0'; fixed++; }
        }
      }

      if (store.entities.some(e => e.type === 'blockref')) {
        for (const e of store.entities) {
          if (e.type === 'blockref' && !store.blockDefs.has(e.blockName)) {
            engine.prompt(`  Entity ${e.id}: orphaned block ref "${e.blockName}"`);
            issues++;
            if (autoFix) { store.removeEntity(e.id); fixed++; }
          }
        }
      }

      const ids = new Set<string>();
      for (const e of store.entities) {
        if (ids.has(e.id)) {
          engine.prompt(`  Entity ${e.id}: duplicate ID`);
          issues++;
        }
        ids.add(e.id);
      }

      for (const e of store.entities) {
        if (e.type === 'line') {
          if (e.start.x === e.end.x && e.start.y === e.end.y) {
            engine.prompt(`  Entity ${e.id}: zero-length line`);
            issues++;
            if (autoFix) { store.removeEntity(e.id); fixed++; }
          }
        }
        if (e.type === 'circle' && e.radius <= 0) {
          engine.prompt(`  Entity ${e.id}: zero/negative radius circle`);
          issues++;
          if (autoFix) { store.removeEntity(e.id); fixed++; }
        }
        if (e.type === 'polyline' && e.points.length < 2) {
          engine.prompt(`  Entity ${e.id}: degenerate polyline (${e.points.length} point(s))`);
          issues++;
          if (autoFix) { store.removeEntity(e.id); fixed++; }
        }
      }

      if (issues === 0) {
        engine.prompt('No errors found');
      } else {
        engine.prompt(`${issues} issue(s) found${autoFix ? `, ${fixed} fixed` : ''}`);
      }
      if (autoFix) store.emit();
      engine.complete();
      return true;
    });
  });

  // === SAVE / OPEN ===
  engine.register('SAVE', ['SA'], () => {
    engine.prompt('Saving DXF...');
    (window as any).dxfSave();
    engine.complete();
  });

  engine.register('OPEN', ['DN'], () => {
    (window as any).dxfOpen();
    engine.complete();
  });

  // === UNITS (UN) ===
  engine.register('UNITS', ['UN'], () => {
    const unitTypes = ['decimal', 'architectural', 'engineering', 'fractional', 'scientific'] as const;
    const unitLabels: Record<string, typeof unitTypes[number]> = {
      '1': 'scientific', '2': 'decimal', '3': 'engineering', '4': 'architectural', '5': 'fractional',
      scientific: 'scientific', decimal: 'decimal', engineering: 'engineering', architectural: 'architectural', fractional: 'fractional',
    };
    const angleFormats = ['decimal', 'dms', 'grads', 'radians'] as const;
    const angleLabels: Record<string, typeof angleFormats[number]> = {
      '1': 'decimal', '2': 'dms', '3': 'grads', '4': 'radians',
      decimal: 'decimal', dms: 'dms', grads: 'grads', radians: 'radians',
    };

    engine.prompt(`UNITS Length type: ${store.unitType}, Precision: ${store.unitPrecision}`);
    engine.prompt(`  Angle type: ${store.angleFormat}, Precision: ${store.anglePrecision}`);
    engine.prompt(`  Angle base: ${store.angleBase}°, Direction: ${store.angleDirection}`);
    engine.prompt('Set [Type/Precision/Angle/AnglePrecision/Base/Direction] or Enter to exit:');

    function unitsMenu() {
      engine.waitForInput('UNITS option:', (input) => {
        const lower = input.toLowerCase();
        if (lower === '') { engine.complete(); return true; }
        if (lower === 't' || lower === 'type') {
          engine.prompt('Length unit type — 1=Scientific, 2=Decimal, 3=Engineering, 4=Architectural, 5=Fractional:');
          engine.waitForInput('Type:', (tInput) => {
            const t = unitLabels[tInput.toLowerCase()];
            if (t) { store.unitType = t; engine.prompt(`Length type set to ${t}`); }
            else { engine.prompt('Invalid type'); }
            engine.prompt('Set [Type/Precision/Angle/AnglePrecision/Base/Direction]:');
            unitsMenu();
            return true;
          });
          return true;
        }
        if (lower === 'p' || lower === 'precision') {
          engine.prompt(`Current precision: ${store.unitPrecision}. Enter decimal precision (0-8):`);
          engine.waitForInput('Precision:', (pInput) => {
            const p = parseInt(pInput);
            if (!isNaN(p) && p >= 0 && p <= 8) { store.unitPrecision = p; engine.prompt(`Precision set to ${p}`); }
            else { engine.prompt('Precision must be 0-8'); }
            engine.prompt('Set [Type/Precision/Angle/AnglePrecision/Base/Direction]:');
            unitsMenu();
            return true;
          });
          return true;
        }
        if (lower === 'a' || lower === 'angle') {
          engine.prompt('Angle format — 1=Decimal degrees, 2=Deg/Min/Sec, 3=Grads, 4=Radians:');
          engine.waitForInput('Angle:', (aInput) => {
            const a = angleLabels[aInput.toLowerCase()];
            if (a) { store.angleFormat = a; engine.prompt(`Angle format set to ${a}`); }
            else { engine.prompt('Invalid angle format'); }
            engine.prompt('Set [Type/Precision/Angle/AnglePrecision/Base/Direction]:');
            unitsMenu();
            return true;
          });
          return true;
        }
        if (lower === 'ap' || lower === 'angleprecision') {
          engine.prompt(`Current angle precision: ${store.anglePrecision}. Enter precision (0-8):`);
          engine.waitForInput('Angle precision:', (apInput) => {
            const ap = parseInt(apInput);
            if (!isNaN(ap) && ap >= 0 && ap <= 8) { store.anglePrecision = ap; engine.prompt(`Angle precision set to ${ap}`); }
            else { engine.prompt('Angle precision must be 0-8'); }
            engine.prompt('Set [Type/Precision/Angle/AnglePrecision/Base/Direction]:');
            unitsMenu();
            return true;
          });
          return true;
        }
        if (lower === 'b' || lower === 'base') {
          engine.prompt(`Current angle base: ${store.angleBase}°. Enter angle base (0 = East, 90 = North):`);
          engine.waitForInput('Base angle:', (bInput) => {
            const b = parseFloat(bInput);
            if (!isNaN(b)) { store.angleBase = b; engine.prompt(`Angle base set to ${b}°`); }
            else { engine.prompt('Invalid angle'); }
            engine.prompt('Set [Type/Precision/Angle/AnglePrecision/Base/Direction]:');
            unitsMenu();
            return true;
          });
          return true;
        }
        if (lower === 'd' || lower === 'direction') {
          engine.prompt(`Current direction: ${store.angleDirection}. Enter [CW/CCW]:`);
          engine.waitForInput('Direction:', (dInput) => {
            const dl = dInput.toLowerCase();
            if (dl === 'cw') { store.angleDirection = 'cw'; engine.prompt('Angle direction: clockwise'); }
            else if (dl === 'ccw') { store.angleDirection = 'ccw'; engine.prompt('Angle direction: counter-clockwise'); }
            else { engine.prompt('Enter CW or CCW'); }
            engine.prompt('Set [Type/Precision/Angle/AnglePrecision/Base/Direction]:');
            unitsMenu();
            return true;
          });
          return true;
        }
        engine.prompt('Unknown option. [Type/Precision/Angle/AnglePrecision/Base/Direction]:');
        unitsMenu();
        return true;
      });
    }
    unitsMenu();
  });

  // === LTSCALE (LTS) ===
  engine.register('LTSCALE', ['LTS'], () => {
    engine.prompt(`LTSCALE Current scale: ${store.ltScale}. Enter new linetype scale:`);
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const val = parseFloat(input);
      if (isNaN(val) || val <= 0) { engine.prompt('Must be a positive number'); engine.complete(); return true; }
      store.ltScale = val;
      store.emit();
      engine.prompt(`Linetype scale set to ${val}`);
      engine.complete();
      return true;
    };
  });

  // === NEW ===
  engine.register('NEW', [], () => {
    engine.prompt('NEW Erase all entities and start fresh? [Yes/No] <N>:');
    engine.waitForInput('Confirm:', (input) => {
      if (input.toLowerCase().startsWith('y')) {
        store.pushUndo('NEW');
        store.entities = [];
        store.emit();
        engine.prompt('New drawing started');
      } else {
        engine.prompt('Cancelled');
      }
      engine.complete();
      return true;
    });
  });

  // === LAYMCUR ===
  engine.register('LAYMCUR', [], () => {
    engine.prompt('LAYMCUR Select object whose layer will become current:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const hit = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
      if (!hit) {
        engine.prompt('No object found');
        engine.complete();
        return;
      }
      const targetName = hit.layer;
      for (const l of store.layers) l.current = false;
      let found = store.layers.find(l => l.name === targetName);
      if (!found) {
        found = { name: targetName, color: '#ffffff', visible: true, locked: false, frozen: false, current: true, lineweight: 1, plot: true };
        store.layers.push(found);
      }
      found.current = true;
      store.emit();
      engine.prompt(`Layer "${targetName}" is now current`);
      engine.complete();
    });
  });

  // === LAYISO ===
  engine.register('LAYISO', [], () => {
    engine.prompt('LAYISO Select object on layer to isolate:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const hit = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
      if (!hit) {
        engine.prompt('No object found');
        engine.complete();
        return;
      }
      const keepLayer = hit.layer;
      const hidden: string[] = [];
      for (const l of store.layers) {
        if (l.name !== keepLayer && l.visible) {
          l.visible = false;
          hidden.push(l.name);
        }
      }
      store.isolatedLayers = hidden;
      store.emit();
      engine.prompt(`Layer "${keepLayer}" isolated. ${hidden.length} layer(s) hidden.`);
      engine.complete();
    });
  });

  // === LAYUNISO ===
  engine.register('LAYUNISO', [], () => {
    if (store.isolatedLayers.length === 0) {
      engine.prompt('LAYUNISO No layers to unisolate');
      engine.complete();
      return;
    }
    const names = store.isolatedLayers;
    for (const name of names) {
      const l = store.layers.find(la => la.name === name);
      if (l) l.visible = true;
    }
    store.isolatedLayers = [];
    store.emit();
    engine.prompt(`LAYUNISO ${names.length} layer(s) restored`);
    engine.complete();
  });

  // === VIEWRES ===
  engine.register('VIEWRES', [], () => {
    engine.prompt(`VIEWRES Current view resolution: ${store.viewRes}`);
    engine.prompt('Enter new value (1-20000) <100>:');
    engine.waitForInput('View resolution:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const n = parseInt(input);
      if (isNaN(n) || n < 1 || n > 20000) {
        engine.prompt('Value must be between 1 and 20000');
        engine.complete();
        return true;
      }
      store.viewRes = n;
      store.emit();
      engine.prompt(`View resolution set to ${n}`);
      engine.complete();
      return true;
    });
  });

  // === APERTURE ===
  engine.register('APERTURE', [], () => {
    engine.prompt(`APERTURE Current snap aperture: ${store.aperture} pixels`);
    engine.prompt('Enter new value (1-50) <15>:');
    engine.waitForInput('Aperture:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const n = parseInt(input);
      if (isNaN(n) || n < 1 || n > 50) {
        engine.prompt('Value must be between 1 and 50');
        engine.complete();
        return true;
      }
      store.aperture = n;
      store.emit();
      engine.prompt(`Snap aperture set to ${n} pixels`);
      engine.complete();
      return true;
    });
  });

  // === TIME ===
  engine.register('TIME', [], () => {
    const now = Date.now();
    const elapsed = Math.floor((now - store.sessionStart) / 1000);
    const hrs = Math.floor(elapsed / 3600);
    const mins = Math.floor((elapsed % 3600) / 60);
    const secs = elapsed % 60;

    const startDate = new Date(store.sessionStart);
    const nowDate = new Date(now);

    engine.prompt('=== TIME Statistics ===');
    engine.prompt(`  Session start: ${startDate.toLocaleString()}`);
    engine.prompt(`  Current time:  ${nowDate.toLocaleString()}`);
    engine.prompt(`  Elapsed time:  ${hrs}h ${mins}m ${secs}s`);
    engine.prompt(`  Total entities: ${store.entities.length}`);
    engine.prompt(`  Undo levels used: ${(store as any).undoStack?.length || 0}`);

    engine.prompt('Enter option [Display/ON/OFF/Reset] or Enter to exit:');
    engine.waitForInput('TIME option:', (input) => {
      const lower = input.toLowerCase();
      if (lower === '' || lower === 'd' || lower === 'display') {
        engine.complete();
        return true;
      }
      if (lower === 'r' || lower === 'reset') {
        store.sessionStart = Date.now();
        engine.prompt('Timer reset');
        engine.complete();
        return true;
      }
      if (lower === 'on' || lower === 'off') {
        engine.prompt(`Timer ${lower.toUpperCase()}`);
        engine.complete();
        return true;
      }
      engine.prompt('Unknown option');
      engine.complete();
      return true;
    });
  });

  // === CAL (Quick Calculator) ===
  engine.register('CAL', ['QC'], () => {
    engine.prompt('CAL Expression evaluator. Enter expression (or Enter to exit):');
    engine.prompt('  Supports: + - * / ^ () sqrt() sin() cos() tan() abs() pi');
    engine.prompt('  Distance: dist(x1,y1,x2,y2)  Midpoint: mid(x1,y1,x2,y2)');
    doCalInput(engine);
  });

  // === SELECTALL ===
  engine.register('SELECTALL', [], () => {
    for (const e of store.entities) {
      const layer = store.layers.find(l => l.name === e.layer);
      if (e.visible && layer && layer.visible && !layer.locked) e.selected = true;
    }
    store.emit();
    engine.prompt(`${store.selectedEntities().length} entities selected`);
    engine.complete();
  });

  // === DESELECTALL ===
  engine.register('DESELECTALL', ['DSA'], () => {
    store.clearSelection();
    engine.prompt('All entities deselected');
    engine.complete();
  });

  // === SELECTPREVIOUS ===
  engine.register('SELECTPREVIOUS', ['SELECTP'], () => {
    if (store.previousSelection.length === 0) {
      engine.prompt('No previous selection');
      engine.complete();
      return;
    }
    const idSet = new Set(store.previousSelection);
    let count = 0;
    for (const e of store.entities) {
      if (idSet.has(e.id)) { e.selected = true; count++; }
    }
    store.emit();
    engine.prompt(`${count} entities reselected`);
    engine.complete();
  });

  // === SELECTSIMILAR ===
  engine.register('SELECTSIMILAR', ['SELSIM'], () => {
    const sel = store.selectedEntities();
    if (sel.length === 0) {
      engine.prompt('No entities selected');
      engine.complete();
      return;
    }
    const keys = new Set(sel.map(e => `${e.type}|${e.layer}`));
    let count = 0;
    for (const e of store.entities) {
      if (keys.has(`${e.type}|${e.layer}`)) {
        e.selected = true;
        count++;
      }
    }
    store.emit();
    engine.prompt(`${count} similar entities selected`);
    engine.complete();
  });

  // === ADDSELECTED ===
  engine.register('ADDSELECTED', [], () => {
    const sel = store.selectedEntities();
    if (sel.length !== 1) {
      engine.prompt('Select exactly one entity');
      engine.complete();
      return;
    }
    const e = sel[0];
    store.layers.forEach(l => l.current = false);
    const layer = store.layers.find(l => l.name === e.layer);
    if (layer) layer.current = true;
    store.currentColor = e.color;
    store.clearSelection();
    const typeCmd: Record<string, string> = {
      line: 'LINE', circle: 'CIRCLE', arc: 'ARC', polyline: 'PLINE',
      rect: 'RECTANG', text: 'TEXT', ellipse: 'ELLIPSE', point: 'POINT',
    };
    const cmd = typeCmd[e.type];
    if (cmd) {
      engine.prompt(`ADDSELECTED Layer="${layer?.name}" Color="${e.color}" → ${cmd}`);
      engine.complete();
      engine.handleInput(cmd);
    } else {
      engine.prompt(`Cannot create new ${e.type} entity`);
      engine.complete();
    }
  });

  // === ISOLATEOBJECTS ===
  engine.register('ISOLATEOBJECTS', ['ISOLATE'], () => {
    engine.requireSelection((sel) => {
      const selIds = new Set(sel.map(e => e.id));
      let count = 0;
      for (const e of store.entities) {
        if (!selIds.has(e.id) && e.visible) {
          e.visible = false;
          store.hiddenEntityIds.add(e.id);
          count++;
        }
      }
      store.emit();
      engine.prompt(`${count} object(s) isolated`);
      store.clearSelection();
      engine.complete();
    });
  });

  // === HIDEOBJECTS ===
  engine.register('HIDEOBJECTS', ['OBJECTSHIDE'], () => {
    engine.requireSelection((sel) => {
      for (const e of sel) {
        e.visible = false;
        store.hiddenEntityIds.add(e.id);
      }
      store.emit();
      engine.prompt(`${sel.length} object(s) hidden`);
      store.clearSelection();
      engine.complete();
    });
  });

  // === UNISOLATEOBJECTS ===
  engine.register('UNISOLATEOBJECTS', ['UNISOLATE'], () => {
    if (store.hiddenEntityIds.size === 0) {
      engine.prompt('No hidden objects');
      engine.complete();
      return;
    }
    for (const id of store.hiddenEntityIds) {
      const e = store.entities.find(en => en.id === id);
      if (e) e.visible = true;
    }
    const count = store.hiddenEntityIds.size;
    store.hiddenEntityIds.clear();
    store.emit();
    engine.prompt(`All objects shown (${count} restored)`);
    engine.complete();
  });

  // === FILTER ===
  engine.register('FILTER', [], () => {
    engine.prompt('FILTER Property [Type/Layer/Color/Linetype] <Type>:');
    engine.waitForInput('Property:', (input) => {
      const prop = input === '' ? 'TYPE' : input.toUpperCase();
      if (prop === 'TYPE' || prop === 'T') {
        engine.prompt('Enter entity type (line/circle/arc/polyline/rect/text/ellipse/dimension/point/hatch/blockref):');
        engine.waitForInput('Type:', (tInput) => {
          const t = tInput.toLowerCase();
          let count = 0;
          for (const e of store.entities) {
            if (e.type === t && e.visible) { e.selected = true; count++; }
          }
          store.emit();
          engine.prompt(`FILTER: ${count} object(s) selected`);
          engine.complete();
          return true;
        });
      } else if (prop === 'LAYER' || prop === 'LA') {
        engine.prompt('Enter layer name:');
        engine.waitForInput('Layer:', (lInput) => {
          const ln = lInput.toUpperCase();
          let count = 0;
          for (const e of store.entities) {
            if (e.layer.toUpperCase() === ln && e.visible) { e.selected = true; count++; }
          }
          store.emit();
          engine.prompt(`FILTER: ${count} object(s) selected`);
          engine.complete();
          return true;
        });
      } else if (prop === 'COLOR' || prop === 'COL') {
        engine.prompt('Enter color value:');
        engine.waitForInput('Color:', (cInput) => {
          const cv = cInput.toLowerCase();
          let count = 0;
          for (const e of store.entities) {
            if (e.color.toLowerCase() === cv && e.visible) { e.selected = true; count++; }
          }
          store.emit();
          engine.prompt(`FILTER: ${count} object(s) selected`);
          engine.complete();
          return true;
        });
      } else if (prop === 'LINETYPE' || prop === 'LT') {
        engine.prompt('Enter linetype name:');
        engine.waitForInput('Linetype:', (ltInput) => {
          const lt = ltInput.toLowerCase();
          let count = 0;
          for (const e of store.entities) {
            if (e.linetype.toLowerCase() === lt && e.visible) { e.selected = true; count++; }
          }
          store.emit();
          engine.prompt(`FILTER: ${count} object(s) selected`);
          engine.complete();
          return true;
        });
      } else {
        engine.prompt(`Unknown property "${input}". Use Type/Layer/Color/Linetype.`);
        engine.complete();
      }
      return true;
    });
  });

  // === ABOUT ===
  engine.register('ABOUT', [], () => {
    engine.prompt('MiniCAD — Browser-based 2D CAD');
    engine.prompt('Built for laser cutting workflows');
    engine.prompt('AutoCAD R14 command-line style');
    engine.prompt(`Entities: ${store.entities.length}  Layers: ${store.layers.length}  Commands: ${engine.commands.size}`);
    engine.complete();
  });

  // === EXIT ===
  engine.register('EXIT', ['CLOSE', 'QUIT'], () => {
    engine.prompt('Save changes before closing? [Yes/No/Cancel] <Yes>:');
    engine.waitForInput('Save?:', (input) => {
      const lower = input.toLowerCase();
      if (lower === 'c' || lower === 'cancel') {
        engine.prompt('Command cancelled');
      } else if (lower === 'n' || lower === 'no') {
        engine.prompt('Changes discarded');
      } else {
        engine.prompt('Drawing saved (browser-based, no file system)');
      }
      engine.complete();
      return true;
    });
  });

  // === LAYOFF ===
  engine.register('LAYOFF', [], () => {
    engine.prompt('LAYOFF Enter layer name to turn off:');
    engine.waitForInput('Layer name:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const layer = store.layers.find(l => l.name.toLowerCase() === input.toLowerCase());
      if (!layer) { engine.prompt(`Layer "${input}" not found`); engine.complete(); return true; }
      if (layer.current) { engine.prompt('Cannot turn off current layer'); engine.complete(); return true; }
      layer.visible = false;
      store.emit();
      engine.prompt(`Layer "${layer.name}" turned off`);
      engine.complete();
      return true;
    });
  });

  // === LAYON ===
  engine.register('LAYON', [], () => {
    let count = 0;
    for (const layer of store.layers) {
      if (!layer.visible) { layer.visible = true; count++; }
    }
    store.emit();
    engine.prompt(`LAYON ${count} layer(s) turned on`);
    engine.complete();
  });

  // === LAYFRZ ===
  engine.register('LAYFRZ', [], () => {
    engine.prompt('LAYFRZ Enter layer name to freeze:');
    engine.waitForInput('Layer name:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const layer = store.layers.find(l => l.name.toLowerCase() === input.toLowerCase());
      if (!layer) { engine.prompt(`Layer "${input}" not found`); engine.complete(); return true; }
      if (layer.current) { engine.prompt('Cannot freeze current layer'); engine.complete(); return true; }
      layer.frozen = true;
      store.emit();
      engine.prompt(`Layer "${layer.name}" frozen`);
      engine.complete();
      return true;
    });
  });

  // === LAYTHW ===
  engine.register('LAYTHW', [], () => {
    let count = 0;
    for (const layer of store.layers) {
      if (layer.frozen) { layer.frozen = false; count++; }
    }
    store.emit();
    engine.prompt(`LAYTHW ${count} layer(s) thawed`);
    engine.complete();
  });

  // === LAYLCK ===
  engine.register('LAYLCK', [], () => {
    engine.prompt('LAYLCK Enter layer name to lock:');
    engine.waitForInput('Layer name:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const layer = store.layers.find(l => l.name.toLowerCase() === input.toLowerCase());
      if (!layer) { engine.prompt(`Layer "${input}" not found`); engine.complete(); return true; }
      layer.locked = true;
      store.emit();
      engine.prompt(`Layer "${layer.name}" locked`);
      engine.complete();
      return true;
    });
  });

  // === LAYULK ===
  engine.register('LAYULK', [], () => {
    engine.prompt('LAYULK Enter layer name to unlock:');
    engine.waitForInput('Layer name:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const layer = store.layers.find(l => l.name.toLowerCase() === input.toLowerCase());
      if (!layer) { engine.prompt(`Layer "${input}" not found`); engine.complete(); return true; }
      layer.locked = false;
      store.emit();
      engine.prompt(`Layer "${layer.name}" unlocked`);
      engine.complete();
      return true;
    });
  });

  // === LAYDEL ===
  engine.register('LAYDEL', [], () => {
    engine.prompt('LAYDEL Enter layer name to delete:');
    engine.waitForInput('Layer name:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const layer = store.layers.find(l => l.name.toLowerCase() === input.toLowerCase());
      if (!layer) { engine.prompt(`Layer "${input}" not found`); engine.complete(); return true; }
      if (layer.name === '0') { engine.prompt('Cannot delete layer 0'); engine.complete(); return true; }
      if (layer.current) { engine.prompt('Cannot delete current layer'); engine.complete(); return true; }
      store.pushUndo('LAYDEL');
      const count = store.entities.filter(e => e.layer === layer.name).length;
      store.entities = store.entities.filter(e => e.layer !== layer.name);
      store.layers = store.layers.filter(l => l.name !== layer.name);
      store.emit();
      engine.prompt(`Layer "${layer.name}" deleted with ${count} entities`);
      engine.complete();
      return true;
    });
  });

  // === LAYMRG ===
  engine.register('LAYMRG', [], () => {
    engine.prompt('LAYMRG Enter source layer to merge from:');
    engine.waitForInput('Source layer:', (srcInput) => {
      if (srcInput === '') { engine.complete(); return true; }
      const srcLayer = store.layers.find(l => l.name.toLowerCase() === srcInput.toLowerCase());
      if (!srcLayer) { engine.prompt(`Layer "${srcInput}" not found`); engine.complete(); return true; }
      if (srcLayer.name === '0') { engine.prompt('Cannot merge layer 0'); engine.complete(); return true; }

      engine.inputHandler = null;
      engine.prompt(`Merge layer "${srcLayer.name}" into — Enter target layer:`);
      engine.waitForInput('Target layer:', (tgtInput) => {
        if (tgtInput === '') { engine.complete(); return true; }
        const tgtLayer = store.layers.find(l => l.name.toLowerCase() === tgtInput.toLowerCase());
        if (!tgtLayer) { engine.prompt(`Layer "${tgtInput}" not found`); engine.complete(); return true; }
        if (tgtLayer.name === srcLayer.name) { engine.prompt('Source and target cannot be the same'); engine.complete(); return true; }

        store.pushUndo('LAYMRG');
        let count = 0;
        for (const e of store.entities) {
          if (e.layer === srcLayer.name) {
            e.layer = tgtLayer.name;
            count++;
          }
        }
        store.layers = store.layers.filter(l => l.name !== srcLayer.name);
        store.emit();
        engine.prompt(`Merged ${count} entities from "${srcLayer.name}" into "${tgtLayer.name}"`);
        engine.complete();
        return true;
      });
      return true;
    });
  });

  // === LAYERSTATE ===
  engine.register('LAYERSTATE', ['LAS'], () => {
    engine.prompt('LAYERSTATE [Save/Restore/Delete/List]:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const opt = input.toLowerCase();
      if (opt === 's' || opt === 'save') {
        engine.inputHandler = null;
        engine.prompt('Enter state name:');
        engine.waitForInput('State name:', (name) => {
          if (name === '') { engine.complete(); return true; }
          store.layerStates.set(name, { layers: JSON.parse(JSON.stringify(store.layers)) });
          engine.prompt(`Layer state "${name}" saved`);
          engine.complete();
          return true;
        });
        return true;
      } else if (opt === 'r' || opt === 'restore') {
        engine.inputHandler = null;
        const names = [...store.layerStates.keys()];
        if (names.length === 0) { engine.prompt('No saved layer states'); engine.complete(); return true; }
        engine.prompt(`Restore state [${names.join('/')}]:`);
        engine.waitForInput('State name:', (name) => {
          if (name === '') { engine.complete(); return true; }
          const state = store.layerStates.get(name);
          if (!state) { engine.prompt(`State "${name}" not found`); engine.complete(); return true; }
          store.layers = JSON.parse(JSON.stringify(state.layers));
          store.emit();
          engine.prompt(`Layer state "${name}" restored`);
          engine.complete();
          return true;
        });
        return true;
      } else if (opt === 'd' || opt === 'delete') {
        engine.inputHandler = null;
        engine.prompt('Enter state name to delete:');
        engine.waitForInput('State name:', (name) => {
          if (name === '') { engine.complete(); return true; }
          if (store.layerStates.delete(name)) {
            engine.prompt(`Layer state "${name}" deleted`);
          } else {
            engine.prompt(`State "${name}" not found`);
          }
          engine.complete();
          return true;
        });
        return true;
      } else if (opt === 'l' || opt === 'list') {
        const names = [...store.layerStates.keys()];
        if (names.length === 0) engine.prompt('No saved layer states');
        else engine.prompt(`Layer states: ${names.join(', ')}`);
        engine.complete();
        return true;
      }
      engine.prompt('Invalid option. [Save/Restore/Delete/List]:');
      return true;
    };
  });

  // === LAYWALK ===
  engine.register('LAYWALK', [], () => {
    const layerNames = store.layers.map(l => l.name);
    if (layerNames.length <= 1) {
      engine.prompt('Only one layer exists');
      engine.complete();
      return;
    }
    let currentIdx = 0;
    function showLayer(idx: number) {
      for (let i = 0; i < store.layers.length; i++) {
        store.layers[i].visible = (i === idx);
      }
      store.emit();
      engine.prompt(`LAYWALK [${store.layers[idx].name}] (${idx + 1}/${store.layers.length}) — Enter=next, P=prev, A=all, Q=quit:`);
    }
    showLayer(currentIdx);
    engine.inputHandler = (input) => {
      const opt = input.toLowerCase();
      if (opt === '' || opt === 'n') {
        currentIdx = (currentIdx + 1) % store.layers.length;
        showLayer(currentIdx);
        return true;
      } else if (opt === 'p') {
        currentIdx = (currentIdx - 1 + store.layers.length) % store.layers.length;
        showLayer(currentIdx);
        return true;
      } else if (opt === 'a') {
        store.layers.forEach(l => l.visible = true);
        store.emit();
        engine.prompt('All layers visible');
        engine.complete();
        return true;
      } else if (opt === 'q') {
        store.layers.forEach(l => l.visible = true);
        store.emit();
        engine.complete();
        return true;
      }
      engine.prompt('Enter=next, P=prev, A=all, Q=quit:');
      return true;
    };
  });

  // === DWGPROPS ===
  engine.register('DWGPROPS', [], () => {
    engine.prompt(`DWGPROPS Title: "${store.dwgProps.title}", Author: "${store.dwgProps.author}"`);
    engine.prompt('Enter property to set [Title/Author/Subject/Comments/List]:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const opt = input.toLowerCase();
      if (opt === 'l' || opt === 'list') {
        engine.prompt(`Title: "${store.dwgProps.title}"`);
        engine.prompt(`Author: "${store.dwgProps.author}"`);
        engine.prompt(`Subject: "${store.dwgProps.subject}"`);
        engine.prompt(`Comments: "${store.dwgProps.comments}"`);
        engine.complete();
        return true;
      }
      let prop: keyof typeof store.dwgProps | null = null;
      if (opt === 't' || opt === 'title') prop = 'title';
      else if (opt === 'a' || opt === 'author') prop = 'author';
      else if (opt === 's' || opt === 'subject') prop = 'subject';
      else if (opt === 'c' || opt === 'comments') prop = 'comments';
      if (!prop) {
        engine.prompt('Invalid option. [Title/Author/Subject/Comments/List]:');
        return true;
      }
      const propName = prop;
      engine.inputHandler = null;
      engine.prompt(`Enter ${propName} (current: "${store.dwgProps[propName]}"):`);
      engine.waitForInput(`${propName}:`, (val) => {
        store.dwgProps[propName] = val;
        engine.prompt(`${propName} set to "${val}"`);
        engine.complete();
        return true;
      });
      return true;
    };
  });

  // === QSAVE ===
  engine.register('QSAVE', [], () => {
    const saveFn = (window as any).dxfSave;
    if (saveFn) {
      saveFn();
      engine.prompt('QSAVE Drawing saved');
    } else {
      engine.prompt('Save function not available');
    }
    engine.complete();
  });

  // === MIRRTEXT ===
  engine.register('MIRRTEXT', [], () => {
    engine.prompt(`MIRRTEXT current value: ${store.mirrText ? '1 (text is mirrored)' : '0 (text is not mirrored)'}`);
    engine.prompt('Enter new value [0/1]:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      if (input === '0') {
        store.mirrText = false;
        engine.prompt('MIRRTEXT = 0 (text will not be mirrored)');
        engine.complete();
        return true;
      } else if (input === '1') {
        store.mirrText = true;
        engine.prompt('MIRRTEXT = 1 (text will be mirrored)');
        engine.complete();
        return true;
      }
      engine.prompt('Enter 0 or 1:');
      return true;
    };
  });

  // === CLEANSCREEN ===
  engine.register('CLEANSCREEN', [], () => {
    const statusBar = document.getElementById('status-bar');
    if (statusBar) {
      const hidden = statusBar.style.display === 'none';
      statusBar.style.display = hidden ? '' : 'none';
      engine.prompt(`CLEANSCREEN ${hidden ? 'OFF' : 'ON'} — status bar ${hidden ? 'shown' : 'hidden'}`);
    } else {
      engine.prompt('CLEANSCREEN toggled');
    }
    engine.complete();
  });

  // === TEXTTOFRONT ===
  engine.register('TEXTTOFRONT', ['TTF'], () => {
    const textAndDims = store.entities.filter(e => e.type === 'text' || e.type === 'dimension');
    if (textAndDims.length === 0) {
      engine.prompt('No text or dimension entities found');
      engine.complete();
      return;
    }
    store.pushUndo('TEXTTOFRONT');
    const others = store.entities.filter(e => e.type !== 'text' && e.type !== 'dimension');
    store.entities = [...others, ...textAndDims];
    store.emit();
    engine.prompt(`TEXTTOFRONT ${textAndDims.length} text/dimension entities moved to front`);
    engine.complete();
  });

  // === DSETTINGS ===
  engine.register('DSETTINGS', ['DS'], () => {
    engine.prompt('=== Drafting Settings ===');
    engine.prompt(`Grid: ${store.gridOn ? 'ON' : 'OFF'}, Spacing: ${store.gridSpacing}`);
    engine.prompt(`Snap: ${store.snapToGrid ? 'ON' : 'OFF'}`);
    engine.prompt(`Ortho: ${store.orthoOn ? 'ON' : 'OFF'}`);
    engine.prompt(`Polar Tracking: ${store.polarTrackingOn ? 'ON' : 'OFF'}, Angle: ${store.polarTrackingAngle}°`);
    engine.prompt(`OSNAP: ${store.snapModes.size > 0 ? Array.from(store.snapModes).join(', ') : 'OFF'}`);
    engine.prompt('Set [Grid/Snap/Ortho/Polar/Osnap]:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const opt = input.toLowerCase();
      if (opt === 'g' || opt === 'grid') {
        engine.inputHandler = null;
        engine.prompt(`Grid spacing (current: ${store.gridSpacing}):`);
        engine.waitForInput('Spacing:', (val) => {
          if (val === '') { engine.complete(); return true; }
          const n = parseFloat(val);
          if (isNaN(n) || n <= 0) { engine.prompt('Requires positive number'); engine.complete(); return true; }
          store.gridSpacing = n;
          store.emit();
          engine.prompt(`Grid spacing set to ${n}`);
          engine.complete();
          return true;
        });
        return true;
      } else if (opt === 's' || opt === 'snap') {
        store.snapToGrid = !store.snapToGrid;
        engine.prompt(`Snap to grid ${store.snapToGrid ? 'ON' : 'OFF'}`);
        engine.complete();
        return true;
      } else if (opt === 'o' || opt === 'ortho') {
        store.orthoOn = !store.orthoOn;
        if (store.orthoOn) store.polarTrackingOn = false;
        engine.prompt(`Ortho ${store.orthoOn ? 'ON' : 'OFF'}`);
        engine.complete();
        return true;
      } else if (opt === 'p' || opt === 'polar') {
        store.polarTrackingOn = !store.polarTrackingOn;
        if (store.polarTrackingOn) store.orthoOn = false;
        engine.prompt(`Polar Tracking ${store.polarTrackingOn ? 'ON' : 'OFF'} (${store.polarTrackingAngle}°)`);
        engine.complete();
        return true;
      } else if (opt === 'os' || opt === 'osnap') {
        engine.inputHandler = null;
        engine.prompt('Enter snap modes (end,mid,cen,int,per,nea,tan,qua) or "none":');
        engine.waitForInput('Modes:', (modesInput) => {
          if (modesInput === '') { engine.complete(); return true; }
          if (modesInput.toLowerCase() === 'none') {
            store.snapModes.clear();
            engine.prompt('All snaps off');
          } else {
            const modeMap2: Record<string, SnapMode> = {
              end: 'endpoint', mid: 'midpoint', cen: 'center', int: 'intersection',
              per: 'perpendicular', tan: 'tangent', qua: 'quadrant', nea: 'nearest',
            };
            store.snapModes.clear();
            for (const token of modesInput.split(',')) {
              const mode = modeMap2[token.trim().toLowerCase()];
              if (mode) store.snapModes.add(mode);
            }
            engine.prompt(`Osnap: ${Array.from(store.snapModes).join(', ')}`);
          }
          engine.complete();
          return true;
        });
        return true;
      }
      engine.prompt('Invalid. [Grid/Snap/Ortho/Polar/Osnap]:');
      return true;
    };
  });

  // === GRIPS ===
  engine.register('GRIPS', [], () => {
    store.gripsEnabled = !store.gripsEnabled;
    store.emit();
    engine.prompt(`Grips: ${store.gripsEnabled ? 'ON' : 'OFF'}`);
    engine.complete();
  });

  // === DDGRIPS ===
  engine.register('DDGRIPS', [], () => {
    engine.prompt(`DDGRIPS Grips: ${store.gripsEnabled ? 'ON' : 'OFF'}`);
    engine.prompt('Toggle grips [On/Off]:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const opt = input.toLowerCase();
      if (opt === 'on' || opt === '1') {
        store.gripsEnabled = true;
        store.emit();
        engine.prompt('Grips enabled');
        engine.complete();
        return true;
      } else if (opt === 'off' || opt === '0') {
        store.gripsEnabled = false;
        store.emit();
        engine.prompt('Grips disabled');
        engine.complete();
        return true;
      }
      engine.prompt('Enter On or Off:');
      return true;
    };
  });

  // === LAYERP ===
  engine.register('LAYERP', ['LP'], () => {
    const prevState = store.layerStates.get('__layerp_auto');
    if (!prevState) {
      engine.prompt('LAYERP No previous layer state to restore');
      engine.complete();
      return;
    }
    store.layers = JSON.parse(JSON.stringify(prevState.layers));
    store.emit();
    engine.prompt('LAYERP Previous layer state restored');
    engine.complete();
  });

  // === SCRIPT ===
  engine.register('SCRIPT', ['SCR'], () => {
    engine.prompt('SCRIPT Enter commands (semicolon-separated):');
    engine.waitForInput('Commands:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const commands = input.split(';').map(c => c.trim()).filter(Boolean);
      if (commands.length === 0) { engine.prompt('No commands to run'); engine.complete(); return true; }
      engine.complete();
      let idx = 0;
      function runNext() {
        if (idx >= commands.length) {
          engine.prompt(`SCRIPT ${commands.length} commands executed`);
          return;
        }
        const cmd = commands[idx++];
        engine.prompt(`> ${cmd}`);
        engine.handleInput(cmd);
        setTimeout(runNext, 100);
      }
      runNext();
      return true;
    });
  });

  // === SHELL ===
  engine.register('SHELL', [], () => {
    engine.prompt('SHELL Execute JavaScript expression:');
    engine.waitForInput('Expression:', (input) => {
      if (input === '') { engine.complete(); return true; }
      try {
        const result = Function(`"use strict"; return (${input})`)();
        engine.prompt(`Result: ${JSON.stringify(result)}`);
      } catch (err: any) {
        engine.prompt(`Error: ${err.message}`);
      }
      engine.complete();
      return true;
    });
  });

  // === OBJECTSCALE ===
  engine.register('OBJECTSCALE', [], () => {
    const currentScale = (store as any).annotationScale || 1;
    engine.prompt(`OBJECTSCALE Current annotation scale: ${currentScale}`);
    engine.prompt('Enter new scale factor:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const val = parseFloat(input);
      if (isNaN(val) || val <= 0) { engine.prompt('Requires positive number'); return true; }
      (store as any).annotationScale = val;
      engine.prompt(`Annotation scale set to ${val}`);
      engine.complete();
      return true;
    };
  });

  // === LAYOUT ===
  engine.register('LAYOUT', ['LAY'], () => {
    engine.prompt('LAYOUT Enter option [New/Delete/Set/List] <List>:');
    engine.inputHandler = (input) => {
      const opt = input.toLowerCase();
      const layouts: string[] = (store as any).layouts || ((store as any).layouts = ['Model']);
      const current: string = (store as any).currentLayout || 'Model';

      if (opt === 'n' || opt === 'new') {
        engine.inputHandler = null;
        engine.prompt('Enter new layout name:');
        engine.waitForInput('Name:', (name) => {
          if (name === '') { engine.complete(); return true; }
          if (layouts.includes(name)) {
            engine.prompt(`Layout "${name}" already exists`);
            engine.complete();
            return true;
          }
          layouts.push(name);
          engine.prompt(`Layout "${name}" created`);
          engine.complete();
          return true;
        });
        return true;
      } else if (opt === 'd' || opt === 'delete') {
        engine.inputHandler = null;
        engine.prompt('Enter layout name to delete:');
        engine.waitForInput('Name:', (name) => {
          if (name === '') { engine.complete(); return true; }
          if (name === 'Model') {
            engine.prompt('Cannot delete the Model layout');
            engine.complete();
            return true;
          }
          const idx = layouts.indexOf(name);
          if (idx === -1) {
            engine.prompt(`Layout "${name}" not found`);
            engine.complete();
            return true;
          }
          layouts.splice(idx, 1);
          if ((store as any).currentLayout === name) (store as any).currentLayout = 'Model';
          engine.prompt(`Layout "${name}" deleted`);
          engine.complete();
          return true;
        });
        return true;
      } else if (opt === 's' || opt === 'set') {
        engine.inputHandler = null;
        engine.prompt('Enter layout name to set current:');
        engine.waitForInput('Name:', (name) => {
          if (name === '') { engine.complete(); return true; }
          if (!layouts.includes(name)) {
            engine.prompt(`Layout "${name}" not found`);
            engine.complete();
            return true;
          }
          (store as any).currentLayout = name;
          engine.prompt(`Current layout set to "${name}"`);
          engine.complete();
          return true;
        });
        return true;
      } else {
        const lines = layouts.map(l => `  ${l === current ? '*' : ' '} ${l}`);
        engine.prompt('Layouts:\n' + lines.join('\n'));
        engine.complete();
        return true;
      }
    };
  });

  // === RECOVER ===
  engine.register('RECOVER', [], () => {
    const validTypes = new Set(['line', 'circle', 'arc', 'polyline', 'rect', 'text', 'ellipse', 'dimension', 'point', 'hatch', 'blockref', 'region']);
    const layerNames = new Set(store.layers.map(l => l.name));
    const total = store.entities.length;
    let issues = 0;
    const toRemove: string[] = [];

    for (const e of store.entities) {
      if (!validTypes.has(e.type)) {
        toRemove.push(e.id);
        issues++;
        continue;
      }
      if (e.type === 'line') {
        const le = e as any;
        if (isNaN(le.start?.x) || isNaN(le.start?.y) || isNaN(le.end?.x) || isNaN(le.end?.y)) {
          toRemove.push(e.id);
          issues++;
          continue;
        }
      }
      if (e.type === 'circle') {
        const ce = e as any;
        if (isNaN(ce.center?.x) || isNaN(ce.center?.y) || isNaN(ce.radius)) {
          toRemove.push(e.id);
          issues++;
          continue;
        }
      }
      if (!layerNames.has(e.layer)) {
        e.layer = '0';
        issues++;
      }
    }

    if (issues > 0) {
      store.pushUndo('RECOVER');
      if (toRemove.length > 0) {
        const removeSet = new Set(toRemove);
        store.entities = store.entities.filter(e => !removeSet.has(e.id));
      }
      store.emit();
    }
    engine.prompt(`RECOVER ${total} entities checked. ${issues} issues found and fixed.`);
    engine.complete();
  });

  // === CLOSEALL ===
  engine.register('CLOSEALL', [], () => {
    engine.prompt('CLOSEALL Erase all entities? [Yes/No] <No>:');
    engine.waitForInput('Confirm:', (input) => {
      const opt = input.toLowerCase();
      if (opt === 'y' || opt === 'yes') {
        store.pushUndo('CLOSEALL');
        store.entities.length = 0;
        store.clearSelection();
        store.emit();
        engine.prompt('All entities erased.');
      } else {
        engine.prompt('CLOSEALL cancelled.');
      }
      engine.complete();
      return true;
    });
  });

  // === VPOINT ===
  engine.register('VPOINT', ['VP'], () => {
    engine.prompt('VPOINT Enter view direction [Top/Front/Right] or rotation angle <Top>:');
    engine.waitForInput('Direction:', (input) => {
      const opt = input.toLowerCase();
      if (opt === '' || opt === 't' || opt === 'top') {
        (store as any).viewRotation = 0;
        store.emit();
        engine.prompt('Top view set.');
      } else if (opt === 'f' || opt === 'front') {
        (store as any).viewRotation = 0;
        store.emit();
        engine.prompt('Front view set (2D mode).');
      } else if (opt === 'r' || opt === 'right') {
        (store as any).viewRotation = 0;
        store.emit();
        engine.prompt('Right view set (2D mode).');
      } else {
        const ang = parseFloat(opt);
        if (isNaN(ang)) {
          engine.prompt('Invalid input.');
          engine.complete();
          return true;
        }
        (store as any).viewRotation = ang;
        store.emit();
        engine.prompt(`View rotation set to ${ang}deg.`);
      }
      engine.complete();
      return true;
    });
  });

  // === LAYERPLOT (LPLOT) ===
  engine.register('LAYERPLOT', ['LPLOT'], () => {
    engine.prompt(`LAYERPLOT Enter layer name to toggle plot status:`);
    engine.prompt(`Layers: ${store.layers.map(l => `${l.name}${l.plot === false ? ' (no-plot)' : ''}`).join(', ')}`);
    engine.waitForInput('Layer:', (input) => {
      const name = input.trim();
      if (!name) { engine.complete(); return true; }
      const layer = store.layers.find(l => l.name.toLowerCase() === name.toLowerCase());
      if (!layer) {
        engine.prompt(`Layer "${name}" not found`);
        engine.complete();
        return true;
      }
      layer.plot = !(layer.plot !== false);
      store.emit();
      engine.prompt(`Layer "${layer.name}" plot: ${layer.plot ? 'ON' : 'OFF (construction)'}`);
      engine.complete();
      return true;
    });
  });

  // === CONSTRUCTION (CONST) ===
  engine.register('CONSTRUCTION', ['CONST'], () => {
    let conLayer = store.layers.find(l => l.name === 'CONSTRUCTION');
    if (!conLayer) {
      store.layers.push({
        name: 'CONSTRUCTION', color: '#808080', visible: true,
        locked: false, frozen: false, current: false, lineweight: 1, plot: false,
      });
      conLayer = store.layers[store.layers.length - 1];
    }
    for (const l of store.layers) l.current = false;
    conLayer.current = true;
    store.emit();
    engine.prompt('Current layer set to CONSTRUCTION (non-plottable)');
    engine.complete();
  });

  // === PAGESETUP ===
  engine.register('PAGESETUP', [], () => {
    const ps = (store as any).pageSetup || { paperSize: 'A3', orientation: 'landscape', scale: '1:1' };
    engine.prompt(`PAGESETUP Paper: ${ps.paperSize}, ${ps.orientation}, Scale: ${ps.scale}`);
    engine.prompt('Set [Paper/Orientation/Scale]:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const opt = input.toLowerCase();
      if (opt === 'p' || opt === 'paper') {
        engine.inputHandler = null;
        engine.prompt('Paper sizes: A4, A3, A2, A1, A0, Letter, Legal, Tabloid');
        engine.prompt(`Enter paper size (current: ${ps.paperSize}):`);
        engine.waitForInput('Size:', (val) => {
          if (val === '') { engine.complete(); return true; }
          ps.paperSize = val.toUpperCase();
          (store as any).pageSetup = ps;
          engine.prompt(`Paper size set to ${ps.paperSize}`);
          engine.complete();
          return true;
        });
        return true;
      } else if (opt === 'o' || opt === 'orientation') {
        ps.orientation = ps.orientation === 'landscape' ? 'portrait' : 'landscape';
        (store as any).pageSetup = ps;
        engine.prompt(`Orientation: ${ps.orientation}`);
        engine.complete();
        return true;
      } else if (opt === 's' || opt === 'scale') {
        engine.inputHandler = null;
        engine.prompt(`Enter scale (e.g., 1:1, 1:2, 2:1). Current: ${ps.scale}:`);
        engine.waitForInput('Scale:', (val) => {
          if (val === '') { engine.complete(); return true; }
          ps.scale = val;
          (store as any).pageSetup = ps;
          engine.prompt(`Scale set to ${ps.scale}`);
          engine.complete();
          return true;
        });
        return true;
      }
      engine.prompt('Invalid. [Paper/Orientation/Scale]:');
      return true;
    };
  });

  // SHELTER — place a 쉼터 rectangle and enter placement loop
  engine.register('SHELTER', ['SHL'], () => {
    engine.prompt('SHELTER — 쉼터 건물배치도');
    engine.prompt('Click to set shelter position:');
    engine.waitForClick((pt) => {
      engine.complete();
      startShelterMode(pt, engine.promptFn);
    });
  });

}

function doCalInput(engine: CommandEngine) {
  engine.waitForInput('>> Expression:', (input) => {
    if (input === '') { engine.complete(); return true; }
    try {
      const result = evalCalExpression(input);
      if (typeof result === 'object' && 'x' in result && 'y' in result) {
        engine.prompt(`  = (${result.x}, ${result.y})`);
      } else {
        engine.prompt(`  = ${result}`);
      }
    } catch (err: any) {
      engine.prompt(`  Error: ${err.message || 'Invalid expression'}`);
    }
    doCalInput(engine);
    return true;
  });
}

function evalCalExpression(expr: string): number | { x: number; y: number } {
  let s = expr.trim();

  const midMatch = s.match(/^mid\s*\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/i);
  if (midMatch) {
    const x1 = evalNumExpr(midMatch[1]);
    const y1 = evalNumExpr(midMatch[2]);
    const x2 = evalNumExpr(midMatch[3]);
    const y2 = evalNumExpr(midMatch[4]);
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }

  const distMatch = s.match(/^dist\s*\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/i);
  if (distMatch) {
    const x1 = evalNumExpr(distMatch[1]);
    const y1 = evalNumExpr(distMatch[2]);
    const x2 = evalNumExpr(distMatch[3]);
    const y2 = evalNumExpr(distMatch[4]);
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }

  return evalNumExpr(s);
}

function evalNumExpr(expr: string): number {
  let s = expr.trim();
  s = s.replace(/\bpi\b/gi, String(Math.PI));
  s = s.replace(/\be\b/gi, String(Math.E));
  s = s.replace(/\bsqrt\s*\(/gi, 'Math.sqrt(');
  s = s.replace(/\bsin\s*\(/gi, 'Math.sin(');
  s = s.replace(/\bcos\s*\(/gi, 'Math.cos(');
  s = s.replace(/\btan\s*\(/gi, 'Math.tan(');
  s = s.replace(/\babs\s*\(/gi, 'Math.abs(');
  s = s.replace(/\batan2\s*\(/gi, 'Math.atan2(');
  s = s.replace(/\batan\s*\(/gi, 'Math.atan(');
  s = s.replace(/\blog\s*\(/gi, 'Math.log(');
  s = s.replace(/\bexp\s*\(/gi, 'Math.exp(');
  s = s.replace(/\^/g, '**');

  if (/[^0-9+\-*/().%\s,eE]/.test(s.replace(/Math\.\w+/g, ''))) {
    throw new Error('Invalid characters in expression');
  }

  const result = Function(`"use strict"; return (${s})`)();
  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error('Result is not a finite number');
  }
  return result;
}
