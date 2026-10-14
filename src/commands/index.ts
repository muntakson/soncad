import { CommandEngine } from './engine';
import { registerDrawCommands } from './draw';
import { registerModifyCommands } from './modify';
import { registerTrimExtendCommands } from './trim-extend';
import { registerDimensionCommands } from './dimension';
import { registerViewCommands, zoomExtents } from './view';
import { registerSettingsCommands } from './settings';
import { registerInquiryCommands } from './inquiry';
import { registerPropertiesCommands } from './properties';
import { registerOutputCommands } from './output';
import { Renderer } from '../renderer';
import type { PromptCallback, InputCallback } from './engine';

export { CommandEngine, zoomExtents };
export type { PromptCallback, InputCallback };

export function createCommandEngine(
  renderer: Renderer,
  promptFn: PromptCallback,
  inputFn: InputCallback,
): CommandEngine {
  const engine = new CommandEngine(renderer, promptFn, inputFn);
  registerDrawCommands(engine);
  registerModifyCommands(engine);
  registerTrimExtendCommands(engine);
  registerDimensionCommands(engine);
  registerViewCommands(engine);
  registerSettingsCommands(engine);
  registerInquiryCommands(engine);
  registerPropertiesCommands(engine);
  registerOutputCommands(engine);
  return engine;
}
