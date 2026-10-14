import { Point, DimensionEntity, LineEntity } from '../types';
import { store } from '../store';
import { dist, angle, polarPoint, pointOnEntity, isHorizontalDim, normalizeAngle } from '../geometry';
import { lineLineIntersectionInf } from './helpers';
import { CommandEngine } from './engine';
import { makeEntity } from './helpers';

export function registerDimensionCommands(engine: CommandEngine) {

  engine.register('DIMLINEAR', ['DLI'], () => {
    store.tool = 'dimension';
    engine.prompt('DIMLINEAR Specify first extension line origin:');
    engine.waitForClick((p1) => {
      engine.tempPoints = [p1];
      engine.prompt('Specify second extension line origin:');
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: p1, end: p };
      });
      engine.waitForClick((p2) => {
        engine.renderer.rubberBand = null;
        engine.tempPoints.push(p2);
        engine.prompt('Specify dimension line location:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: p1, end: p2 };
        });
        engine.waitForClick((textPos) => {
          const dx = Math.abs(p2.x - p1.x), dy = Math.abs(p2.y - p1.y);
          const horizontal = isHorizontalDim(p1, p2, textPos);
          const measuredDist = horizontal ? dx : dy;
          const prec = store.currentDimStyle.precision;
          store.pushUndo('DIMLINEAR');
          store.addEntity(makeEntity({
            type: 'dimension', dimType: 'linear', p1, p2, textPos,
            textOverride: measuredDist.toFixed(prec),
          } as any));
          engine.renderer.rubberBand = null;
          engine.prompt(`Dimension = ${measuredDist.toFixed(4)}`);
          engine.complete();
        });
      });
    });
  });

  engine.register('DIMALIGNED', ['DAL'], () => {
    store.tool = 'dimension';
    engine.prompt('DIMALIGNED Specify first extension line origin:');
    engine.waitForClick((p1) => {
      engine.tempPoints = [p1];
      engine.prompt('Specify second extension line origin:');
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: p1, end: p };
      });
      engine.waitForClick((p2) => {
        engine.renderer.rubberBand = null;
        engine.tempPoints.push(p2);
        engine.prompt('Specify dimension line location:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: p1, end: p2 };
        });
        engine.waitForClick((textPos) => {
          const d = dist(p1, p2);
          const prec = store.currentDimStyle.precision;
          store.pushUndo('DIMALIGNED');
          store.addEntity(makeEntity({
            type: 'dimension', dimType: 'aligned', p1, p2, textPos,
            textOverride: d.toFixed(prec),
          } as any));
          engine.renderer.rubberBand = null;
          engine.prompt(`Dimension = ${d.toFixed(4)}`);
          engine.complete();
        });
      });
    });
  });

  engine.register('DIMRADIUS', ['DRA'], () => {
    store.tool = 'dimension';
    engine.prompt('DIMRADIUS Select arc or circle:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const entity = store.entities.find(e =>
        e.visible && (e.type === 'circle' || e.type === 'arc') && pointOnEntity(pt, e, tol)
      );
      if (!entity || (entity.type !== 'circle' && entity.type !== 'arc')) {
        engine.prompt('Select a circle or arc');
        engine.complete();
        return;
      }
      const center = entity.center;
      const radius = entity.radius;
      engine.prompt('Specify dimension line location:');
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: center, end: p };
      });
      engine.waitForClick((textPos) => {
        const a = angle(center, textPos);
        const rimPt = polarPoint(center, radius, a);
        const prec = store.currentDimStyle.precision;
        store.pushUndo('DIMRADIUS');
        store.addEntity(makeEntity({
          type: 'dimension', dimType: 'radius', p1: center, p2: rimPt, textPos,
          textOverride: `R${radius.toFixed(prec)}`,
        } as any));
        engine.renderer.rubberBand = null;
        engine.prompt(`Radius = ${radius.toFixed(4)}`);
        engine.complete();
      });
    });
  });

  engine.register('DIMDIAMETER', ['DDI'], () => {
    store.tool = 'dimension';
    engine.prompt('DIMDIAMETER Select arc or circle:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const entity = store.entities.find(e =>
        e.visible && (e.type === 'circle' || e.type === 'arc') && pointOnEntity(pt, e, tol)
      );
      if (!entity || (entity.type !== 'circle' && entity.type !== 'arc')) {
        engine.prompt('Select a circle or arc');
        engine.complete();
        return;
      }
      const center = entity.center;
      const radius = entity.radius;
      engine.prompt('Specify dimension line location:');
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: center, end: p };
      });
      engine.waitForClick((textPos) => {
        const a = angle(center, textPos);
        const rimPt1 = polarPoint(center, radius, a);
        const rimPt2 = polarPoint(center, radius, a + Math.PI);
        const prec = store.currentDimStyle.precision;
        store.pushUndo('DIMDIAMETER');
        store.addEntity(makeEntity({
          type: 'dimension', dimType: 'diameter', p1: rimPt2, p2: rimPt1, textPos,
          textOverride: `⌀${(radius * 2).toFixed(prec)}`,
        } as any));
        engine.renderer.rubberBand = null;
        engine.prompt(`Diameter = ${(radius * 2).toFixed(4)}`);
        engine.complete();
      });
    });
  });

  engine.register('DIMCONTINUE', ['DCO'], () => {
    store.tool = 'dimension';
    let lastDim: DimensionEntity | null = null;
    for (let i = store.entities.length - 1; i >= 0; i--) {
      if (store.entities[i].type === 'dimension') {
        lastDim = store.entities[i] as DimensionEntity;
        break;
      }
    }
    if (!lastDim) {
      engine.prompt('No dimension to continue from');
      engine.complete();
      return;
    }
    const p1 = { ...lastDim.p2 };
    const dimType = lastDim.dimType;
    engine.prompt(`DIMCONTINUE from (${p1.x.toFixed(2)}, ${p1.y.toFixed(2)})`);
    engine.prompt('Specify second extension line origin:');
    engine.onMove((p) => {
      engine.renderer.rubberBand = { start: p1, end: p };
    });
    engine.waitForClick((p2) => {
      const textPos = { ...lastDim!.textPos };
      const d = dist(p1, p2);
      const prec = store.currentDimStyle.precision;
      store.pushUndo('DIMCONTINUE');
      store.addEntity(makeEntity({
        type: 'dimension', dimType, p1, p2, textPos,
        textOverride: d.toFixed(prec),
      } as any));
      engine.renderer.rubberBand = null;
      engine.prompt(`Dimension = ${d.toFixed(4)}`);
      engine.complete();
    });
  });

  engine.register('DIMSTYLE', ['D'], () => {
    engine.prompt('Current dimstyle: ' + store.currentDimStyle.name);
    engine.prompt('Enter dimstyle option [Save/Restore/STatus/Variables]:');
    engine.waitForInput('Dimstyle option:', (input) => {
      const opt = input.toUpperCase();
      if (opt === 'STATUS' || opt === 'ST') {
        const ds = store.currentDimStyle;
        engine.prompt(`--- DimStyle "${ds.name}" ---`);
        engine.prompt(`  DIMTXT (text height): ${ds.textHeight}`);
        engine.prompt(`  DIMASZ (arrow size): ${ds.arrowSize}`);
        engine.prompt(`  DIMDEC (precision): ${ds.precision}`);
        engine.prompt(`  DIMCLRD (color): ${ds.color}`);
        engine.prompt(`  DIMEXO (extension offset): ${ds.extensionOffset}`);
        engine.complete();
        return true;
      }
      if (opt === 'VARIABLES' || opt === 'V') {
        engine.prompt('Enter variable [DIMTXT/DIMASZ/DIMDEC/DIMCLRD/DIMEXO]:');
        engine.waitForInput('Variable name:', (varName) => {
          const v = varName.toUpperCase();
          const varMap: Record<string, keyof typeof store.currentDimStyle> = {
            DIMTXT: 'textHeight', DIMASZ: 'arrowSize', DIMDEC: 'precision',
            DIMCLRD: 'color', DIMEXO: 'extensionOffset',
          };
          const prop = varMap[v];
          if (!prop) {
            engine.prompt('Unknown variable: ' + varName);
            engine.complete();
            return true;
          }
          engine.prompt(`Current value: ${store.currentDimStyle[prop]}. Enter new value:`);
          engine.waitForInput('New value:', (val) => {
            if (prop === 'color') {
              (store.currentDimStyle as any)[prop] = val;
            } else {
              const n = parseFloat(val);
              if (isNaN(n)) { engine.prompt('Invalid number'); engine.complete(); return true; }
              (store.currentDimStyle as any)[prop] = prop === 'precision' ? Math.round(n) : n;
            }
            engine.prompt(`${v} set to ${store.currentDimStyle[prop]}`);
            engine.complete();
            return true;
          });
          return true;
        });
        return true;
      }
      if (opt === 'SAVE' || opt === 'SA') {
        engine.prompt('Enter name for new dimstyle:');
        engine.waitForInput('Style name:', (name) => {
          if (!name.trim()) { engine.prompt('Cancelled'); engine.complete(); return true; }
          const copy = { ...store.currentDimStyle, name: name.trim() };
          const existing = store.dimStyles.findIndex(s => s.name === copy.name);
          if (existing >= 0) store.dimStyles[existing] = copy;
          else store.dimStyles.push(copy);
          engine.prompt(`Dimstyle "${copy.name}" saved`);
          engine.complete();
          return true;
        });
        return true;
      }
      if (opt === 'RESTORE' || opt === 'R') {
        engine.prompt('Available styles: ' + store.dimStyles.map(s => s.name).join(', '));
        engine.prompt('Enter style name to restore:');
        engine.waitForInput('Style name:', (name) => {
          const found = store.dimStyles.find(s => s.name.toUpperCase() === name.toUpperCase());
          if (!found) { engine.prompt('Style not found: ' + name); engine.complete(); return true; }
          store.currentDimStyle = { ...found };
          engine.prompt(`Dimstyle "${found.name}" restored`);
          engine.complete();
          return true;
        });
        return true;
      }
      if (opt === '') { engine.complete(); return true; }
      engine.prompt('Invalid option');
      engine.complete();
      return true;
    });
  });

  // === DIMBASELINE ===
  engine.register('DIMBASELINE', ['DBL'], () => {
    store.tool = 'dimension';
    let lastDim: DimensionEntity | null = null;
    for (let i = store.entities.length - 1; i >= 0; i--) {
      if (store.entities[i].type === 'dimension') {
        lastDim = store.entities[i] as DimensionEntity;
        break;
      }
    }
    if (!lastDim) {
      engine.prompt('No dimension to baseline from');
      engine.complete();
      return;
    }
    const baseline = { ...lastDim.p1 };
    const dimType = lastDim.dimType;
    engine.prompt(`DIMBASELINE from (${baseline.x.toFixed(2)}, ${baseline.y.toFixed(2)})`);
    engine.prompt('Specify second extension line origin:');
    engine.onMove((p) => {
      engine.renderer.rubberBand = { start: baseline, end: p };
    });
    engine.waitForClick((p2) => {
      const textPos = { ...lastDim!.textPos };
      textPos.y += store.currentDimStyle.textHeight * 3;
      const d = dist(baseline, p2);
      const prec = store.currentDimStyle.precision;
      store.pushUndo('DIMBASELINE');
      store.addEntity(makeEntity({
        type: 'dimension', dimType, p1: baseline, p2, textPos,
        textOverride: d.toFixed(prec),
      } as any));
      engine.renderer.rubberBand = null;
      engine.prompt(`Dimension = ${d.toFixed(4)}`);
      engine.complete();
    });
  });

  // === DIMORDINATE ===
  engine.register('DIMORDINATE', ['DOR'], () => {
    store.tool = 'dimension';
    engine.prompt('DIMORDINATE Specify feature location:');
    engine.waitForClick((featurePt) => {
      engine.prompt('Specify leader endpoint [Xdatum/Ydatum]:');

      function finishOrdinate(axis: 'x' | 'y') {
        engine.inputHandler = null;
        engine.prompt(`Specify leader endpoint for ${axis.toUpperCase()} ordinate:`);
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: featurePt, end: p };
        });
        engine.waitForClick((leaderEnd) => {
          const value = axis === 'x' ? featurePt.x : featurePt.y;
          const prec = store.currentDimStyle.precision;
          store.pushUndo('DIMORDINATE');
          store.addEntity(makeEntity({
            type: 'dimension', dimType: 'linear', p1: featurePt, p2: leaderEnd,
            textPos: leaderEnd,
            textOverride: value.toFixed(prec),
          } as any));
          engine.renderer.rubberBand = null;
          engine.prompt(`Ordinate ${axis.toUpperCase()} = ${value.toFixed(4)}`);
          engine.complete();
        });
      }

      engine.inputHandler = (input) => {
        const lower = input.toLowerCase();
        if (lower === 'x' || lower === 'xdatum') { finishOrdinate('x'); return true; }
        if (lower === 'y' || lower === 'ydatum') { finishOrdinate('y'); return true; }
        return false;
      };
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: featurePt, end: p };
      });
      engine.waitForClick((leaderEnd) => {
        engine.inputHandler = null;
        const dx = Math.abs(leaderEnd.x - featurePt.x);
        const dy = Math.abs(leaderEnd.y - featurePt.y);
        const axis = dx > dy ? 'y' : 'x';
        const value = axis === 'x' ? featurePt.x : featurePt.y;
        const prec = store.currentDimStyle.precision;
        store.pushUndo('DIMORDINATE');
        store.addEntity(makeEntity({
          type: 'dimension', dimType: 'linear', p1: featurePt, p2: leaderEnd,
          textPos: leaderEnd,
          textOverride: value.toFixed(prec),
        } as any));
        engine.renderer.rubberBand = null;
        engine.prompt(`Ordinate = ${value.toFixed(4)}`);
        engine.complete();
      });
    });
  });

  // === DIMCENTER ===
  engine.register('DIMCENTER', ['DCE'], () => {
    store.tool = 'dimension';
    engine.prompt('DIMCENTER Select arc or circle:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const entity = store.entities.find(e =>
        e.visible && (e.type === 'circle' || e.type === 'arc') && pointOnEntity(pt, e, tol)
      );
      if (!entity || (entity.type !== 'circle' && entity.type !== 'arc')) {
        engine.prompt('Select a circle or arc');
        engine.complete();
        return;
      }
      const center = entity.center;
      const markSize = store.currentDimStyle.arrowSize * 1.5;
      store.pushUndo('DIMCENTER');
      store.addEntity(makeEntity({
        type: 'line',
        start: { x: center.x - markSize, y: center.y },
        end: { x: center.x + markSize, y: center.y },
        color: store.currentDimStyle.color,
      } as any));
      store.addEntity(makeEntity({
        type: 'line',
        start: { x: center.x, y: center.y - markSize },
        end: { x: center.x, y: center.y + markSize },
        color: store.currentDimStyle.color,
      } as any));
      store.emit();
      engine.prompt(`Center mark placed at (${center.x.toFixed(2)}, ${center.y.toFixed(2)})`);
      engine.complete();
    });
  });

  // === DIMANGULAR ===
  engine.register('DIMANGULAR', ['DAN'], () => {
    store.tool = 'dimension';
    engine.prompt('DIMANGULAR Select first line:');
    engine.waitForClick((pt1) => {
      const tol = 10 / store.view.zoom;
      const e1 = store.entities.find(e => e.visible && e.type === 'line' && pointOnEntity(pt1, e, tol));
      if (!e1 || e1.type !== 'line') {
        engine.prompt('Select a line');
        engine.complete();
        return;
      }
      engine.prompt('Select second line:');
      engine.waitForClick((pt2) => {
        const e2 = store.entities.find(e => e.visible && e.type === 'line' && e.id !== e1.id && pointOnEntity(pt2, e, tol));
        if (!e2 || e2.type !== 'line') {
          engine.prompt('Select a line');
          engine.complete();
          return;
        }
        const line1 = e1 as LineEntity;
        const line2 = e2 as LineEntity;
        const ix = lineLineIntersectionInf(line1.start, line1.end, line2.start, line2.end);
        if (!ix) {
          engine.prompt('Lines are parallel — cannot create angular dimension');
          engine.complete();
          return;
        }

        engine.prompt('Specify dimension arc line location:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: ix, end: p };
        });
        engine.waitForClick((textPos) => {
          engine.renderer.rubberBand = null;

          const textAng = angle(ix, textPos);
          const d1a = dist(ix, line1.start), d1b = dist(ix, line1.end);
          const d2a = dist(ix, line2.start), d2b = dist(ix, line2.end);
          const dir1a = d1a > 1e-6 ? angle(ix, line1.start) : NaN;
          const dir1b = d1b > 1e-6 ? angle(ix, line1.end) : NaN;
          const dir2a = d2a > 1e-6 ? angle(ix, line2.start) : NaN;
          const dir2b = d2b > 1e-6 ? angle(ix, line2.end) : NaN;

          const pick1 = isNaN(dir1a) ? dir1b : isNaN(dir1b) ? dir1a :
            Math.abs(normalizeAngle(textAng - dir1a)) < Math.abs(normalizeAngle(textAng - dir1b)) ? dir1a : dir1b;
          const pick2 = isNaN(dir2a) ? dir2b : isNaN(dir2b) ? dir2a :
            Math.abs(normalizeAngle(textAng - dir2a)) < Math.abs(normalizeAngle(textAng - dir2b)) ? dir2a : dir2b;

          let startA = normalizeAngle(pick1);
          let endA = normalizeAngle(pick2);
          if (startA > endA) { const tmp = startA; startA = endA; endA = tmp; }

          let sweep = endA - startA;
          const midA = startA + sweep / 2;
          const textAngNorm = normalizeAngle(textAng);
          if (!(textAngNorm >= startA && textAngNorm <= endA)) {
            sweep = 2 * Math.PI - sweep;
            const tmp = startA; startA = endA; endA = tmp + 2 * Math.PI;
          }

          const angleDeg = (sweep * 180 / Math.PI);
          const prec = store.currentDimStyle.precision;
          const radius = dist(ix, textPos);
          const p1 = polarPoint(ix, radius, startA);
          const p2 = polarPoint(ix, radius, endA);

          store.pushUndo('DIMANGULAR');
          store.addEntity(makeEntity({
            type: 'dimension', dimType: 'angular', p1, p2,
            textPos: { ...ix, },
            textOverride: angleDeg.toFixed(prec) + '°',
          } as any));
          engine.prompt(`Angle = ${angleDeg.toFixed(4)}°`);
          engine.complete();
        });
      });
    });
  });

  // === DIMEDIT ===
  engine.register('DIMEDIT', ['DED'], () => {
    engine.prompt('DIMEDIT Enter option [Home/New/Rotate/Oblique]:');
    engine.waitForInput('Option:', (input) => {
      if (input === '') { engine.complete(); return true; }
      const opt = input.toLowerCase();
      if (opt === 'h' || opt === 'home') {
        engine.prompt('Select dimensions:');
        engine.requireSelection((sel) => {
          const dims = sel.filter(e => e.type === 'dimension') as DimensionEntity[];
          if (dims.length === 0) { engine.prompt('No dimensions selected'); engine.complete(); return; }
          store.pushUndo('DIMEDIT');
          for (const d of dims) {
            d.textPos = { x: (d.p1.x + d.p2.x) / 2, y: (d.p1.y + d.p2.y) / 2 };
          }
          store.emit();
          engine.prompt(`${dims.length} dimension text(s) returned to home position`);
          engine.complete();
        });
        return true;
      }
      if (opt === 'n' || opt === 'new') {
        engine.prompt('Enter new dimension text (<> for measured):');
        engine.waitForInput('New text:', (text) => {
          if (text === '') { engine.complete(); return true; }
          engine.prompt('Select dimensions:');
          engine.requireSelection((sel) => {
            const dims = sel.filter(e => e.type === 'dimension') as DimensionEntity[];
            if (dims.length === 0) { engine.prompt('No dimensions selected'); engine.complete(); return; }
            store.pushUndo('DIMEDIT');
            for (const d of dims) {
              d.textOverride = text === '<>' ? undefined : text;
            }
            store.emit();
            engine.prompt(`${dims.length} dimension text(s) updated`);
            engine.complete();
          });
          return true;
        });
        return true;
      }
      if (opt === 'r' || opt === 'rotate') {
        engine.prompt('Enter text angle:');
        engine.waitForInput('Angle:', (aInput) => {
          const ang = parseFloat(aInput);
          if (isNaN(ang)) { engine.prompt('Invalid angle'); engine.complete(); return true; }
          engine.prompt('Select dimensions:');
          engine.requireSelection((sel) => {
            const dims = sel.filter(e => e.type === 'dimension') as DimensionEntity[];
            if (dims.length === 0) { engine.prompt('No dimensions selected'); engine.complete(); return; }
            store.pushUndo('DIMEDIT');
            for (const d of dims) {
              (d as any).textRotation = ang;
            }
            store.emit();
            engine.prompt(`${dims.length} dimension text(s) rotated to ${ang}°`);
            engine.complete();
          });
          return true;
        });
        return true;
      }
      if (opt === 'o' || opt === 'oblique') {
        engine.prompt('Enter obliquing angle:');
        engine.waitForInput('Oblique angle:', (aInput) => {
          const ang = parseFloat(aInput);
          if (isNaN(ang)) { engine.prompt('Invalid angle'); engine.complete(); return true; }
          engine.prompt('Select dimensions:');
          engine.requireSelection((sel) => {
            const dims = sel.filter(e => e.type === 'dimension') as DimensionEntity[];
            if (dims.length === 0) { engine.prompt('No dimensions selected'); engine.complete(); return; }
            store.pushUndo('DIMEDIT');
            for (const d of dims) {
              (d as any).obliqueAngle = ang;
            }
            store.emit();
            engine.prompt(`${dims.length} extension line(s) obliqued to ${ang}°`);
            engine.complete();
          });
          return true;
        });
        return true;
      }
      engine.prompt('Invalid option. Use Home/New/Rotate/Oblique.');
      engine.complete();
      return true;
    });
  });

  // === DIMTEDIT ===
  engine.register('DIMTEDIT', ['DIMTED'], () => {
    engine.prompt('DIMTEDIT Select dimension:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const dim = store.entities.find(e =>
        e.visible && e.type === 'dimension' && pointOnEntity(pt, e, tol)
      ) as DimensionEntity | undefined;
      if (!dim) {
        engine.prompt('No dimension found');
        engine.complete();
        return;
      }
      engine.prompt('Specify new text position or [Left/Right/Center/Home/Angle]:');
      engine.inputHandler = (input) => {
        const lower = input.toLowerCase();
        if (lower === 'h' || lower === 'home') {
          store.pushUndo('DIMTEDIT');
          dim.textPos = { x: (dim.p1.x + dim.p2.x) / 2, y: (dim.p1.y + dim.p2.y) / 2 };
          store.emit();
          engine.prompt('Dimension text moved to home position');
          engine.complete();
          return true;
        }
        if (lower === 'l' || lower === 'left') {
          store.pushUndo('DIMTEDIT');
          dim.textPos = { ...dim.p1 };
          store.emit();
          engine.prompt('Dimension text moved to left');
          engine.complete();
          return true;
        }
        if (lower === 'r' || lower === 'right') {
          store.pushUndo('DIMTEDIT');
          dim.textPos = { ...dim.p2 };
          store.emit();
          engine.prompt('Dimension text moved to right');
          engine.complete();
          return true;
        }
        if (lower === 'c' || lower === 'center') {
          store.pushUndo('DIMTEDIT');
          dim.textPos = { x: (dim.p1.x + dim.p2.x) / 2, y: (dim.p1.y + dim.p2.y) / 2 };
          store.emit();
          engine.prompt('Dimension text centered');
          engine.complete();
          return true;
        }
        if (lower === 'a' || lower === 'angle') {
          engine.prompt('Enter text angle:');
          engine.waitForInput('Angle:', (aInput) => {
            const ang = parseFloat(aInput);
            if (!isNaN(ang)) {
              store.pushUndo('DIMTEDIT');
              (dim as any).textRotation = ang;
              store.emit();
              engine.prompt(`Dimension text rotated to ${ang}°`);
            }
            engine.complete();
            return true;
          });
          return true;
        }
        if (input === '') { engine.complete(); return true; }
        return false;
      };
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: { x: (dim.p1.x + dim.p2.x) / 2, y: (dim.p1.y + dim.p2.y) / 2 }, end: p };
      });
      engine.waitForClick((newPos) => {
        store.pushUndo('DIMTEDIT');
        dim.textPos = { ...newPos };
        store.emit();
        engine.renderer.rubberBand = null;
        engine.prompt('Dimension text repositioned');
        engine.complete();
      });
    });
  });

  // === DIMOVERRIDE ===
  engine.register('DIMOVERRIDE', ['DOV', 'DIMOVER'], () => {
    engine.prompt('DIMOVERRIDE Override dimension style variables for selected dimensions');
    engine.prompt('Variables: DIMTXT (text height), DIMASZ (arrow size), DIMEXO (ext offset), DIMDEC (precision), DIMCLR (color)');
    engine.prompt('Enter variable name to override (or Enter to apply/exit):');

    const overrides: Partial<{ textHeight: number; arrowSize: number; extensionOffset: number; precision: number; color: string }> = {};

    function overrideMenu() {
      engine.waitForInput('Variable:', (input) => {
        if (input === '') {
          if (Object.keys(overrides).length === 0) {
            engine.prompt('No overrides specified');
            engine.complete();
            return true;
          }
          engine.prompt('Select dimensions to apply overrides (or Enter for all):');
          engine.requireSelection((sel) => {
            const dims = sel.filter(e => e.type === 'dimension') as DimensionEntity[];
            if (dims.length === 0) {
              engine.prompt('No dimensions in selection');
              engine.complete();
              return;
            }
            store.pushUndo('DIMOVERRIDE');
            for (const d of dims) {
              d.dimOverrides = { ...(d.dimOverrides || {}), ...overrides };
            }
            store.clearSelection();
            store.emit();
            engine.prompt(`Applied overrides to ${dims.length} dimension(s): ${Object.keys(overrides).join(', ')}`);
            engine.complete();
          });
          return true;
        }

        const upper = input.toUpperCase();
        if (upper === 'DIMTXT') {
          engine.prompt(`Enter new text height <${store.currentDimStyle.textHeight}>:`);
          engine.waitForInput('Text height:', (val) => {
            const n = parseFloat(val);
            if (!isNaN(n) && n > 0) { overrides.textHeight = n; engine.prompt(`DIMTXT override = ${n}`); }
            else { engine.prompt('Invalid value'); }
            overrideMenu();
            return true;
          });
        } else if (upper === 'DIMASZ') {
          engine.prompt(`Enter new arrow size <${store.currentDimStyle.arrowSize}>:`);
          engine.waitForInput('Arrow size:', (val) => {
            const n = parseFloat(val);
            if (!isNaN(n) && n > 0) { overrides.arrowSize = n; engine.prompt(`DIMASZ override = ${n}`); }
            else { engine.prompt('Invalid value'); }
            overrideMenu();
            return true;
          });
        } else if (upper === 'DIMEXO') {
          engine.prompt(`Enter new extension offset <${store.currentDimStyle.extensionOffset}>:`);
          engine.waitForInput('Ext offset:', (val) => {
            const n = parseFloat(val);
            if (!isNaN(n) && n >= 0) { overrides.extensionOffset = n; engine.prompt(`DIMEXO override = ${n}`); }
            else { engine.prompt('Invalid value'); }
            overrideMenu();
            return true;
          });
        } else if (upper === 'DIMDEC') {
          engine.prompt(`Enter new precision <${store.currentDimStyle.precision}>:`);
          engine.waitForInput('Precision:', (val) => {
            const n = parseInt(val);
            if (!isNaN(n) && n >= 0 && n <= 8) { overrides.precision = n; engine.prompt(`DIMDEC override = ${n}`); }
            else { engine.prompt('Invalid value (0-8)'); }
            overrideMenu();
            return true;
          });
        } else if (upper === 'DIMCLR') {
          engine.prompt(`Enter new color <${store.currentDimStyle.color}>:`);
          engine.waitForInput('Color:', (val) => {
            if (val.trim()) { overrides.color = val.trim(); engine.prompt(`DIMCLR override = ${val.trim()}`); }
            else { engine.prompt('Invalid color'); }
            overrideMenu();
            return true;
          });
        } else if (upper === 'CLEAR') {
          engine.prompt('Select dimensions to clear overrides:');
          engine.requireSelection((sel) => {
            const dims = sel.filter(e => e.type === 'dimension') as DimensionEntity[];
            if (dims.length === 0) { engine.prompt('No dimensions selected'); engine.complete(); return; }
            store.pushUndo('DIMOVERRIDE');
            for (const d of dims) { delete d.dimOverrides; }
            store.clearSelection();
            store.emit();
            engine.prompt(`Cleared overrides from ${dims.length} dimension(s)`);
            engine.complete();
          });
        } else {
          engine.prompt('Unknown variable. Use DIMTXT, DIMASZ, DIMEXO, DIMDEC, DIMCLR, or CLEAR.');
          overrideMenu();
        }
        return true;
      });
    }
    overrideMenu();
  });

  // === QDIM ===
  engine.register('QDIM', [], () => {
    engine.requireSelection((sel) => {
      const dimensionable = sel.filter(e => e.type === 'line' || e.type === 'circle' || e.type === 'arc');
      if (dimensionable.length === 0) {
        engine.prompt('No dimensionable entities selected (line, circle, arc)');
        engine.complete();
        return;
      }
      const prec = store.currentDimStyle.precision;
      store.pushUndo('QDIM');
      let count = 0;
      for (const e of dimensionable) {
        if (e.type === 'line') {
          const midX = (e.start.x + e.end.x) / 2;
          const midY = (e.start.y + e.end.y) / 2;
          const d = dist(e.start, e.end);
          store.addEntity(makeEntity({
            type: 'dimension', dimType: 'linear',
            p1: { ...e.start }, p2: { ...e.end },
            textPos: { x: midX, y: midY + 10 },
            textOverride: d.toFixed(prec),
          } as any));
          count++;
        } else if (e.type === 'circle') {
          const d = e.radius * 2;
          store.addEntity(makeEntity({
            type: 'dimension', dimType: 'diameter',
            p1: { ...e.center },
            p2: { x: e.center.x + e.radius, y: e.center.y },
            textPos: { x: e.center.x, y: e.center.y + e.radius + 10 },
            textOverride: `⌀${d.toFixed(prec)}`,
          } as any));
          count++;
        } else if (e.type === 'arc') {
          store.addEntity(makeEntity({
            type: 'dimension', dimType: 'radius',
            p1: { ...e.center },
            p2: { x: e.center.x + e.radius, y: e.center.y },
            textPos: { x: e.center.x, y: e.center.y + e.radius + 10 },
            textOverride: `R${e.radius.toFixed(prec)}`,
          } as any));
          count++;
        }
      }
      store.clearSelection();
      engine.prompt(`QDIM: ${count} dimension(s) created`);
      engine.complete();
    });
  });

  // === DIMSPACE ===
  engine.register('DIMSPACE', [], () => {
    engine.requireSelection((sel) => {
      const dims = sel.filter(e => e.type === 'dimension') as DimensionEntity[];
      if (dims.length < 2) { engine.prompt('Select at least 2 dimensions'); engine.complete(); return; }
      engine.prompt(`DIMSPACE ${dims.length} dimensions selected. Enter spacing distance <Auto>:`);
      engine.waitForInput('Distance:', (distInput) => {
        dims.sort((a, b) => a.textPos.y - b.textPos.y);
        const baseY = dims[0].textPos.y;
        const topY = dims[dims.length - 1].textPos.y;
        const spacing = distInput === '' ? (topY - baseY) / (dims.length - 1) : parseFloat(distInput);
        if (isNaN(spacing)) { engine.prompt('Invalid distance'); engine.complete(); return true; }
        store.pushUndo('DIMSPACE');
        for (let i = 0; i < dims.length; i++) {
          dims[i].textPos = { x: dims[i].textPos.x, y: baseY + i * spacing };
        }
        store.clearSelection();
        store.emit();
        engine.prompt(`DIMSPACE: ${dims.length} dimension(s) spaced`);
        engine.complete();
        return true;
      });
    });
  });

  // === DIMBREAK ===
  engine.register('DIMBREAK', [], () => {
    engine.requireSelection((sel) => {
      const dims = sel.filter(e => e.type === 'dimension') as DimensionEntity[];
      if (dims.length === 0) { engine.prompt('No dimensions selected'); engine.complete(); return; }
      store.pushUndo('DIMBREAK');
      for (const d of dims) {
        (d as any).dimBreak = !(d as any).dimBreak;
      }
      store.clearSelection();
      store.emit();
      engine.prompt(`DIMBREAK: ${dims.length} dimension(s) toggled`);
      engine.complete();
    });
  });

  // === MLEADER ===
  engine.register('MLEADER', ['MLD'], () => {
    engine.prompt('MLEADER Specify leader arrowhead location:');
    engine.waitForClick((p1) => {
      engine.tempPoints = [p1];
      engine.prompt('Specify landing point:');
      engine.onMove((p) => {
        engine.renderer.rubberBand = { start: p1, end: p };
      });
      engine.waitForClick((p2) => {
        engine.renderer.rubberBand = null;
        engine.onMove(() => {});
        engine.inputHandler = null;
        engine.prompt('Enter leader text:');
        engine.waitForInput('Text:', (text) => {
          if (text === '') { engine.complete(); return true; }
          store.pushUndo('MLEADER');
          store.addEntity(makeEntity({
            type: 'line',
            start: { ...p1 },
            end: { ...p2 },
          } as any));
          store.addEntity(makeEntity({
            type: 'text',
            position: { x: p2.x + 2, y: p2.y },
            text: text,
            height: store.currentDimStyle.textHeight || 2.5,
            rotation: 0,
          } as any));
          store.emit();
          engine.prompt(`MLEADER created: "${text}"`);
          engine.complete();
          return true;
        });
      });
    });
  });

  // === DIMREASSOCIATE ===
  engine.register('DIMREASSOCIATE', [], () => {
    engine.requireSelection((sel) => {
      const dims = sel.filter(e => e.type === 'dimension') as DimensionEntity[];
      if (dims.length === 0) {
        engine.prompt('No dimensions selected');
        engine.complete();
        return;
      }
      const dim = dims[0];
      engine.prompt(`DIMREASSOCIATE Reassociating ${dim.dimType} dimension. Pick new first point:`);
      engine.waitForClick((p1) => {
        engine.prompt('Pick new second point:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: p1, end: p };
        });
        engine.waitForClick((p2) => {
          engine.renderer.rubberBand = null;
          engine.onMove(() => {});
          store.pushUndo('DIMREASSOCIATE');
          dim.p1 = { ...p1 };
          dim.p2 = { ...p2 };
          dim.textPos = {
            x: (p1.x + p2.x) / 2,
            y: (p1.y + p2.y) / 2 - (store.currentDimStyle.textHeight || 2.5) * 2,
          };
          dim.selected = false;
          store.clearSelection();
          store.emit();
          engine.prompt('DIMREASSOCIATE Dimension reassociated');
          engine.complete();
        });
      });
    });
  });

  // === MLEADERSTYLE ===
  engine.register('MLEADERSTYLE', ['MLS'], () => {
    if (!(store as any).mleaderStyle) {
      (store as any).mleaderStyle = { textHeight: 2.5, arrowSize: 2, landingGap: 2 };
    }
    const style = (store as any).mleaderStyle;

    const promptOptions = () => {
      engine.prompt('MLEADERSTYLE Current style: Standard. Enter option [TextHeight/ArrowSize/LandingGap/List]:');
      engine.inputHandler = (input) => {
        const opt = input.trim().toLowerCase();
        if (opt === '' || opt === 'exit') {
          engine.inputHandler = null;
          engine.complete();
          return true;
        }
        if (opt === 'textheight' || opt === 'th') {
          engine.inputHandler = null;
          engine.prompt(`Enter text height (current: ${style.textHeight}):`);
          engine.waitForInput('Height:', (val) => {
            if (val === '') { promptOptions(); return true; }
            const num = parseFloat(val);
            if (isNaN(num) || num <= 0) { engine.prompt('Requires a positive number'); promptOptions(); return true; }
            style.textHeight = num;
            engine.prompt(`Text height set to ${num}`);
            promptOptions();
            return true;
          });
          return true;
        }
        if (opt === 'arrowsize' || opt === 'as') {
          engine.inputHandler = null;
          engine.prompt(`Enter arrow size (current: ${style.arrowSize}):`);
          engine.waitForInput('Size:', (val) => {
            if (val === '') { promptOptions(); return true; }
            const num = parseFloat(val);
            if (isNaN(num) || num <= 0) { engine.prompt('Requires a positive number'); promptOptions(); return true; }
            style.arrowSize = num;
            engine.prompt(`Arrow size set to ${num}`);
            promptOptions();
            return true;
          });
          return true;
        }
        if (opt === 'landinggap' || opt === 'lg') {
          engine.inputHandler = null;
          engine.prompt(`Enter landing gap (current: ${style.landingGap}):`);
          engine.waitForInput('Gap:', (val) => {
            if (val === '') { promptOptions(); return true; }
            const num = parseFloat(val);
            if (isNaN(num) || num < 0) { engine.prompt('Requires a non-negative number'); promptOptions(); return true; }
            style.landingGap = num;
            engine.prompt(`Landing gap set to ${num}`);
            promptOptions();
            return true;
          });
          return true;
        }
        if (opt === 'list' || opt === 'l') {
          engine.prompt(`MLEADERSTYLE settings:\n  Text Height: ${style.textHeight}\n  Arrow Size: ${style.arrowSize}\n  Landing Gap: ${style.landingGap}`);
          promptOptions();
          return true;
        }
        engine.prompt('Invalid option. [TextHeight/ArrowSize/LandingGap/List]:');
        return true;
      };
    };

    promptOptions();
  });

  // === MLEADEREDIT ===
  engine.register('MLEADEREDIT', ['MLE'], () => {
    engine.requireSelection((sel) => {
      const texts = sel.filter(e => e.type === 'text') as any[];
      if (texts.length === 0) {
        engine.prompt('No text entities selected');
        engine.complete();
        return;
      }
      const textEnt = texts[0];
      engine.prompt(`MLEADEREDIT Current text: "${textEnt.text}". Enter new text (or Enter to keep):`);
      engine.waitForInput('Text:', (newText) => {
        if (newText === '') {
          engine.prompt('MLEADEREDIT Text unchanged');
          engine.complete();
          return true;
        }
        store.pushUndo('MLEADEREDIT');
        textEnt.text = newText;
        textEnt.selected = false;
        store.clearSelection();
        store.emit();
        engine.prompt(`MLEADEREDIT Text updated to "${newText}"`);
        engine.complete();
        return true;
      });
    });
  });

  // === DIMINSPECT ===
  engine.register('DIMINSPECT', ['DINSP'], () => {
    engine.requireSelection((sel) => {
      const dims = sel.filter(e => e.type === 'dimension') as DimensionEntity[];
      if (dims.length === 0) {
        engine.prompt('No dimensions selected');
        engine.complete();
        return;
      }
      engine.prompt(`DIMINSPECT ${dims.length} dimension(s) selected. Enter inspection rate (e.g. 50%):`);
      engine.waitForInput('Rate:', (rate) => {
        if (rate === '') { engine.complete(); return true; }
        store.pushUndo('DIMINSPECT');
        for (const dim of dims) {
          const currentText = dim.textOverride || '';
          dim.textOverride = `◇${currentText} [${rate}]`;
          dim.selected = false;
        }
        store.clearSelection();
        store.emit();
        engine.prompt(`DIMINSPECT ${dims.length} dimension(s) marked for inspection at ${rate}`);
        engine.complete();
        return true;
      });
    });
  });
}
