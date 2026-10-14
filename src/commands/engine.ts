import { Point, Entity, SnapMode } from '../types';
import { store } from '../store';
import { polarPoint } from '../geometry';
import { pointOnEntity } from '../geometry';
import { Renderer } from '../renderer';

export type PromptCallback = (msg: string) => void;
export type InputCallback = (prompt: string, handler: (input: string) => boolean) => void;

export interface CommandDef {
  name: string;
  aliases: string[];
  execute: () => void;
}

export class CommandEngine {
  commands: Map<string, CommandDef> = new Map();
  renderer: Renderer;
  promptFn: PromptCallback;
  inputFn: InputCallback;

  activeCommand: string | null = null;
  clickHandler: ((pt: Point) => void) | null = null;
  inputHandler: ((input: string) => boolean) | null = null;
  cancelHandler: (() => void) | null = null;
  moveHandler: ((pt: Point) => void) | null = null;

  tempPoints: Point[] = [];
  tempEntities: Entity[] = [];

  constructor(renderer: Renderer, promptFn: PromptCallback, inputFn: InputCallback) {
    this.renderer = renderer;
    this.promptFn = promptFn;
    this.inputFn = inputFn;
  }

  get isActive(): boolean { return this.activeCommand !== null; }

  prompt(msg: string) { this.promptFn(msg); }

  waitForClick(handler: (pt: Point) => void) { this.clickHandler = handler; }
  waitForInput(prompt: string, handler: (input: string) => boolean) {
    this.inputHandler = handler;
    this.inputFn(prompt, handler);
  }
  onMove(handler: (pt: Point) => void) { this.moveHandler = handler; }
  onCancel(handler: () => void) { this.cancelHandler = handler; }

  handleClick(worldPt: Point) {
    store.snapOverride = null;
    if (this.clickHandler) {
      store.lastPoint = { x: worldPt.x, y: worldPt.y };
      this.clickHandler(worldPt);
    } else if (!this.activeCommand) {
      this.pickSelect(worldPt);
    }
  }

  handleMove(worldPt: Point) {
    if (this.moveHandler) this.moveHandler(worldPt);
  }

  handleInput(raw: string): boolean {
    const input = raw.trim();

    if (this.inputHandler) {
      const handled = this.inputHandler(input);
      if (handled) return true;
    }

    if (!input) {
      if (this.activeCommand) return true;
      if (store.lastCommand) {
        const cmd = this.commands.get(store.lastCommand);
        if (cmd) {
          this.activeCommand = cmd.name;
          cmd.execute();
          return true;
        }
      }
      return false;
    }

    // Snap overrides
    const snapMap: Record<string, SnapMode> = {
      end: 'endpoint', mid: 'midpoint', cen: 'center', int: 'intersection',
      per: 'perpendicular', tan: 'tangent', qua: 'quadrant', nea: 'nearest',
    };
    const lower = input.toLowerCase();
    if (snapMap[lower]) {
      store.snapOverride = snapMap[lower];
      this.prompt(`Snap override: ${snapMap[lower]}`);
      return true;
    }

    // Coordinate input during click-wait
    if (this.clickHandler) {
      const pt = this.parseCoordinate(input);
      if (pt) {
        store.lastPoint = { x: pt.x, y: pt.y };
        this.clickHandler(pt);
        return true;
      }
    }

    // Command lookup
    const cmd = this.commands.get(input.toUpperCase());
    if (cmd) {
      this.cancel();
      this.activeCommand = cmd.name;
      store.lastCommand = cmd.name;
      cmd.execute();
      return true;
    }

    // Try alias
    for (const [, def] of this.commands) {
      if (def.aliases.some(a => a === input.toUpperCase())) {
        this.cancel();
        this.activeCommand = def.name;
        store.lastCommand = def.name;
        def.execute();
        return true;
      }
    }

    this.prompt(`Unknown command: ${input}`);
    return true;
  }

  cancel() {
    if (this.cancelHandler) this.cancelHandler();
    this.activeCommand = null;
    this.clickHandler = null;
    this.inputHandler = null;
    this.cancelHandler = null;
    this.moveHandler = null;
    this.tempPoints = [];
    this.tempEntities = [];
    this.renderer.rubberBand = null;
    this.renderer.rubberCircle = null;
    this.renderer.rubberArc = null;
    this.renderer.rubberRect = null;
    this.renderer.rubberPolyline = null;
    this.renderer.rubberEllipse = null;
    this.renderer.selectionBox = null;
    store.snapOverride = null;
    store.tool = 'idle';
  }

  getLastPoint(): Point {
    if (this.tempPoints.length > 0) return this.tempPoints[this.tempPoints.length - 1];
    return store.lastPoint;
  }

  parseCoordinate(input: string): Point | null {
    const NUM = '-?(?:\\d+\\.?\\d*|\\.\\d+)';
    const absRe = new RegExp(`^(${NUM})\\s*,\\s*(${NUM})$`);
    const relRe = new RegExp(`^@(${NUM})\\s*,\\s*(${NUM})$`);
    const polarRe = new RegExp(`^@(${NUM})\\s*<\\s*(${NUM})$`);
    const absPolarRe = new RegExp(`^(${NUM})\\s*<\\s*(${NUM})$`);

    // Absolute coords are in UCS space → convert to WCS
    const abs = input.match(absRe);
    if (abs) {
      const ucsP = { x: parseFloat(abs[1]), y: parseFloat(abs[2]) };
      return store.ucsToWcs(ucsP);
    }

    // Relative coords: UCS-aligned displacement from last WCS point
    const rel = input.match(relRe);
    if (rel) {
      const last = this.getLastPoint();
      const dx = parseFloat(rel[1]);
      const dy = parseFloat(rel[2]);
      const ucsRad = store.ucsAngle * Math.PI / 180;
      const cos = Math.cos(ucsRad), sin = Math.sin(ucsRad);
      return {
        x: last.x + dx * cos - dy * sin,
        y: last.y + dx * sin + dy * cos,
      };
    }

    // Relative polar: angle measured from UCS X axis
    const polar = input.match(polarRe);
    if (polar) {
      const last = this.getLastPoint();
      const d = parseFloat(polar[1]);
      const a = (parseFloat(polar[2]) + store.ucsAngle) * Math.PI / 180;
      return polarPoint(last, d, a);
    }

    // Absolute polar: from UCS origin, angle from UCS X axis
    const absPolar = input.match(absPolarRe);
    if (absPolar) {
      const d = parseFloat(absPolar[1]);
      const a = (parseFloat(absPolar[2]) + store.ucsAngle) * Math.PI / 180;
      return polarPoint(store.ucsOrigin, d, a);
    }

    return null;
  }

  private pickSelect(worldPt: Point) {
    const tol = 10 / store.view.zoom;
    let hit = false;
    for (const e of store.entities) {
      if (pointOnEntity(worldPt, e, tol)) {
        e.selected = !e.selected;
        hit = true;
        break;
      }
    }
    if (!hit) store.clearSelection();
    store.emit();
  }

  complete() {
    this.activeCommand = null;
    this.clickHandler = null;
    this.inputHandler = null;
    this.cancelHandler = null;
    this.moveHandler = null;
    this.tempPoints = [];
    this.renderer.rubberBand = null;
    this.renderer.rubberCircle = null;
    this.renderer.rubberArc = null;
    this.renderer.rubberRect = null;
    this.renderer.rubberPolyline = null;
    this.renderer.rubberEllipse = null;
    store.tool = 'idle';
  }

  register(name: string, aliases: string[], execute: () => void) {
    const def: CommandDef = { name, aliases, execute };
    this.commands.set(name, def);
  }

  getCommands(): string[] {
    const result: string[] = [];
    for (const [name, def] of this.commands) {
      result.push(`${name} (${def.aliases.join(', ')})`);
    }
    return result.sort();
  }

  requireSelection(callback: (selected: Entity[]) => void) {
    const sel = store.selectedEntities();
    if (sel.length > 0) { callback(sel); return; }
    this.doSelectionLoop(callback);
  }

  private doSelectionLoop(callback: (selected: Entity[]) => void) {
    this.prompt('Select objects:');
    this.inputHandler = (input) => {
      if (input === '') {
        const sel = store.selectedEntities();
        if (sel.length > 0) { callback(sel); }
        else { this.prompt('No objects selected'); this.complete(); }
        return true;
      }
      return false;
    };
    this.waitForClick((pt) => {
      const tol = 10 / store.view.zoom;
      for (const e of store.entities) {
        if (pointOnEntity(pt, e, tol)) { e.selected = true; break; }
      }
      store.emit();
      this.prompt(`${store.selectedEntities().length} found. Select objects or press Enter:`);
      this.doSelectionLoop(callback);
    });
  }
}
