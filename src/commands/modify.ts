import { Point, Entity, LineEntity, CircleEntity, ArcEntity, PolylineEntity, RectEntity, TextEntity, EllipseEntity, DimensionEntity, HatchEntity, RegionEntity, BlockRefEntity } from '../types';
import { store, nextId } from '../store';
import { dist, angle, polarPoint, pointOnEntity, entityBounds, bulgeArc } from '../geometry';
import { CommandEngine } from './engine';
import { makeEntity, moveEntity, rotateEntity, scaleEntity, mirrorEntity, offsetEntity,
         joinToPline, ptsEqual, entityEndpoints, entityToPoints, rotatePoint } from './helpers';
import { catmullRomSpline } from './draw';

export function registerModifyCommands(engine: CommandEngine) {

  // === ERASE ===
  engine.register('ERASE', ['E', 'DEL'], () => {
    engine.requireSelection((sel) => {
      store.pushUndo('ERASE');
      for (const e of sel) store.removeEntity(e.id);
      engine.prompt(`${sel.length} erased`);
      engine.complete();
    });
  });

  // === MOVE ===
  engine.register('MOVE', ['M'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('MOVE Specify base point:');
      engine.waitForClick((base) => {
        engine.tempPoints = [base];
        engine.prompt('Specify displacement point:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: base, end: p };
        });
        engine.waitForClick((dest) => {
          const dx = dest.x - base.x, dy = dest.y - base.y;
          store.pushUndo('MOVE');
          for (const e of sel) moveEntity(e, dx, dy);
          store.emit();
          engine.renderer.rubberBand = null;
          store.clearSelection();
          engine.prompt(`${sel.length} moved`);
          engine.complete();
        });
      });
    });
  });

  // === COPY ===
  engine.register('COPY', ['CO', 'CP'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('COPY Specify base point:');
      engine.waitForClick((base) => {
        engine.tempPoints = [base];
        doCopyDisplacement(engine, sel, base);
      });
    });
  });

  // === ROTATE ===
  engine.register('ROTATE', ['RO'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('ROTATE Specify base point:');
      engine.waitForClick((base) => {
        engine.tempPoints = [base];
        engine.prompt('Specify rotation angle or [Reference]:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: base, end: p };
        });
        engine.inputHandler = (input) => {
          if (input === '') { engine.renderer.rubberBand = null; engine.complete(); return true; }
          const lower = input.toLowerCase();
          if (lower === 'r' || lower === 'reference') {
            engine.renderer.rubberBand = null;
            engine.prompt('Specify reference angle <0>:');
            engine.waitForInput('Ref angle:', (refInput) => {
              const refAngle = refInput === '' ? 0 : parseFloat(refInput);
              if (isNaN(refAngle)) { engine.prompt('Invalid angle'); engine.complete(); return true; }
              engine.prompt('Specify new angle:');
              engine.waitForInput('New angle:', (newInput) => {
                const newAngle = parseFloat(newInput);
                if (isNaN(newAngle)) { engine.prompt('Invalid angle'); engine.complete(); return true; }
                const ang = (newAngle - refAngle) * Math.PI / 180;
                store.pushUndo('ROTATE');
                for (const e of sel) rotateEntity(e, base, ang);
                store.emit();
                store.clearSelection();
                engine.prompt(`${sel.length} rotated ${(newAngle - refAngle).toFixed(1)}°`);
                engine.complete();
                return true;
              });
              return true;
            });
            return true;
          }
          const degrees = parseFloat(input);
          if (isNaN(degrees)) return false;
          const ang = degrees * Math.PI / 180;
          store.pushUndo('ROTATE');
          for (const e of sel) rotateEntity(e, base, ang);
          store.emit();
          engine.renderer.rubberBand = null;
          store.clearSelection();
          engine.prompt(`${sel.length} rotated ${degrees}°`);
          engine.complete();
          return true;
        };
        engine.waitForClick((p2) => {
          const ang = angle(base, p2);
          store.pushUndo('ROTATE');
          for (const e of sel) rotateEntity(e, base, ang);
          store.emit();
          engine.renderer.rubberBand = null;
          store.clearSelection();
          engine.prompt(`${sel.length} rotated`);
          engine.complete();
        });
      });
    });
  });

  // === SCALE ===
  engine.register('SCALE', ['SC'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('SCALE Specify base point:');
      engine.waitForClick((base) => {
        engine.prompt('Specify scale factor or [Reference]:');
        engine.waitForInput('Scale factor:', (input) => {
          const lower = input.toLowerCase();
          if (lower === 'r' || lower === 'reference') {
            engine.prompt('Specify reference length <1>:');
            engine.waitForInput('Ref length:', (refInput) => {
              const refLen = refInput === '' ? 1 : parseFloat(refInput);
              if (isNaN(refLen) || refLen <= 0) { engine.prompt('Requires a positive length'); engine.complete(); return true; }
              engine.prompt('Specify new length:');
              engine.waitForInput('New length:', (newInput) => {
                const newLen = parseFloat(newInput);
                if (isNaN(newLen) || newLen <= 0) { engine.prompt('Requires a positive length'); engine.complete(); return true; }
                const factor = newLen / refLen;
                store.pushUndo('SCALE');
                for (const e of sel) scaleEntity(e, base, factor);
                store.emit();
                store.clearSelection();
                engine.prompt(`${sel.length} scaled by ${factor.toFixed(4)}`);
                engine.complete();
                return true;
              });
              return true;
            });
            return true;
          }
          const factor = parseFloat(input);
          if (isNaN(factor) || factor <= 0) { engine.prompt('Requires a positive, nonzero scale factor.'); return true; }
          store.pushUndo('SCALE');
          for (const e of sel) scaleEntity(e, base, factor);
          store.emit();
          store.clearSelection();
          engine.prompt(`${sel.length} scaled by ${factor}`);
          engine.complete();
          return true;
        });
      });
    });
  });

  // === MIRROR ===
  engine.register('MIRROR', ['MI'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('MIRROR Specify first point of mirror line:');
      engine.waitForClick((p1) => {
        engine.prompt('Specify second point of mirror line:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: p1, end: p };
        });
        engine.waitForClick((p2) => {
          engine.renderer.rubberBand = null;
          engine.prompt('Erase source objects? [Yes/No] <N>:');
          engine.waitForInput('Erase source?', (input) => {
            const erase = input.toLowerCase().startsWith('y');
            store.pushUndo('MIRROR');
            for (const e of sel) {
              const copy = JSON.parse(JSON.stringify(e));
              copy.id = nextId();
              copy.selected = false;
              mirrorEntity(copy, p1, p2);
              store.addEntity(copy);
            }
            if (erase) {
              for (const e of sel) store.removeEntity(e.id);
            }
            store.clearSelection();
            engine.prompt(`${sel.length} mirrored`);
            engine.complete();
            return true;
          });
        });
      });
    });
  });

  // === OFFSET ===
  engine.register('OFFSET', ['O'], () => {
    engine.prompt('OFFSET Specify offset distance:');
    engine.waitForInput('Distance:', (input) => {
      const distance = parseFloat(input);
      if (isNaN(distance) || distance <= 0) { engine.prompt('Invalid distance'); return true; }
      doOffsetLoop(engine, distance);
      return true;
    });
  });

  // === PEDIT ===
  engine.register('PEDIT', ['PE'], () => {
    engine.prompt('PEDIT Select polyline or [Multiple]:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const entity = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
      if (!entity) { engine.prompt('No object found'); engine.complete(); return; }

      if (entity.type === 'line') {
        engine.prompt('Object selected is not a polyline.');
        engine.prompt('Do you want to turn it into one? <Y>:');
        engine.inputHandler = (input) => {
          const lower = input.toLowerCase();
          if (lower === 'n' || lower === 'no') {
            engine.prompt('Command cancelled.');
            engine.complete();
            return true;
          }
          store.pushUndo('PEDIT');
          const line = entity as LineEntity;
          const pline = makeEntity({
            type: 'polyline',
            points: [{ ...line.start }, { ...line.end }],
            bulges: [0, 0],
            closed: false,
          } as any) as PolylineEntity;
          const idx = store.entities.indexOf(entity);
          store.entities[idx] = pline;
          store.emit();
          engine.prompt('Line converted to polyline.');
          peditOptions(engine, pline);
          return true;
        };
        return;
      }

      if (entity.type !== 'polyline') {
        engine.prompt('Object is not a polyline or line');
        engine.complete();
        return;
      }

      peditOptions(engine, entity as PolylineEntity);
    });
  });

  // === EXPLODE ===
  engine.register('EXPLODE', ['X'], () => {
    engine.requireSelection((sel) => {
      store.pushUndo('EXPLODE');
      let count = 0;
      for (const e of sel) {
        if (e.type === 'polyline') {
          const poly = e as PolylineEntity;
          const pts = poly.points;
          const bulges = poly.bulges || [];
          const n = poly.closed ? pts.length : pts.length - 1;
          for (let i = 0; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            const bulge = bulges[i] || 0;
            if (bulge !== 0) {
              const arc = bulgeArc(a, b, bulge);
              store.addEntity(makeEntity({ type: 'arc', center: { ...arc.center }, radius: arc.radius, startAngle: arc.startAngle, endAngle: arc.endAngle } as any));
            } else {
              store.addEntity(makeEntity({ type: 'line', start: { ...a }, end: { ...b } } as any));
            }
          }
          store.removeEntity(e.id);
          count++;
        } else if (e.type === 'rect') {
          const r = e as RectEntity;
          const c1 = r.corner1, c2 = r.corner2;
          const corners = [
            c1, { x: c2.x, y: c1.y }, c2, { x: c1.x, y: c2.y }
          ];
          for (let i = 0; i < 4; i++) {
            store.addEntity(makeEntity({ type: 'line', start: { ...corners[i] }, end: { ...corners[(i + 1) % 4] } } as any));
          }
          store.removeEntity(e.id);
          count++;
        } else if (e.type === 'blockref') {
          const def = store.blockDefs.get(e.blockName);
          if (def) {
            for (const be of def) {
              const copy: Entity = JSON.parse(JSON.stringify(be));
              copy.id = nextId();
              copy.selected = false;
              copy.layer = e.layer;
              scaleEntity(copy, { x: 0, y: 0 }, e.scaleX);
              if (e.rotation !== 0) rotateEntity(copy, { x: 0, y: 0 }, e.rotation * Math.PI / 180);
              moveEntity(copy, e.insertPoint.x, e.insertPoint.y);
              store.addEntity(copy);
            }
            store.removeEntity(e.id);
            count++;
          }
        } else if (e.type === 'dimension') {
          const dim = e;
          store.addEntity(makeEntity({ type: 'line', start: { ...dim.p1 }, end: { ...dim.p2 } } as any));
          const dx = dim.p2.x - dim.p1.x, dy = dim.p2.y - dim.p1.y;
          const measurement = Math.sqrt(dx * dx + dy * dy);
          const label = dim.textOverride || measurement.toFixed(store.unitPrecision);
          store.addEntity(makeEntity({
            type: 'text', position: { ...dim.textPos }, text: label,
            height: store.currentDimStyle.textHeight, rotation: 0,
          } as any));
          store.removeEntity(e.id);
          count++;
        } else if (e.type === 'hatch') {
          for (const boundary of (e as HatchEntity).boundaries) {
            if (boundary.length >= 2) {
              store.addEntity(makeEntity({
                type: 'polyline',
                points: boundary.map(p => ({ ...p })),
                bulges: boundary.map(() => 0),
                closed: true,
              } as any));
            }
          }
          store.removeEntity(e.id);
          count++;
        } else if (e.type === 'region') {
          const region = e as RegionEntity;
          store.addEntity(makeEntity({
            type: 'polyline',
            points: region.outerBoundary.map(p => ({ ...p })),
            bulges: region.outerBoundary.map(() => 0),
            closed: true,
          } as any));
          for (const hole of region.holes) {
            if (hole.length >= 2) {
              store.addEntity(makeEntity({
                type: 'polyline',
                points: hole.map(p => ({ ...p })),
                bulges: hole.map(() => 0),
                closed: true,
              } as any));
            }
          }
          store.removeEntity(e.id);
          count++;
        }
      }
      store.emit();
      engine.prompt(`${count} object(s) exploded`);
      store.clearSelection();
      engine.complete();
    });
  });

  // === JOIN ===
  engine.register('JOIN', ['J'], () => {
    engine.requireSelection((sel) => {
      if (sel.length < 2) { engine.prompt('Select at least 2 objects'); engine.complete(); return; }
      const first = sel.find(e => e.type === 'line' || e.type === 'arc' || e.type === 'polyline');
      if (!first) { engine.prompt('No joinable objects'); engine.complete(); return; }

      store.pushUndo('JOIN');
      let pline: PolylineEntity;
      if (first.type === 'polyline') {
        pline = first as PolylineEntity;
      } else {
        const pts = entityToPoints(first, false);
        pline = makeEntity({ type: 'polyline', points: pts, bulges: pts.map(() => 0), closed: false } as any);
        const idx = store.entities.indexOf(first);
        store.entities[idx] = pline;
      }

      let joined = 0;
      for (const e of sel) {
        if (e.id === first.id || e.id === pline.id) continue;
        if (joinToPline(pline, e)) {
          store.removeEntity(e.id);
          joined++;
        }
      }
      store.emit();
      store.clearSelection();
      engine.prompt(`${joined} object(s) joined`);
      engine.complete();
    });
  });

  // === STRETCH ===
  engine.register('STRETCH', ['S'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('STRETCH Specify base point:');
      engine.waitForClick((base) => {
        engine.prompt('Specify second point of displacement:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: base, end: p };
        });
        engine.waitForClick((dest) => {
          const dx = dest.x - base.x, dy = dest.y - base.y;
          const tol = 20 / store.view.zoom;
          store.pushUndo('STRETCH');
          for (const e of sel) {
            if (e.type === 'line') {
              const ln = e as LineEntity;
              if (dist(ln.start, base) <= tol) { ln.start.x += dx; ln.start.y += dy; }
              if (dist(ln.end, base) <= tol) { ln.end.x += dx; ln.end.y += dy; }
            } else if (e.type === 'polyline') {
              const pl = e as PolylineEntity;
              for (const pt of pl.points) {
                if (dist(pt, base) <= tol) { pt.x += dx; pt.y += dy; }
              }
            } else if (e.type === 'rect') {
              const r = e as RectEntity;
              if (dist(r.corner1, base) <= tol) { r.corner1.x += dx; r.corner1.y += dy; }
              if (dist(r.corner2, base) <= tol) { r.corner2.x += dx; r.corner2.y += dy; }
            } else if (e.type === 'circle') {
              const c = e as CircleEntity;
              if (dist(c.center, base) <= tol) { c.center.x += dx; c.center.y += dy; }
            } else if (e.type === 'arc') {
              const a = e as ArcEntity;
              if (dist(a.center, base) <= tol) { a.center.x += dx; a.center.y += dy; }
            } else if (e.type === 'text') {
              const t = e as TextEntity;
              if (dist(t.position, base) <= tol) { t.position.x += dx; t.position.y += dy; }
            } else if (e.type === 'ellipse') {
              const el = e as EllipseEntity;
              if (dist(el.center, base) <= tol) { el.center.x += dx; el.center.y += dy; }
            } else if (e.type === 'dimension') {
              const dim = e as DimensionEntity;
              if (dist(dim.p1, base) <= tol) { dim.p1.x += dx; dim.p1.y += dy; }
              if (dist(dim.p2, base) <= tol) { dim.p2.x += dx; dim.p2.y += dy; }
              if (dist(dim.textPos, base) <= tol) { dim.textPos.x += dx; dim.textPos.y += dy; }
            } else {
              moveEntity(e, dx, dy);
            }
          }
          store.emit();
          engine.renderer.rubberBand = null;
          store.clearSelection();
          engine.prompt(`${sel.length} stretched`);
          engine.complete();
        });
      });
    });
  });

  // === ARRAY ===
  engine.register('ARRAY', ['AR'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('ARRAY Enter array type [Rectangular/Polar] <R>:');
      engine.inputHandler = (input) => {
        const lower = input.toLowerCase();
        if (lower === '' || lower === 'r' || lower === 'rectangular') {
          engine.inputHandler = null;
          doRectArray(engine, sel);
          return true;
        }
        if (lower === 'p' || lower === 'polar') {
          engine.inputHandler = null;
          doPolarArray(engine, sel);
          return true;
        }
        engine.prompt('Invalid option. [Rectangular/Polar]:');
        return true;
      };
    });
  });

  // === ALIGN ===
  engine.register('ALIGN', ['AL'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('ALIGN Specify first source point:');
      engine.waitForClick((src1) => {
        engine.prompt('Specify first destination point:');
        engine.waitForClick((dst1) => {
          engine.prompt('Specify second source point or <Enter> for 1-point alignment:');
          engine.inputHandler = (input) => {
            if (input === '') {
              store.pushUndo('ALIGN');
              const dx = dst1.x - src1.x, dy = dst1.y - src1.y;
              for (const e of sel) moveEntity(e, dx, dy);
              store.emit();
              store.clearSelection();
              engine.prompt(`${sel.length} object(s) aligned (translate)`);
              engine.complete();
              return true;
            }
            return false;
          };
          engine.waitForClick((src2) => {
            engine.inputHandler = null;
            engine.prompt('Specify second destination point:');
            engine.waitForClick((dst2) => {
              engine.prompt('Scale objects based on alignment points? [Yes/No] <N>:');
              engine.waitForInput('Scale?:', (scInput) => {
                const doScale = scInput.toLowerCase().startsWith('y');
                store.pushUndo('ALIGN');
                const dx1 = dst1.x - src1.x, dy1 = dst1.y - src1.y;
                for (const e of sel) moveEntity(e, dx1, dy1);
                const movedSrc2 = { x: src2.x + dx1, y: src2.y + dy1 };
                const ang1 = angle(dst1, movedSrc2);
                const ang2 = angle(dst1, dst2);
                const rotAngle = ang2 - ang1;
                for (const e of sel) rotateEntity(e, dst1, rotAngle);
                if (doScale) {
                  const srcDist = dist(src1, src2);
                  const dstDist = dist(dst1, dst2);
                  if (srcDist > 1e-10) {
                    const factor = dstDist / srcDist;
                    for (const e of sel) scaleEntity(e, dst1, factor);
                  }
                }
                store.emit();
                store.clearSelection();
                engine.prompt(`${sel.length} object(s) aligned`);
                engine.complete();
                return true;
              });
            });
          });
        });
      });
    });
  });

  // === LENGTHEN ===
  engine.register('LENGTHEN', ['LEN'], () => {
    engine.prompt('LENGTHEN Select an object or [DElta/Percent/Total]:');
    engine.inputHandler = (input) => {
      if (input === '') { engine.complete(); return true; }
      const lower = input.toLowerCase();
      if (lower === 'de' || lower === 'delta') {
        engine.prompt('Enter delta length:');
        engine.inputHandler = (dInput) => {
          if (dInput === '') { engine.complete(); return true; }
          const delta = parseFloat(dInput);
          if (isNaN(delta)) { engine.prompt('Requires a number'); return true; }
          doLengthen(engine, 'delta', delta);
          return true;
        };
        return true;
      }
      if (lower === 'p' || lower === 'percent') {
        engine.prompt('Enter percentage (e.g. 150 for 150%):');
        engine.inputHandler = (pInput) => {
          if (pInput === '') { engine.complete(); return true; }
          const pct = parseFloat(pInput);
          if (isNaN(pct) || pct <= 0) { engine.prompt('Requires a positive number'); return true; }
          doLengthen(engine, 'percent', pct);
          return true;
        };
        return true;
      }
      if (lower === 't' || lower === 'total') {
        engine.prompt('Enter total length:');
        engine.inputHandler = (tInput) => {
          if (tInput === '') { engine.complete(); return true; }
          const total = parseFloat(tInput);
          if (isNaN(total) || total <= 0) { engine.prompt('Requires a positive number'); return true; }
          doLengthen(engine, 'total', total);
          return true;
        };
        return true;
      }
      return false;
    };
  });

  // === DDEDIT / TEXTEDIT ===
  engine.register('DDEDIT', ['ED', 'TEXTEDIT'], () => {
    engine.prompt('DDEDIT Select a text or dimension object:');
    const pickText = () => {
      engine.waitForClick((pt) => {
        const tol = 10 / store.view.zoom;
        let target: Entity | null = null;
        for (const e of store.entities) {
          if ((e.type === 'text' || e.type === 'dimension') && pointOnEntity(pt, e, tol)) {
            target = e;
            break;
          }
        }
        if (!target) {
          engine.prompt('No text or dimension found. Select a text/dimension object:');
          pickText();
          return;
        }
        if (target.type === 'text') {
          const textEnt = target;
          engine.prompt(`Current text: "${textEnt.text}"`);
          engine.prompt('Enter new text (or press Enter to keep):');
          engine.waitForInput('New text:', (newText) => {
            if (newText !== '') {
              store.pushUndo('DDEDIT');
              textEnt.text = newText;
              store.emit();
              engine.prompt(`Text changed to "${newText}"`);
            }
            engine.prompt('Select another text/dimension or press Enter to exit:');
            engine.inputHandler = (input) => {
              if (input === '') { engine.complete(); return true; }
              return false;
            };
            pickText();
            return true;
          });
        } else if (target.type === 'dimension') {
          const dimEnt = target;
          const current = dimEnt.textOverride || '<measured>';
          engine.prompt(`Current dimension text: "${current}"`);
          engine.prompt('Enter new text (or Enter to keep, "<>" for measured value):');
          engine.waitForInput('Dim text:', (newText) => {
            if (newText !== '') {
              store.pushUndo('DDEDIT');
              if (newText === '<>') {
                dimEnt.textOverride = undefined;
                engine.prompt('Dimension text reset to measured value');
              } else {
                dimEnt.textOverride = newText;
                engine.prompt(`Dimension text set to "${newText}"`);
              }
              store.emit();
            }
            engine.prompt('Select another text/dimension or press Enter to exit:');
            engine.inputHandler = (input) => {
              if (input === '') { engine.complete(); return true; }
              return false;
            };
            pickText();
            return true;
          });
        }
      });
    };
    pickText();
  });

  // === CHPROP ===
  engine.register('CHPROP', ['CH'], () => {
    engine.requireSelection((sel) => {
      doChprop(engine, sel);
    });
  });

  // === CHANGE ===
  engine.register('CHANGE', ['-CH'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('CHANGE Specify change point or [Properties]:');
      engine.inputHandler = (input) => {
        const lower = input.toLowerCase();
        if (lower === 'p' || lower === 'properties') {
          doChprop(engine, sel);
          return true;
        }
        if (input === '') { engine.complete(); return true; }
        return false;
      };
      engine.waitForClick((pt) => {
        engine.inputHandler = null;
        if (sel.length === 1) {
          const e = sel[0];
          if (e.type === 'line') {
            store.pushUndo('CHANGE');
            const d1 = dist(pt, e.start), d2 = dist(pt, e.end);
            if (d1 < d2) e.end = { ...pt };
            else e.start = { ...pt };
            store.emit();
            engine.prompt('Endpoint changed');
            engine.complete();
          } else if (e.type === 'circle') {
            store.pushUndo('CHANGE');
            e.radius = dist(e.center, pt);
            store.emit();
            engine.prompt(`Radius changed to ${e.radius.toFixed(4)}`);
            engine.complete();
          } else if (e.type === 'text') {
            store.pushUndo('CHANGE');
            e.position = { ...pt };
            store.emit();
            engine.prompt('Text position changed');
            engine.prompt('Enter new text height or Enter to keep:');
            engine.waitForInput('Height:', (hInput) => {
              if (hInput) {
                const h = parseFloat(hInput);
                if (!isNaN(h) && h > 0) { e.height = h; store.emit(); }
              }
              engine.prompt('Enter new rotation or Enter to keep:');
              engine.waitForInput('Rotation:', (rInput) => {
                if (rInput) {
                  const r = parseFloat(rInput);
                  if (!isNaN(r)) { e.rotation = r; store.emit(); }
                }
                engine.prompt('Enter new text or Enter to keep:');
                engine.waitForInput('Text:', (tInput) => {
                  if (tInput) { e.text = tInput; store.emit(); }
                  engine.complete();
                  return true;
                });
                return true;
              });
              return true;
            });
          } else {
            engine.prompt('Cannot change this entity type with a point. Use [Properties].');
            engine.complete();
          }
        } else {
          // Multiple objects: change point moves all endpoints near the click
          store.pushUndo('CHANGE');
          let changed = 0;
          for (const e of sel) {
            if (e.type === 'line') {
              const d1 = dist(pt, e.start), d2 = dist(pt, e.end);
              if (d1 < d2) { e.end = { ...pt }; changed++; }
              else { e.start = { ...pt }; changed++; }
            }
          }
          store.emit();
          engine.prompt(`${changed} endpoint(s) changed`);
          engine.complete();
        }
      });
    });
  });

  // === DRAWORDER ===
  engine.register('DRAWORDER', ['DR'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('DRAWORDER Enter option [Front/Back/Above/Under]:');
      engine.waitForInput('Order:', (input) => {
        if (input === '') { engine.complete(); return true; }
        doDrawOrder(engine, sel, input);
        return true;
      });
    });
  });

  // === TXTEXP (Text Explode) ===
  engine.register('TXTEXP', [], () => {
    engine.requireSelection((sel) => {
      const textEnts = sel.filter(e => e.type === 'text') as TextEntity[];
      if (textEnts.length === 0) {
        engine.prompt('TXTEXP No text entities selected');
        engine.complete();
        return;
      }
      store.pushUndo('TXTEXP');
      let totalPaths = 0;
      for (const te of textEnts) {
        const paths = textToPolylines(te.text, te.position, te.height, te.rotation);
        for (const pts of paths) {
          if (pts.length < 2) continue;
          store.addEntity(makeEntity({
            type: 'polyline',
            points: pts,
            closed: false,
          } as any));
          totalPaths++;
        }
        store.removeEntity(te.id);
      }
      store.clearSelection();
      store.emit();
      engine.prompt(`TXTEXP: ${textEnts.length} text(s) exploded into ${totalPaths} polyline(s)`);
      engine.complete();
    });
  });

  // === SPLINEDIT ===
  engine.register('SPLINEDIT', ['SPE'], () => {
    engine.prompt('SPLINEDIT Select spline to edit:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      const spline = store.entities.find(e =>
        e.visible && e.type === 'polyline' && (e as PolylineEntity).fitPoints && pointOnEntity(pt, e, tol)
      ) as PolylineEntity | undefined;

      if (!spline) {
        engine.prompt('No spline found (entity must have fit points)');
        engine.complete();
        return;
      }

      const fitPts = spline.fitPoints!;
      engine.prompt(`SPLINEDIT Spline with ${fitPts.length} fit points`);
      engine.prompt('Enter option [Move/Add/Delete/Close/Open/Refine] or Enter to exit:');
      doSplineEditMenu(engine, spline);
    });
  });

  // === COPYCLIP ===
  engine.register('COPYCLIP', ['COPYBASE'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('Specify base point:');
      engine.waitForClick((base) => {
        store.clipboard = JSON.parse(JSON.stringify(sel));
        store.clipboardBase = { ...base };
        store.clearSelection();
        engine.prompt(`${sel.length} object(s) copied to clipboard`);
        engine.complete();
      });
    });
  });

  // === PASTECLIP ===
  engine.register('PASTECLIP', ['PASTEBLOCK'], () => {
    if (store.clipboard.length === 0) {
      engine.prompt('Clipboard is empty');
      engine.complete();
      return;
    }
    engine.prompt(`${store.clipboard.length} object(s) on clipboard. Specify insertion point:`);
    engine.waitForClick((insertPt) => {
      store.pushUndo('PASTECLIP');
      const dx = insertPt.x - store.clipboardBase.x;
      const dy = insertPt.y - store.clipboardBase.y;
      let count = 0;
      for (const orig of store.clipboard) {
        const copy: Entity = JSON.parse(JSON.stringify(orig));
        copy.id = nextId();
        copy.selected = false;
        offsetEntityPoints(copy, dx, dy);
        store.addEntity(copy);
        count++;
      }
      store.emit();
      engine.prompt(`${count} object(s) pasted`);
      engine.complete();
    });
  });

  // === CUTCLIP ===
  engine.register('CUTCLIP', ['CUTBASE'], () => {
    engine.requireSelection((sel) => {
      engine.prompt('Specify base point:');
      engine.waitForClick((base) => {
        store.clipboard = JSON.parse(JSON.stringify(sel));
        store.clipboardBase = { ...base };
        store.pushUndo('CUTCLIP');
        for (const e of sel) store.removeEntity(e.id);
        store.emit();
        engine.prompt(`${sel.length} object(s) cut to clipboard`);
        engine.complete();
      });
    });
  });

  // === BURST ===
  engine.register('BURST', [], () => {
    engine.requireSelection((sel) => {
      const blockRefs = sel.filter(e => e.type === 'blockref') as BlockRefEntity[];
      if (blockRefs.length === 0) {
        engine.prompt('BURST No block references selected');
        engine.complete();
        return;
      }
      store.pushUndo('BURST');
      let totalCreated = 0;
      for (const br of blockRefs) {
        const blockEnts = store.blockDefs.get(br.blockName);
        if (blockEnts) {
          for (const sub of blockEnts) {
            const copy: Entity = JSON.parse(JSON.stringify(sub));
            copy.id = nextId();
            copy.selected = false;
            offsetEntityPoints(copy, br.insertPoint.x, br.insertPoint.y);
            store.addEntity(copy);
            totalCreated++;
          }
        }
        if (br.attributes && br.attributes.length > 0) {
          const h = store.currentDimStyle.textHeight;
          for (let i = 0; i < br.attributes.length; i++) {
            store.addEntity(makeEntity({
              type: 'text',
              position: { x: br.insertPoint.x, y: br.insertPoint.y - (i + 1) * h * 1.5 },
              text: br.attributes[i].value,
              height: h,
              rotation: br.rotation,
            } as any));
            totalCreated++;
          }
        }
        store.removeEntity(br.id);
      }
      store.clearSelection();
      store.emit();
      engine.prompt(`BURST: ${blockRefs.length} block(s) burst into ${totalCreated} entities`);
      engine.complete();
    });
  });

  // === OVERKILL ===
  engine.register('OVERKILL', ['OVK'], () => {
    engine.requireSelection((sel) => {
      const TOL = 0.001;
      const eq = (a: number, b: number) => Math.abs(a - b) < TOL;
      const peq = (a: Point, b: Point) => eq(a.x, b.x) && eq(a.y, b.y);
      function isDup(a: Entity, b: Entity): boolean {
        if (a.type !== b.type) return false;
        switch (a.type) {
          case 'line': {
            const bl = b as LineEntity;
            return (peq(a.start, bl.start) && peq(a.end, bl.end)) ||
                   (peq(a.start, bl.end) && peq(a.end, bl.start));
          }
          case 'circle': {
            const bc = b as CircleEntity;
            return peq(a.center, bc.center) && eq(a.radius, bc.radius);
          }
          case 'arc': {
            const ba = b as ArcEntity;
            return peq(a.center, ba.center) && eq(a.radius, ba.radius) &&
                   eq(a.startAngle, ba.startAngle) && eq(a.endAngle, ba.endAngle);
          }
          case 'point': {
            const bp = b as any;
            return peq(a.position, bp.position);
          }
          case 'polyline': {
            const bpl = b as PolylineEntity;
            if (a.points.length !== bpl.points.length) return false;
            return a.points.every((p, i) => peq(p, bpl.points[i]));
          }
          case 'rect': {
            const br = b as RectEntity;
            return peq(a.corner1, br.corner1) && peq(a.corner2, br.corner2);
          }
          case 'text': {
            const bt = b as TextEntity;
            return peq(a.position, bt.position) && a.text === bt.text && eq(a.height, bt.height);
          }
          default: return false;
        }
      }
      const keep = new Set<string>();
      const remove = new Set<string>();
      for (let i = 0; i < sel.length; i++) {
        if (remove.has(sel[i].id)) continue;
        keep.add(sel[i].id);
        for (let j = i + 1; j < sel.length; j++) {
          if (remove.has(sel[j].id)) continue;
          if (isDup(sel[i], sel[j])) remove.add(sel[j].id);
        }
      }
      if (remove.size > 0) {
        store.pushUndo('OVERKILL');
        for (const id of remove) store.removeEntity(id);
      }
      store.clearSelection();
      engine.prompt(`OVERKILL: ${remove.size} duplicate(s) removed`);
      engine.complete();
    });
  });

  // === FLATTEN ===
  engine.register('FLATTEN', [], () => {
    engine.requireSelection((sel) => {
      store.pushUndo('FLATTEN');
      let processed = 0;
      for (const e of sel) {
        if (e.type === 'polyline') {
          const pts = e.points;
          const cleaned: Point[] = [pts[0]];
          for (let i = 1; i < pts.length; i++) {
            const prev = cleaned[cleaned.length - 1];
            if (Math.abs(pts[i].x - prev.x) > 0.0001 || Math.abs(pts[i].y - prev.y) > 0.0001) {
              cleaned.push(pts[i]);
            }
          }
          if (cleaned.length !== pts.length) {
            e.points = cleaned;
            e.bulges = e.bulges.slice(0, cleaned.length);
          }
        }
        processed++;
      }
      store.clearSelection();
      store.emit();
      engine.prompt(`FLATTEN: ${processed} entities processed`);
      engine.complete();
    });
  });

  // === NCOPY ===
  engine.register('NCOPY', [], () => {
    engine.requireSelection((sel) => {
      const blockrefs = sel.filter(e => e.type === 'blockref') as BlockRefEntity[];
      if (blockrefs.length === 0) {
        engine.prompt('No block references selected');
        engine.complete();
        return;
      }
      store.pushUndo('NCOPY');
      let count = 0;
      const curLayer = store.currentLayer().name;
      for (const br of blockrefs) {
        const defEntities = store.blockDefs.get(br.blockName);
        if (!defEntities) continue;
        for (const de of defEntities) {
          const copy = JSON.parse(JSON.stringify(de)) as Entity;
          (copy as any).id = nextId();
          copy.layer = curLayer;
          copy.selected = false;
          moveEntity(copy, br.insertPoint.x, br.insertPoint.y);
          if (br.scaleX !== 1 || br.scaleY !== 1) {
            scaleEntity(copy, br.insertPoint, Math.max(br.scaleX, br.scaleY));
          }
          store.entities.push(copy);
          count++;
        }
      }
      store.clearSelection();
      store.emit();
      engine.prompt(`NCOPY: ${count} entity(s) extracted from blocks`);
      engine.complete();
    });
  });

  // === ARRAYPOLAR ===
  engine.register('ARRAYPOLAR', [], () => {
    engine.requireSelection((sel) => {
      engine.prompt('Specify center point of array:');
      engine.waitForClick((center) => {
        engine.prompt('Enter number of items:');
        engine.waitForInput('Count:', (cInput) => {
          const count = parseInt(cInput);
          if (isNaN(count) || count < 2) { engine.prompt('Invalid count (minimum 2)'); engine.complete(); return true; }
          engine.prompt('Specify angle to fill <360>:');
          engine.waitForInput('Angle:', (aInput) => {
            const fillAngle = aInput === '' ? 360 : parseFloat(aInput);
            if (isNaN(fillAngle)) { engine.prompt('Invalid angle'); engine.complete(); return true; }
            store.pushUndo('ARRAYPOLAR');
            let created = 0;
            for (let i = 1; i < count; i++) {
              const angRad = (fillAngle * i / count) * Math.PI / 180;
              const copies: Entity[] = JSON.parse(JSON.stringify(sel));
              for (const copy of copies) {
                copy.id = nextId();
                copy.selected = false;
                rotateEntity(copy, center, angRad);
                store.entities.push(copy);
                created++;
              }
            }
            store.clearSelection();
            store.emit();
            engine.prompt(`ARRAYPOLAR: ${created} entity(s) created in ${count} positions`);
            engine.complete();
            return true;
          });
          return true;
        });
      });
    });
  });

  // === ARRAYRECT ===
  engine.register('ARRAYRECT', [], () => {
    engine.requireSelection((sel) => {
      engine.prompt('Enter number of columns <2>:');
      engine.waitForInput('Columns:', (cInput) => {
        const cols = cInput === '' ? 2 : parseInt(cInput);
        if (isNaN(cols) || cols < 1) { engine.prompt('Invalid column count'); engine.complete(); return true; }
        engine.prompt('Enter number of rows <2>:');
        engine.waitForInput('Rows:', (rInput) => {
          const rows = rInput === '' ? 2 : parseInt(rInput);
          if (isNaN(rows) || rows < 1) { engine.prompt('Invalid row count'); engine.complete(); return true; }
          engine.prompt('Specify column spacing:');
          engine.waitForInput('Col spacing:', (csInput) => {
            const colSpace = parseFloat(csInput);
            if (isNaN(colSpace)) { engine.prompt('Invalid spacing'); engine.complete(); return true; }
            engine.prompt('Specify row spacing:');
            engine.waitForInput('Row spacing:', (rsInput) => {
              const rowSpace = parseFloat(rsInput);
              if (isNaN(rowSpace)) { engine.prompt('Invalid spacing'); engine.complete(); return true; }
              store.pushUndo('ARRAYRECT');
              let created = 0;
              for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                  if (r === 0 && c === 0) continue;
                  const dx = c * colSpace;
                  const dy = r * rowSpace;
                  const copies: Entity[] = JSON.parse(JSON.stringify(sel));
                  for (const copy of copies) {
                    copy.id = nextId();
                    copy.selected = false;
                    moveEntity(copy, dx, dy);
                    store.entities.push(copy);
                    created++;
                  }
                }
              }
              store.clearSelection();
              store.emit();
              engine.prompt(`ARRAYRECT: ${created} entity(s) created in ${rows}x${cols} grid`);
              engine.complete();
              return true;
            });
            return true;
          });
          return true;
        });
        return true;
      });
    });
  });

  // === CONVERTPOLY ===
  engine.register('CONVERTPOLY', ['CONVERTPLINE'], () => {
    engine.requireSelection((sel) => {
      store.pushUndo('CONVERTPOLY');
      let converted = 0;
      for (const e of sel) {
        if (e.type === 'line') {
          const pl = makeEntity({
            type: 'polyline',
            points: [{ ...e.start }, { ...e.end }],
            bulges: [0, 0],
            closed: false,
          } as any);
          pl.layer = e.layer;
          pl.color = e.color;
          pl.linetype = e.linetype;
          pl.lineweight = e.lineweight;
          store.entities = store.entities.filter(en => en.id !== e.id);
          store.entities.push(pl);
          converted++;
        } else if (e.type === 'arc') {
          const pts: Point[] = [];
          let sa = e.startAngle, ea = e.endAngle;
          if (typeof sa === 'number' && typeof ea === 'number') {
            let startRad = sa;
            let endRad = ea;
            if (endRad <= startRad) endRad += 2 * Math.PI;
            for (let i = 0; i <= 18; i++) {
              const a = startRad + (endRad - startRad) * i / 18;
              pts.push({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
            }
          }
          if (pts.length >= 2) {
            const pl = makeEntity({
              type: 'polyline',
              points: pts,
              bulges: pts.map(() => 0),
              closed: false,
            } as any);
            pl.layer = e.layer;
            pl.color = e.color;
            pl.linetype = e.linetype;
            pl.lineweight = e.lineweight;
            store.entities = store.entities.filter(en => en.id !== e.id);
            store.entities.push(pl);
            converted++;
          }
        }
      }
      store.clearSelection();
      store.emit();
      engine.prompt(`CONVERTPOLY: ${converted} entity(s) converted`);
      engine.complete();
    });
  });

  // === TEXTFIT ===
  engine.register('TEXTFIT', [], () => {
    engine.requireSelection((sel) => {
      const texts = sel.filter(e => e.type === 'text') as TextEntity[];
      if (texts.length === 0) { engine.prompt('No text entities selected'); engine.complete(); return; }
      engine.prompt('Specify first point of text fit:');
      engine.waitForClick((p1) => {
        engine.prompt('Specify second point of text fit:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: p1, end: p };
        });
        engine.waitForClick((p2) => {
          engine.renderer.rubberBand = null;
          const d = dist(p1, p2);
          store.pushUndo('TEXTFIT');
          for (const t of texts) {
            t.position = { ...p1 };
            t.rotation = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
            const charWidth = t.height * 0.6;
            const textLen = t.text.length * charWidth;
            if (textLen > 0) {
              (t as any).widthFactor = d / textLen;
            }
          }
          store.clearSelection();
          store.emit();
          engine.prompt(`TEXTFIT: ${texts.length} text(s) fitted`);
          engine.complete();
        });
      });
    });
  });

  // === XPLODE ===
  engine.register('XPLODE', ['XP'], () => {
    engine.requireSelection((sel) => {
      const explodable = sel.filter(e =>
        e.type === 'blockref' || e.type === 'polyline' || e.type === 'rect' ||
        e.type === 'region' || e.type === 'hatch'
      );
      if (explodable.length === 0) {
        engine.prompt('No explodable objects selected');
        engine.complete();
        return;
      }

      engine.prompt(`XPLODE ${explodable.length} objects. Property to inherit [All/Color/LAyer/LType]: `);
      engine.inputHandler = (input) => {
        if (input === '') input = 'a';
        const choice = input.toLowerCase();

        if (!['a', 'all', 'c', 'color', 'la', 'layer', 'lt', 'ltype'].includes(choice)) {
          engine.prompt('Invalid option. [All/Color/LAyer/LType]:');
          return true;
        }

        store.pushUndo('XPLODE');
        let created = 0;
        const applyColor = choice === 'a' || choice === 'all' || choice === 'c' || choice === 'color';
        const applyLayer = choice === 'a' || choice === 'all' || choice === 'la' || choice === 'layer';

        for (const ent of explodable) {
          if (ent.type === 'blockref') {
            const blockEnt = ent as BlockRefEntity;
            const def = store.blockDefs.get(blockEnt.blockName);
            if (!def) continue;
            for (const be of def) {
              const clone = JSON.parse(JSON.stringify(be));
              clone.id = String(nextId());
              if (applyColor) clone.color = ent.color;
              if (applyLayer) clone.layer = ent.layer;
              moveEntity(clone, blockEnt.insertPoint.x, blockEnt.insertPoint.y);
              clone.selected = false;
              store.entities.push(clone);
              created++;
            }
          } else if (ent.type === 'polyline') {
            const poly = ent as PolylineEntity;
            const bulges = poly.bulges || [];
            const segCount = poly.closed ? poly.points.length : poly.points.length - 1;
            for (let i = 0; i < segCount; i++) {
              const p1 = poly.points[i], p2 = poly.points[(i + 1) % poly.points.length];
              const bulge = bulges[i] || 0;
              if (bulge !== 0) {
                const arcData = bulgeArc(p1, p2, bulge);
                const seg = makeEntity({
                  type: 'arc',
                  center: { ...arcData.center },
                  radius: arcData.radius,
                  startAngle: arcData.startAngle,
                  endAngle: arcData.endAngle,
                } as any);
                if (applyColor) seg.color = ent.color;
                if (applyLayer) seg.layer = ent.layer;
                store.entities.push(seg);
              } else {
                const seg = makeEntity({
                  type: 'line',
                  start: { ...p1 },
                  end: { ...p2 },
                } as any);
                if (applyColor) seg.color = ent.color;
                if (applyLayer) seg.layer = ent.layer;
                store.entities.push(seg);
              }
              created++;
            }
          } else if (ent.type === 'rect') {
            const rect = ent as RectEntity;
            const corners = [
              rect.corner1,
              { x: rect.corner2.x, y: rect.corner1.y },
              rect.corner2,
              { x: rect.corner1.x, y: rect.corner2.y },
            ];
            for (let i = 0; i < 4; i++) {
              const line = makeEntity({
                type: 'line',
                start: { ...corners[i] },
                end: { ...corners[(i + 1) % 4] },
              } as any);
              if (applyColor) line.color = ent.color;
              if (applyLayer) line.layer = ent.layer;
              store.entities.push(line);
              created++;
            }
          }
          store.removeEntity(ent.id);
        }

        store.emit();
        engine.prompt(`XPLODE ${explodable.length} objects exploded into ${created} entities`);
        engine.complete();
        return true;
      };
    });
  });

  // === ARRAYPATH ===
  engine.register('ARRAYPATH', [], () => {
    engine.requireSelection((sel) => {
      engine.prompt('ARRAYPATH Select path entity (line or polyline):');
      engine.inputHandler = (input) => {
        if (input === '') { engine.complete(); return true; }
        return false;
      };
      engine.waitForClick((pt) => {
        const tol = 10 / store.view.zoom;
        let pathEntity: Entity | null = null;
        for (const e of store.entities) {
          if ((e.type === 'line' || e.type === 'polyline') && pointOnEntity(pt, e, tol)) {
            pathEntity = e;
            break;
          }
        }
        if (!pathEntity) {
          engine.prompt('No line or polyline found at that point');
          engine.complete();
          return;
        }

        engine.inputHandler = null;
        engine.prompt('Enter number of items:');
        engine.waitForInput('Number of items:', (countInput) => {
          if (countInput === '') { engine.complete(); return true; }
          const count = parseInt(countInput);
          if (isNaN(count) || count < 2) {
            engine.prompt('Requires integer >= 2');
            engine.complete();
            return true;
          }

          let pathPoints: Point[] = [];
          if (pathEntity!.type === 'line') {
            const ln = pathEntity as LineEntity;
            pathPoints = [ln.start, ln.end];
          } else if (pathEntity!.type === 'polyline') {
            const poly = pathEntity as PolylineEntity;
            pathPoints = [...poly.points];
          }

          const segLengths: number[] = [];
          let totalLen = 0;
          for (let i = 0; i < pathPoints.length - 1; i++) {
            const d = dist(pathPoints[i], pathPoints[i + 1]);
            segLengths.push(d);
            totalLen += d;
          }

          if (totalLen === 0) {
            engine.prompt('Path has zero length');
            engine.complete();
            return true;
          }

          store.pushUndo('ARRAYPATH');
          const spacing = totalLen / (count - 1);

          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const e of sel) {
            const pts = entityToPoints(e, false);
            for (const p of pts) {
              minX = Math.min(minX, p.x);
              minY = Math.min(minY, p.y);
              maxX = Math.max(maxX, p.x);
              maxY = Math.max(maxY, p.y);
            }
          }
          const baseX = (minX + maxX) / 2;
          const baseY = (minY + maxY) / 2;

          let created = 0;
          for (let i = 0; i < count; i++) {
            const targetDist = i * spacing;
            let accumulated = 0;
            let targetPt = pathPoints[0];

            for (let j = 0; j < segLengths.length; j++) {
              if (accumulated + segLengths[j] >= targetDist || j === segLengths.length - 1) {
                const remainder = targetDist - accumulated;
                const t = segLengths[j] > 0 ? Math.min(remainder / segLengths[j], 1) : 0;
                targetPt = {
                  x: pathPoints[j].x + t * (pathPoints[j + 1].x - pathPoints[j].x),
                  y: pathPoints[j].y + t * (pathPoints[j + 1].y - pathPoints[j].y),
                };
                break;
              }
              accumulated += segLengths[j];
            }

            for (const e of sel) {
              const clone = JSON.parse(JSON.stringify(e));
              clone.id = String(nextId());
              clone.selected = false;
              const dx = targetPt.x - baseX;
              const dy = targetPt.y - baseY;
              moveEntity(clone, dx, dy);
              store.entities.push(clone);
              created++;
            }
          }

          store.emit();
          engine.prompt(`ARRAYPATH ${created} entities created along path`);
          engine.complete();
          return true;
        });
      });
    });
  });

  // === TORIENT ===
  engine.register('TORIENT', [], () => {
    engine.requireSelection((sel) => {
      const texts = sel.filter(e => e.type === 'text') as TextEntity[];
      if (texts.length === 0) {
        engine.prompt('No text objects selected');
        engine.complete();
        return;
      }
      store.pushUndo('TORIENT');
      let adjusted = 0;
      for (const t of texts) {
        let rot = t.rotation || 0;
        rot = ((rot % 360) + 360) % 360;
        if (rot > 90 && rot < 270) {
          t.rotation = rot - 180;
          adjusted++;
        } else if (rot >= 270) {
          t.rotation = rot - 360;
          adjusted++;
        } else {
          t.rotation = rot;
        }
        t.selected = false;
      }
      store.clearSelection();
      store.emit();
      engine.prompt(`TORIENT ${adjusted} of ${texts.length} text entities reoriented`);
      engine.complete();
    });
  });

  // === REFEDIT ===
  engine.register('REFEDIT', ['REFE'], () => {
    engine.requireSelection((sel) => {
      const blocks = sel.filter(e => e.type === 'blockref') as BlockRefEntity[];
      if (blocks.length === 0) {
        engine.prompt('No block references selected');
        engine.complete();
        return;
      }
      const blk = blocks[0];
      const def = store.blockDefs?.get(blk.blockName);
      if (!def || def.length === 0) {
        engine.prompt(`Block definition "${blk.blockName}" not found`);
        engine.complete();
        return;
      }
      store.pushUndo('REFEDIT');
      const ip = blk.insertPoint;
      for (const de of def) {
        const clone = JSON.parse(JSON.stringify(de));
        clone.id = String(nextId());
        clone.layer = store.currentLayer;
        offsetEntityPoints(clone, ip.x, ip.y);
        store.entities.push(clone);
      }
      (store as any).refeditState = {
        blockName: blk.blockName,
        insertPoint: { ...ip },
        originalEntityCount: store.entities.length - def.length,
      };
      blk.selected = false;
      store.clearSelection();
      store.emit();
      engine.prompt(`REFEDIT Editing block "${blk.blockName}". ${def.length} entities added for editing. Use CLOSE to save back.`);
      engine.complete();
    });
  });

  // === KERFOFFSET ===
  engine.register('KERFOFFSET', ['KO', 'KERF'], () => {
    engine.prompt('KERFOFFSET Specify kerf width (laser beam width):');
    engine.waitForInput('Kerf width:', (input) => {
      const kerf = parseFloat(input);
      if (isNaN(kerf) || kerf <= 0) { engine.prompt('Invalid kerf width'); engine.complete(); return true; }

      engine.prompt('Apply to [All/Selected] <All>:');
      engine.waitForInput('Scope:', (scopeInput) => {
        const scope = scopeInput.toLowerCase() || 'all';
        let entities: Entity[];
        if (scope === 's' || scope === 'selected') {
          entities = store.entities.filter(e => e.selected && e.visible);
        } else {
          entities = store.entities.filter(e => e.visible);
        }

        const geometric = entities.filter(e =>
          ['line', 'circle', 'arc', 'polyline', 'rect'].includes(e.type)
        );

        if (geometric.length === 0) {
          engine.prompt('No geometric entities found');
          engine.complete();
          return true;
        }

        engine.prompt('Mode [Inward/Outward/Auto] <Auto>:');
        engine.waitForInput('Mode:', (modeInput) => {
          const mode = modeInput.toLowerCase() || 'auto';

          store.pushUndo('KERFOFFSET');
          const halfKerf = kerf / 2;
          let offsetCount = 0;

          for (const e of geometric) {
            const isClosed = e.type === 'circle' || e.type === 'rect' ||
              (e.type === 'polyline' && (e as PolylineEntity).closed);

            if (!isClosed && (mode === 'auto' || mode === 'a')) continue;

            let side: Point;
            if (mode === 'outward' || mode === 'o') {
              side = computeOutsidePoint(e);
            } else {
              side = computeInsidePoint(e);
            }

            let entityToOffset: Entity = e;
            if (e.type === 'rect') {
              const r = e as RectEntity;
              entityToOffset = makeEntity({
                type: 'polyline',
                points: [
                  { x: r.corner1.x, y: r.corner1.y },
                  { x: r.corner2.x, y: r.corner1.y },
                  { x: r.corner2.x, y: r.corner2.y },
                  { x: r.corner1.x, y: r.corner2.y },
                ],
                bulges: [0, 0, 0, 0],
                closed: true,
              } as any) as PolylineEntity;
            }

            const result = offsetEntity(entityToOffset, halfKerf, side);
            if (result) {
              result.layer = e.layer;
              result.color = e.color;
              result.linetype = e.linetype;
              result.lineweight = e.lineweight;
              const idx = store.entities.indexOf(e);
              if (idx >= 0) {
                store.entities[idx] = result;
              }
              offsetCount++;
            }
          }

          store.emit();
          engine.prompt(`KERFOFFSET: ${offsetCount} entities offset by ${kerf} kerf width`);
          engine.complete();
          return true;
        });
        return true;
      });
      return true;
    });
  });
}

function computeInsidePoint(e: Entity): Point {
  switch (e.type) {
    case 'circle': {
      const c = e as CircleEntity;
      return { ...c.center };
    }
    case 'rect': {
      const r = e as RectEntity;
      return { x: (r.corner1.x + r.corner2.x) / 2, y: (r.corner1.y + r.corner2.y) / 2 };
    }
    case 'polyline': {
      const pl = e as PolylineEntity;
      let cx = 0, cy = 0;
      for (const p of pl.points) { cx += p.x; cy += p.y; }
      return { x: cx / pl.points.length, y: cy / pl.points.length };
    }
    default: {
      const bounds = entityBounds(e);
      if (bounds) return { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 };
      return { x: 0, y: 0 };
    }
  }
}

function computeOutsidePoint(e: Entity): Point {
  const bounds = entityBounds(e);
  if (bounds) {
    const margin = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y) + 1000;
    return { x: bounds.max.x + margin, y: bounds.max.y + margin };
  }
  return { x: 1e9, y: 1e9 };
}

function offsetEntityPoints(e: Entity, dx: number, dy: number) {
  switch (e.type) {
    case 'line':
      e.start.x += dx; e.start.y += dy;
      e.end.x += dx; e.end.y += dy;
      break;
    case 'circle':
      e.center.x += dx; e.center.y += dy;
      break;
    case 'arc':
      e.center.x += dx; e.center.y += dy;
      break;
    case 'polyline':
      for (const p of e.points) { p.x += dx; p.y += dy; }
      if (e.fitPoints) for (const p of e.fitPoints) { p.x += dx; p.y += dy; }
      break;
    case 'rect':
      e.corner1.x += dx; e.corner1.y += dy;
      e.corner2.x += dx; e.corner2.y += dy;
      break;
    case 'text':
      e.position.x += dx; e.position.y += dy;
      break;
    case 'ellipse':
      e.center.x += dx; e.center.y += dy;
      break;
    case 'point':
      e.position.x += dx; e.position.y += dy;
      break;
    case 'dimension':
      e.p1.x += dx; e.p1.y += dy;
      e.p2.x += dx; e.p2.y += dy;
      e.textPos.x += dx; e.textPos.y += dy;
      break;
    case 'hatch':
      for (const b of e.boundaries) for (const p of b) { p.x += dx; p.y += dy; }
      break;
    case 'blockref':
      e.insertPoint.x += dx; e.insertPoint.y += dy;
      break;
    case 'region':
      for (const p of e.outerBoundary) { p.x += dx; p.y += dy; }
      for (const hole of e.holes) for (const p of hole) { p.x += dx; p.y += dy; }
      break;
  }
}

function rebuildSpline(spline: PolylineEntity) {
  const fitPts = spline.fitPoints!;
  const src = spline.closed ? [...fitPts, fitPts[0]] : fitPts;
  const newPts = catmullRomSpline(src, 16);
  spline.points = newPts;
  spline.bulges = newPts.map(() => 0);
}

function doSplineEditMenu(engine: CommandEngine, spline: PolylineEntity) {
  engine.waitForInput('SPLINEDIT option:', (input) => {
    const lower = input.toLowerCase();
    if (lower === '' || lower === 'x') { engine.complete(); return true; }

    if (lower === 'm' || lower === 'move') {
      engine.prompt('Click near fit point to move:');
      engine.waitForClick((pt) => {
        const fitPts = spline.fitPoints!;
        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < fitPts.length; i++) {
          const d = dist(pt, fitPts[i]);
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        engine.prompt(`Moving fit point ${bestIdx + 1} at (${fitPts[bestIdx].x.toFixed(2)}, ${fitPts[bestIdx].y.toFixed(2)})`);
        engine.prompt('Specify new position:');
        engine.onMove((p) => {
          engine.renderer.rubberBand = { start: fitPts[bestIdx], end: p };
        });
        engine.waitForClick((newPos) => {
          store.pushUndo('SPLINEDIT');
          fitPts[bestIdx] = { ...newPos };
          rebuildSpline(spline);
          store.emit();
          engine.renderer.rubberBand = null;
          engine.prompt(`Fit point ${bestIdx + 1} moved to (${newPos.x.toFixed(2)}, ${newPos.y.toFixed(2)})`);
          doSplineEditMenu(engine, spline);
        });
      });
      return true;
    }

    if (lower === 'a' || lower === 'add') {
      engine.prompt('Click near segment to add a fit point:');
      engine.waitForClick((pt) => {
        store.pushUndo('SPLINEDIT');
        const fitPts = spline.fitPoints!;
        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < fitPts.length - 1; i++) {
          const mid = { x: (fitPts[i].x + fitPts[i + 1].x) / 2, y: (fitPts[i].y + fitPts[i + 1].y) / 2 };
          const d = dist(pt, mid);
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        fitPts.splice(bestIdx + 1, 0, { ...pt });
        rebuildSpline(spline);
        store.emit();
        engine.prompt(`Fit point added at index ${bestIdx + 2}. Now ${fitPts.length} points.`);
        doSplineEditMenu(engine, spline);
      });
      return true;
    }

    if (lower === 'd' || lower === 'delete') {
      if (spline.fitPoints!.length <= 2) {
        engine.prompt('Cannot delete — minimum 2 fit points required');
        doSplineEditMenu(engine, spline);
        return true;
      }
      engine.prompt('Click near fit point to delete:');
      engine.waitForClick((pt) => {
        store.pushUndo('SPLINEDIT');
        const fitPts = spline.fitPoints!;
        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < fitPts.length; i++) {
          const d = dist(pt, fitPts[i]);
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        const removed = fitPts.splice(bestIdx, 1)[0];
        rebuildSpline(spline);
        store.emit();
        engine.prompt(`Fit point ${bestIdx + 1} deleted at (${removed.x.toFixed(2)}, ${removed.y.toFixed(2)}). Now ${fitPts.length} points.`);
        doSplineEditMenu(engine, spline);
      });
      return true;
    }

    if (lower === 'c' || lower === 'close') {
      if (spline.closed) {
        engine.prompt('Spline is already closed');
      } else {
        store.pushUndo('SPLINEDIT');
        spline.closed = true;
        rebuildSpline(spline);
        store.emit();
        engine.prompt('Spline closed');
      }
      doSplineEditMenu(engine, spline);
      return true;
    }

    if (lower === 'o' || lower === 'open') {
      if (!spline.closed) {
        engine.prompt('Spline is already open');
      } else {
        store.pushUndo('SPLINEDIT');
        spline.closed = false;
        rebuildSpline(spline);
        store.emit();
        engine.prompt('Spline opened');
      }
      doSplineEditMenu(engine, spline);
      return true;
    }

    if (lower === 'r' || lower === 'refine') {
      store.pushUndo('SPLINEDIT');
      const fitPts = spline.fitPoints!;
      const newFit: Point[] = [fitPts[0]];
      for (let i = 0; i < fitPts.length - 1; i++) {
        newFit.push({ x: (fitPts[i].x + fitPts[i + 1].x) / 2, y: (fitPts[i].y + fitPts[i + 1].y) / 2 });
        newFit.push(fitPts[i + 1]);
      }
      spline.fitPoints = newFit;
      rebuildSpline(spline);
      store.emit();
      engine.prompt(`Refined: ${fitPts.length} → ${newFit.length} fit points`);
      doSplineEditMenu(engine, spline);
      return true;
    }

    engine.prompt('Unknown option. Use Move/Add/Delete/Close/Open/Refine.');
    doSplineEditMenu(engine, spline);
    return true;
  });
}

// === Local helper functions ===

function doCopyDisplacement(engine: CommandEngine, sel: Entity[], base: Point) {
  engine.prompt('Specify second point of displacement or <exit>:');
  engine.onMove((p) => {
    engine.renderer.rubberBand = { start: base, end: p };
  });
  engine.inputHandler = (input) => {
    if (input === '') {
      engine.renderer.rubberBand = null;
      store.clearSelection();
      engine.complete();
      return true;
    }
    const pt = engine.parseCoordinate(input);
    if (pt) { engine.handleClick(pt); return true; }
    return false;
  };
  engine.waitForClick((dest) => {
    const dx = dest.x - base.x, dy = dest.y - base.y;
    store.pushUndo('COPY');
    for (const e of sel) {
      const copy = JSON.parse(JSON.stringify(e));
      copy.id = nextId();
      copy.selected = false;
      moveEntity(copy, dx, dy);
      store.addEntity(copy);
    }
    engine.renderer.rubberBand = null;
    engine.prompt(`${sel.length} copied`);
    doCopyDisplacement(engine, sel, base);
  });
}

function doOffsetLoop(engine: CommandEngine, distance: number) {
  engine.prompt('Select object to offset or <exit>:');
  engine.inputHandler = (input) => {
    if (input === '') { engine.complete(); return true; }
    return false;
  };
  engine.waitForClick((pt) => {
    const tol = 10 / store.view.zoom;
    const entity = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
    if (!entity) { engine.prompt('No object found'); doOffsetLoop(engine, distance); return; }
    engine.prompt('Specify point on side to offset:');
    engine.inputHandler = null;
    engine.waitForClick((side) => {
      store.pushUndo('OFFSET');
      const offset = offsetEntity(entity, distance, side);
      if (offset) {
        store.addEntity(offset);
        engine.prompt('Offset created');
      } else {
        engine.prompt('Cannot offset this entity type');
      }
      doOffsetLoop(engine, distance);
    });
  });
}

function peditOptions(engine: CommandEngine, pline: PolylineEntity) {
  const closedLabel = pline.closed ? 'Open' : 'Close';
  engine.prompt(`Enter an option [${closedLabel}/Join/Width/Edit vertex/Fit/Spline/Decurve/Reverse/eXit] <X>:`);
  engine.inputHandler = (input) => {
    const lower = input.toLowerCase();
    if (lower === '' || lower === 'x' || lower === 'exit') {
      store.clearSelection();
      engine.complete();
      return true;
    }
    if (lower === 'c' || lower === 'close') {
      if (!pline.closed) {
        store.pushUndo('PEDIT Close');
        pline.closed = true;
        store.emit();
        engine.prompt('Polyline closed.');
      } else {
        engine.prompt('Polyline is already closed.');
      }
      peditOptions(engine, pline);
      return true;
    }
    if (lower === 'o' || lower === 'open') {
      if (pline.closed) {
        store.pushUndo('PEDIT Open');
        pline.closed = false;
        store.emit();
        engine.prompt('Polyline opened.');
      } else {
        engine.prompt('Polyline is already open.');
      }
      peditOptions(engine, pline);
      return true;
    }
    if (lower === 'j' || lower === 'join') {
      peditJoin(engine, pline);
      return true;
    }
    if (lower === 'w' || lower === 'width') {
      engine.prompt('Specify new width for all segments:');
      engine.waitForInput('Width:', (wInput) => {
        const w = parseFloat(wInput);
        if (!isNaN(w) && w >= 0) {
          store.pushUndo('PEDIT Width');
          (pline as any).width = w;
          store.emit();
          engine.prompt(`Width set to ${w}`);
        }
        peditOptions(engine, pline);
        return true;
      });
      return true;
    }
    if (lower === 'f' || lower === 'fit') {
      if (pline.points.length < 3) {
        engine.prompt('Need at least 3 vertices for fit curve');
        peditOptions(engine, pline);
        return true;
      }
      store.pushUndo('PEDIT Fit');
      const fitPts = pline.points;
      const result: Point[] = [];
      for (let i = 0; i < fitPts.length - 1; i++) {
        const p0 = fitPts[Math.max(0, i - 1)];
        const p1 = fitPts[i], p2 = fitPts[i + 1];
        const p3 = fitPts[Math.min(fitPts.length - 1, i + 2)];
        for (let s = 0; s <= 8; s++) {
          if (i > 0 && s === 0) continue;
          const t = s / 8, t2 = t * t, t3 = t2 * t;
          result.push({
            x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
            y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
          });
        }
      }
      pline.points = result;
      pline.bulges = result.map(() => 0);
      store.emit();
      engine.prompt('Fit curve applied');
      peditOptions(engine, pline);
      return true;
    }
    if (lower === 's' || lower === 'spline') {
      if (pline.points.length < 3) {
        engine.prompt('Need at least 3 vertices for spline');
        peditOptions(engine, pline);
        return true;
      }
      store.pushUndo('PEDIT Spline');
      const pts = pline.points;
      const extended = [pts[0], ...pts, pts[pts.length - 1]];
      const result: Point[] = [];
      for (let i = 1; i < extended.length - 2; i++) {
        const p0 = extended[i - 1], p1 = extended[i], p2 = extended[i + 1], p3 = extended[i + 2];
        for (let s = 0; s <= 16; s++) {
          if (i > 1 && s === 0) continue;
          const t = s / 16, t2 = t * t, t3 = t2 * t;
          result.push({
            x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
            y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
          });
        }
      }
      pline.points = result;
      pline.bulges = result.map(() => 0);
      store.emit();
      engine.prompt('Spline curve applied');
      peditOptions(engine, pline);
      return true;
    }
    if (lower === 'e' || lower === 'edit') {
      peditEditVertex(engine, pline, 0);
      return true;
    }
    if (lower === 'd' || lower === 'decurve') {
      store.pushUndo('PEDIT Decurve');
      pline.bulges = pline.points.map(() => 0);
      store.emit();
      engine.prompt('Curves removed');
      peditOptions(engine, pline);
      return true;
    }
    if (lower === 'r' || lower === 'reverse') {
      store.pushUndo('PEDIT Reverse');
      pline.points.reverse();
      pline.bulges.reverse();
      store.emit();
      engine.prompt('Vertex order reversed');
      peditOptions(engine, pline);
      return true;
    }
    engine.prompt(`Invalid option "${input}". [${closedLabel}/Join/Width/Edit vertex/Fit/Spline/Decurve/Reverse/eXit]:`);
    return true;
  };
}

function peditEditVertex(engine: CommandEngine, pline: PolylineEntity, idx: number) {
  const p = pline.points[idx];
  engine.prompt(`Vertex ${idx}: (${p.x.toFixed(4)}, ${p.y.toFixed(4)})`);
  engine.prompt('Enter option [Next/Previous/Move/Insert/Delete/eXit] <N>:');
  engine.inputHandler = (input) => {
    const lower = input.toLowerCase();
    if (lower === '' || lower === 'n' || lower === 'next') {
      const next = (idx + 1) % pline.points.length;
      peditEditVertex(engine, pline, next);
      return true;
    }
    if (lower === 'p' || lower === 'previous') {
      const prev = (idx - 1 + pline.points.length) % pline.points.length;
      peditEditVertex(engine, pline, prev);
      return true;
    }
    if (lower === 'm' || lower === 'move') {
      engine.prompt('Specify new location:');
      engine.waitForClick((pt) => {
        store.pushUndo('PEDIT Move vertex');
        pline.points[idx] = { ...pt };
        store.emit();
        engine.prompt('Vertex moved');
        peditEditVertex(engine, pline, idx);
      });
      return true;
    }
    if (lower === 'i' || lower === 'insert') {
      engine.prompt('Specify location of new vertex:');
      engine.waitForClick((pt) => {
        store.pushUndo('PEDIT Insert vertex');
        pline.points.splice(idx + 1, 0, { ...pt });
        pline.bulges.splice(idx + 1, 0, 0);
        store.emit();
        engine.prompt('Vertex inserted');
        peditEditVertex(engine, pline, idx + 1);
      });
      return true;
    }
    if (lower === 'd' || lower === 'delete') {
      if (pline.points.length <= 2) {
        engine.prompt('Cannot delete: minimum 2 vertices');
        peditEditVertex(engine, pline, idx);
        return true;
      }
      store.pushUndo('PEDIT');
      pline.points.splice(idx, 1);
      if (pline.bulges && pline.bulges.length > idx) {
        pline.bulges.splice(idx, 1);
      }
      if (idx > 0 && pline.bulges && pline.bulges.length > idx - 1) {
        pline.bulges[idx - 1] = 0;
      }
      store.emit();
      engine.prompt('Vertex deleted');
      const newIdx = idx >= pline.points.length ? pline.points.length - 1 : idx;
      peditEditVertex(engine, pline, newIdx);
      return true;
    }
    if (lower === 'x' || lower === 'exit') {
      peditOptions(engine, pline);
      return true;
    }
    engine.prompt('Invalid option. [Next/Previous/Move/Insert/Delete/eXit]:');
    return true;
  };
}

function peditJoin(engine: CommandEngine, pline: PolylineEntity) {
  engine.prompt('Select objects to join:');
  const joined: Entity[] = [];
  engine.inputHandler = (input) => {
    if (input === '') {
      if (joined.length === 0) {
        engine.prompt('0 segments added to polyline');
      } else {
        engine.prompt(`${joined.length} segment(s) joined to polyline`);
      }
      peditOptions(engine, pline);
      return true;
    }
    return false;
  };
  engine.waitForClick((pt) => {
    const tol = 10 / store.view.zoom;
    const entity = store.entities.find(e =>
      e.visible && e.id !== pline.id && (e.type === 'line' || e.type === 'polyline' || e.type === 'arc') &&
      pointOnEntity(pt, e, tol)
    );
    if (!entity) {
      engine.prompt('No joinable object found. Select more or Enter:');
      peditJoinContinue(engine, pline, joined);
      return;
    }
    store.pushUndo('PEDIT Join');
    if (joinToPline(pline, entity)) {
      store.removeEntity(entity.id);
      joined.push(entity);
      store.emit();
      engine.prompt(`Joined. Select more or Enter:`);
    } else {
      engine.prompt('Cannot join — endpoints do not match. Select more or Enter:');
    }
    peditJoinContinue(engine, pline, joined);
  });
}

function peditJoinContinue(engine: CommandEngine, pline: PolylineEntity, joined: Entity[]) {
  engine.inputHandler = (input) => {
    if (input === '') {
      engine.prompt(`${joined.length} segment(s) joined to polyline`);
      peditOptions(engine, pline);
      return true;
    }
    return false;
  };
  engine.waitForClick((pt) => {
    const tol = 10 / store.view.zoom;
    const entity = store.entities.find(e =>
      e.visible && e.id !== pline.id && (e.type === 'line' || e.type === 'polyline' || e.type === 'arc') &&
      pointOnEntity(pt, e, tol)
    );
    if (!entity) {
      engine.prompt('No joinable object found. Select more or Enter:');
      peditJoinContinue(engine, pline, joined);
      return;
    }
    store.pushUndo('PEDIT Join');
    if (joinToPline(pline, entity)) {
      store.removeEntity(entity.id);
      joined.push(entity);
      store.emit();
      engine.prompt(`Joined. Select more or Enter:`);
    } else {
      engine.prompt('Cannot join — endpoints do not match. Select more or Enter:');
    }
    peditJoinContinue(engine, pline, joined);
  });
}

function doRectArray(engine: CommandEngine, sel: Entity[]) {
  engine.prompt('Enter number of rows <1>:');
  engine.inputHandler = (rowInput) => {
    const rows = parseInt(rowInput) || 1;
    if (rows < 1) { engine.prompt('Must be >= 1'); return true; }
    engine.prompt('Enter number of columns <1>:');
    engine.inputHandler = (colInput) => {
      const cols = parseInt(colInput) || 1;
      if (cols < 1) { engine.prompt('Must be >= 1'); return true; }
      if (rows === 1 && cols === 1) { engine.prompt('Array requires more than 1 row or column'); engine.complete(); return true; }
      engine.prompt('Enter distance between rows:');
      engine.inputHandler = (rdInput) => {
        if (rdInput === '') { engine.complete(); return true; }
        const rowDist = parseFloat(rdInput);
        if (isNaN(rowDist)) { engine.prompt('Requires a number'); return true; }
        engine.prompt('Enter distance between columns:');
        engine.inputHandler = (cdInput) => {
          if (cdInput === '') { engine.complete(); return true; }
          const colDist = parseFloat(cdInput);
          if (isNaN(colDist)) { engine.prompt('Requires a number'); return true; }
          store.pushUndo('ARRAY');
          let count = 0;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (r === 0 && c === 0) continue;
              for (const e of sel) {
                const copy: Entity = JSON.parse(JSON.stringify(e));
                copy.id = nextId();
                copy.selected = false;
                moveEntity(copy, c * colDist, r * rowDist);
                store.addEntity(copy);
                count++;
              }
            }
          }
          store.emit();
          store.clearSelection();
          engine.prompt(`Rectangular array: ${count} object(s) created`);
          engine.complete();
          return true;
        };
        return true;
      };
      return true;
    };
    return true;
  };
}

function doPolarArray(engine: CommandEngine, sel: Entity[]) {
  engine.prompt('Specify center point of array:');
  engine.waitForClick((center) => {
    engine.prompt('Enter number of items <4>:');
    engine.inputHandler = (nInput) => {
      const numItems = parseInt(nInput) || 4;
      if (numItems < 2) { engine.prompt('Must be >= 2'); return true; }
      engine.prompt('Specify angle to fill <360>:');
      engine.inputHandler = (aInput) => {
        const fillAngle = parseFloat(aInput) || 360;
        engine.prompt('Rotate objects as they are copied? [Yes/No] <Y>:');
        engine.inputHandler = (rInput) => {
          const rotate = !rInput.toLowerCase().startsWith('n');
          store.pushUndo('ARRAY');
          let count = 0;
          const angleStep = (fillAngle / numItems) * Math.PI / 180;
          for (let i = 1; i < numItems; i++) {
            const ang = angleStep * i;
            for (const e of sel) {
              const copy: Entity = JSON.parse(JSON.stringify(e));
              copy.id = nextId();
              copy.selected = false;
              rotateEntity(copy, center, ang);
              store.addEntity(copy);
              count++;
            }
          }
          store.emit();
          store.clearSelection();
          engine.prompt(`Polar array: ${count} object(s) created`);
          engine.complete();
          return true;
        };
        return true;
      };
      return true;
    };
  });
}

function doLengthen(engine: CommandEngine, mode: string, value: number) {
  engine.prompt('Select object to lengthen (near the end to change):');
  engine.inputHandler = (input) => {
    if (input === '') { engine.complete(); return true; }
    return false;
  };
  engine.waitForClick((pt) => {
    const tol = 10 / store.view.zoom;
    const entity = store.entities.find(e => e.visible && pointOnEntity(pt, e, tol));
    if (!entity) { engine.prompt('No object found'); doLengthen(engine, mode, value); return; }

    if (entity.type === 'line') {
      const line = entity as LineEntity;
      const len = dist(line.start, line.end);
      let newLen: number;
      if (mode === 'delta') newLen = len + value;
      else if (mode === 'percent') newLen = len * value / 100;
      else newLen = value;
      if (newLen <= 0) { engine.prompt('Result would be zero or negative length'); doLengthen(engine, mode, value); return; }

      store.pushUndo('LENGTHEN');
      const nearStart = dist(pt, line.start) < dist(pt, line.end);
      const dx = line.end.x - line.start.x, dy = line.end.y - line.start.y;
      const dir = Math.atan2(dy, dx);
      if (nearStart) {
        line.start = { x: line.end.x - newLen * Math.cos(dir), y: line.end.y - newLen * Math.sin(dir) };
      } else {
        line.end = { x: line.start.x + newLen * Math.cos(dir), y: line.start.y + newLen * Math.sin(dir) };
      }
      store.emit();
      engine.prompt(`Length changed to ${newLen.toFixed(4)}`);
    } else if (entity.type === 'arc') {
      const arc = entity as ArcEntity;
      const arcLen = arc.radius * Math.abs(arc.endAngle - arc.startAngle);
      let newLen: number;
      if (mode === 'delta') newLen = arcLen + value;
      else if (mode === 'percent') newLen = arcLen * value / 100;
      else newLen = value;
      if (newLen <= 0) { engine.prompt('Result would be zero or negative length'); doLengthen(engine, mode, value); return; }

      store.pushUndo('LENGTHEN');
      const newAngleSpan = newLen / arc.radius;
      const startPt = { x: arc.center.x + arc.radius * Math.cos(arc.startAngle), y: arc.center.y + arc.radius * Math.sin(arc.startAngle) };
      const endPt = { x: arc.center.x + arc.radius * Math.cos(arc.endAngle), y: arc.center.y + arc.radius * Math.sin(arc.endAngle) };
      const nearStart = dist(pt, startPt) < dist(pt, endPt);
      if (nearStart) {
        arc.startAngle = arc.endAngle - newAngleSpan;
      } else {
        arc.endAngle = arc.startAngle + newAngleSpan;
      }
      store.emit();
      engine.prompt(`Arc length changed to ${newLen.toFixed(4)}`);
    } else {
      engine.prompt('Can only lengthen lines and arcs');
    }
    doLengthen(engine, mode, value);
  });
}

function doDrawOrder(engine: CommandEngine, sel: Entity[], option: string) {
  const lower = option.toLowerCase();
  if (lower === 'front' || lower === 'f') {
    store.pushUndo('DRAWORDER');
    const ids = new Set(sel.map(e => e.id));
    const rest = store.entities.filter(e => !ids.has(e.id));
    const moved = store.entities.filter(e => ids.has(e.id));
    store.entities = [...rest, ...moved];
    store.emit();
    engine.prompt(`${sel.length} moved to front`);
    engine.complete();
  } else if (lower === 'back' || lower === 'b') {
    store.pushUndo('DRAWORDER');
    const ids = new Set(sel.map(e => e.id));
    const rest = store.entities.filter(e => !ids.has(e.id));
    const moved = store.entities.filter(e => ids.has(e.id));
    store.entities = [...moved, ...rest];
    store.emit();
    engine.prompt(`${sel.length} moved to back`);
    engine.complete();
  } else if (lower === 'above' || lower === 'a') {
    engine.prompt('Select reference object:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      let ref: Entity | null = null;
      for (const e of store.entities) {
        if (pointOnEntity(pt, e, tol)) { ref = e; break; }
      }
      if (!ref) { engine.prompt('No object found at that point'); engine.complete(); return; }
      store.pushUndo('DRAWORDER');
      const ids = new Set(sel.map(e => e.id));
      const filtered = store.entities.filter(e => !ids.has(e.id));
      const moved = store.entities.filter(e => ids.has(e.id));
      const refIdx = filtered.findIndex(e => e.id === ref!.id);
      filtered.splice(refIdx + 1, 0, ...moved);
      store.entities = filtered;
      store.emit();
      engine.prompt(`${sel.length} placed above "${ref.type}"`);
      engine.complete();
    });
  } else if (lower === 'under' || lower === 'u') {
    engine.prompt('Select reference object:');
    engine.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      let ref: Entity | null = null;
      for (const e of store.entities) {
        if (pointOnEntity(pt, e, tol)) { ref = e; break; }
      }
      if (!ref) { engine.prompt('No object found at that point'); engine.complete(); return; }
      store.pushUndo('DRAWORDER');
      const ids = new Set(sel.map(e => e.id));
      const filtered = store.entities.filter(e => !ids.has(e.id));
      const moved = store.entities.filter(e => ids.has(e.id));
      const refIdx = filtered.findIndex(e => e.id === ref!.id);
      filtered.splice(refIdx, 0, ...moved);
      store.entities = filtered;
      store.emit();
      engine.prompt(`${sel.length} placed under "${ref.type}"`);
      engine.complete();
    });
  } else {
    engine.prompt('Invalid option. Use Front/Back/Above/Under.');
    engine.complete();
  }
}

function doChprop(engine: CommandEngine, sel: Entity[]) {
  engine.prompt(`CHPROP ${sel.length} object(s). Enter property [Color/LAyer/LType/LWeight] or Enter to exit:`);
  engine.waitForInput('Property:', (input) => {
    if (input === '') { store.clearSelection(); engine.complete(); return true; }
    const prop = input.toUpperCase();
    if (prop === 'COLOR' || prop === 'C' || prop === 'COL') {
      engine.prompt('Enter new color (bylayer, byblock, 1-7, or #rrggbb):');
      engine.waitForInput('New color:', (val) => {
        if (!val.trim()) { doChprop(engine, sel); return true; }
        store.pushUndo('CHPROP');
        for (const e of sel) e.color = val.trim();
        store.emit();
        engine.prompt(`Color of ${sel.length} object(s) set to "${val.trim()}"`);
        doChprop(engine, sel);
        return true;
      });
      return true;
    }
    if (prop === 'LAYER' || prop === 'LA') {
      const names = store.layers.map(l => l.name).join(', ');
      engine.prompt(`Available layers: ${names}`);
      engine.prompt('Enter new layer:');
      engine.waitForInput('New layer:', (val) => {
        if (!val.trim()) { doChprop(engine, sel); return true; }
        const layer = store.layers.find(l => l.name.toUpperCase() === val.toUpperCase());
        if (!layer) { engine.prompt('Layer not found: ' + val); doChprop(engine, sel); return true; }
        store.pushUndo('CHPROP');
        for (const e of sel) e.layer = layer.name;
        store.emit();
        engine.prompt(`Layer of ${sel.length} object(s) set to "${layer.name}"`);
        doChprop(engine, sel);
        return true;
      });
      return true;
    }
    if (prop === 'LTYPE' || prop === 'LT') {
      engine.prompt('Enter new linetype (continuous, dashed, hidden, center, dashdot, phantom, dot, border, divide):');
      engine.waitForInput('New linetype:', (val) => {
        if (!val.trim()) { doChprop(engine, sel); return true; }
        store.pushUndo('CHPROP');
        for (const e of sel) e.linetype = val.trim().toLowerCase();
        store.emit();
        engine.prompt(`Linetype of ${sel.length} object(s) set to "${val.trim().toLowerCase()}"`);
        doChprop(engine, sel);
        return true;
      });
      return true;
    }
    if (prop === 'LWEIGHT' || prop === 'LW') {
      engine.prompt('Enter new lineweight:');
      engine.waitForInput('New lineweight:', (val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0) { engine.prompt('Invalid lineweight'); doChprop(engine, sel); return true; }
        store.pushUndo('CHPROP');
        for (const e of sel) e.lineweight = n;
        store.emit();
        engine.prompt(`Lineweight of ${sel.length} object(s) set to ${n}`);
        doChprop(engine, sel);
        return true;
      });
      return true;
    }
    engine.prompt('Unknown property. Use Color/LAyer/LType/LWeight.');
    doChprop(engine, sel);
    return true;
  });
}

function textToPolylines(text: string, pos: Point, height: number, rotation: number): Point[][] {
  const letterSpacing = height * 0.7;
  const rad = rotation * Math.PI / 180;
  const cosR = Math.cos(rad), sinR = Math.sin(rad);

  function transform(lx: number, ly: number): Point {
    return {
      x: pos.x + lx * cosR - ly * sinR,
      y: pos.y + lx * sinR + ly * cosR,
    };
  }

  const glyphs: Record<string, number[][][]> = {
    'A': [[[0,0],[.3,1],[.6,0]],[[.12,.4],[.48,.4]]],
    'B': [[[0,0],[0,1],[.4,1],[.5,.9],[.5,.8],[.4,.7],[.5,.6],[.5,.55],[.45,.5],[0,.5]],[[0,0],[.4,0],[.5,.1],[.5,.2],[.4,.3],[.5,.4],[.5,.45],[.45,.5]]],
    'C': [[[.5,.2],[.4,0],[.1,0],[0,.2],[0,.8],[.1,1],[.4,1],[.5,.8]]],
    'D': [[[0,0],[0,1],[.3,1],[.5,.8],[.5,.2],[.3,0],[0,0]]],
    'E': [[[.5,0],[0,0],[0,1],[.5,1]],[[0,.5],[.4,.5]]],
    'F': [[[0,0],[0,1],[.5,1]],[[0,.5],[.4,.5]]],
    'G': [[[.5,.8],[.4,1],[.1,1],[0,.8],[0,.2],[.1,0],[.4,0],[.5,.2],[.5,.5],[.3,.5]]],
    'H': [[[0,0],[0,1]],[[.5,0],[.5,1]],[[0,.5],[.5,.5]]],
    'I': [[[.1,0],[.4,0]],[[.1,1],[.4,1]],[[.25,0],[.25,1]]],
    'J': [[[0,.2],[.1,0],[.3,0],[.4,.2],[.4,1]]],
    'K': [[[0,0],[0,1]],[[.5,1],[0,.5],[.5,0]]],
    'L': [[[0,1],[0,0],[.5,0]]],
    'M': [[[0,0],[0,1],[.3,.5],[.6,1],[.6,0]]],
    'N': [[[0,0],[0,1],[.5,0],[.5,1]]],
    'O': [[[.1,0],[0,.2],[0,.8],[.1,1],[.4,1],[.5,.8],[.5,.2],[.4,0],[.1,0]]],
    'P': [[[0,0],[0,1],[.4,1],[.5,.9],[.5,.6],[.4,.5],[0,.5]]],
    'Q': [[[.1,0],[0,.2],[0,.8],[.1,1],[.4,1],[.5,.8],[.5,.2],[.4,0],[.1,0]],[[.35,.15],[.55,-.05]]],
    'R': [[[0,0],[0,1],[.4,1],[.5,.9],[.5,.6],[.4,.5],[0,.5]],[[.3,.5],[.5,0]]],
    'S': [[[.5,.8],[.4,1],[.1,1],[0,.8],[0,.6],[.1,.5],[.4,.5],[.5,.4],[.5,.2],[.4,0],[.1,0],[0,.2]]],
    'T': [[[0,1],[.6,1]],[[.3,0],[.3,1]]],
    'U': [[[0,1],[0,.2],[.1,0],[.4,0],[.5,.2],[.5,1]]],
    'V': [[[0,1],[.3,0],[.6,1]]],
    'W': [[[0,1],[.15,0],[.3,.5],[.45,0],[.6,1]]],
    'X': [[[0,0],[.5,1]],[[0,1],[.5,0]]],
    'Y': [[[0,1],[.25,.5],[.5,1]],[[.25,0],[.25,.5]]],
    'Z': [[[0,1],[.5,1],[0,0],[.5,0]]],
    '0': [[[.1,0],[0,.2],[0,.8],[.1,1],[.4,1],[.5,.8],[.5,.2],[.4,0],[.1,0]],[[.1,.2],[.4,.8]]],
    '1': [[[.15,.8],[.3,1],[.3,0]],[[.1,0],[.5,0]]],
    '2': [[[0,.8],[.1,1],[.4,1],[.5,.8],[.5,.6],[0,0],[.5,0]]],
    '3': [[[0,.8],[.1,1],[.4,1],[.5,.8],[.5,.6],[.4,.5],[.2,.5]],[[.4,.5],[.5,.4],[.5,.2],[.4,0],[.1,0],[0,.2]]],
    '4': [[[0,1],[0,.4],[.5,.4]],[[.4,1],[.4,0]]],
    '5': [[[.5,1],[0,1],[0,.5],[.4,.5],[.5,.4],[.5,.2],[.4,0],[.1,0],[0,.1]]],
    '6': [[[.5,.8],[.4,1],[.1,1],[0,.8],[0,.2],[.1,0],[.4,0],[.5,.2],[.5,.4],[.4,.5],[.1,.5],[0,.4]]],
    '7': [[[0,1],[.5,1],[.2,0]]],
    '8': [[[.1,.5],[0,.6],[0,.8],[.1,1],[.4,1],[.5,.8],[.5,.6],[.4,.5],[.1,.5],[0,.4],[0,.2],[.1,0],[.4,0],[.5,.2],[.5,.4],[.4,.5]]],
    '9': [[[0,.2],[.1,0],[.4,0],[.5,.2],[.5,.8],[.4,1],[.1,1],[0,.8],[0,.6],[.1,.5],[.4,.5],[.5,.6]]],
    '-': [[[.1,.5],[.4,.5]]],
    '.': [[[.2,0],[.2,.08],[.3,.08],[.3,0],[.2,0]]],
    ',': [[[.2,.1],[.2,0],[.15,-.1]]],
    ' ': [],
    ':': [[[.2,.2],[.2,.28],[.3,.28],[.3,.2],[.2,.2]],[[.2,.6],[.2,.68],[.3,.68],[.3,.6],[.2,.6]]],
    ';': [[[.2,.6],[.2,.68],[.3,.68],[.3,.6],[.2,.6]],[[.2,.2],[.2,.1],[.15,0]]],
    '!': [[[.25,.3],[.25,1]],[[.25,0],[.25,.08],[.25,0]]],
    '?': [[[0,.8],[.1,1],[.4,1],[.5,.8],[.5,.6],[.25,.4]],[[.25,.15],[.25,.08]]],
    '/': [[[0,0],[.5,1]]],
    '(': [[[.4,0],[.2,.2],[.2,.8],[.4,1]]],
    ')': [[[.1,0],[.3,.2],[.3,.8],[.1,1]]],
    '+': [[[.05,.5],[.45,.5]],[[.25,.3],[.25,.7]]],
    '=': [[[.05,.35],[.45,.35]],[[.05,.65],[.45,.65]]],
    '#': [[[.15,0],[.15,1]],[[.35,0],[.35,1]],[[.05,.35],[.45,.35]],[[.05,.65],[.45,.65]]],
    '@': [[[.4,.3],[.3,.3],[.2,.4],[.2,.6],[.3,.7],[.4,.6],[.4,.3],[.5,.2],[.4,0],[.1,0],[0,.2],[0,.8],[.1,1],[.4,1],[.5,.8]]],
    '"': [[[.15,.8],[.15,1]],[[.35,.8],[.35,1]]],
    '\'': [[[.25,.8],[.25,1]]],
    '_': [[[0,0],[.5,0]]],
    '*': [[[.25,.35],[.25,.65]],[[.1,.4],[.4,.6]],[[.1,.6],[.4,.4]]],
  };

  const allPaths: Point[][] = [];
  let cursorX = 0;

  for (const ch of text.toUpperCase()) {
    const strokes = glyphs[ch] || glyphs['?'] || [];
    for (const stroke of strokes) {
      const path: Point[] = stroke.map(([sx, sy]) =>
        transform(cursorX + sx * height, sy * height)
      );
      if (path.length > 0) allPaths.push(path);
    }
    const glyphWidth = (glyphs[ch] || []).length > 0 ? 0.6 : 0.3;
    cursorX += glyphWidth * height + letterSpacing * 0.3;
  }

  return allPaths;
}
