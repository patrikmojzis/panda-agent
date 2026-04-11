import type {Tool} from "../../kernel/agent/tool.js";
import {BashTool, type BashToolOptions} from "./tools/bash-tool.js";
import {BraveSearchTool, hasBraveSearchApiKey} from "./tools/brave-search-tool.js";
import {MediaTool} from "./tools/media-tool.js";
import {WebFetchTool} from "./tools/web-fetch-tool.js";
import {WebResearchTool} from "./tools/web-research-tool.js";
import {hasOpenAiApiKey, WhisperTool} from "./tools/whisper-tool.js";

export interface BuildPandaToolsOptions {
  bash?: BashToolOptions;
}

export function buildPandaTools(
  extraTools: ReadonlyArray<Tool> = [],
  options: BuildPandaToolsOptions = {},
): ReadonlyArray<Tool> {
  // Keep provider-specific web search self-contained until Panda actually needs a bigger abstraction.
  const openAiTools = hasOpenAiApiKey() ? [new WebResearchTool(), new WhisperTool()] : [];
  const braveTools = hasBraveSearchApiKey() ? [new BraveSearchTool()] : [];
  return [new BashTool(options.bash), new MediaTool(), new WebFetchTool(), ...openAiTools, ...braveTools, ...extraTools];
}
