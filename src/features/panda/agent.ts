import type {Tool} from "../agent-core/tool.js";
import {BashTool} from "./tools/bash-tool.js";
import {BraveSearchTool, hasBraveSearchApiKey} from "./tools/brave-search-tool.js";
import {MediaTool} from "./tools/media-tool.js";
import {hasOpenAiApiKey, WhisperTool} from "./tools/whisper-tool.js";

export function buildPandaTools(extraTools: ReadonlyArray<Tool> = []): ReadonlyArray<Tool> {
  // Keep provider-specific web search self-contained until Panda actually needs a bigger abstraction.
  const whisperTools = hasOpenAiApiKey() ? [new WhisperTool()] : [];
  const braveTools = hasBraveSearchApiKey() ? [new BraveSearchTool()] : [];
  return [new BashTool(), new MediaTool(), ...whisperTools, ...braveTools, ...extraTools];
}
