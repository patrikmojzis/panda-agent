import type {Tool} from "../../kernel/agent/tool.js";
import {BashTool, type BashToolOptions} from "./tools/bash-tool.js";
import {BashJobCancelTool, BashJobStatusTool, BashJobWaitTool,} from "./tools/bash-job-tools.js";
import {BraveSearchTool, hasBraveSearchApiKey} from "./tools/brave-search-tool.js";
import {BrowserTool, type BrowserToolOptions} from "./tools/browser-tool.js";
import {MediaTool} from "./tools/media-tool.js";
import {WebFetchTool} from "./tools/web-fetch-tool.js";
import {WebResearchTool} from "./tools/web-research-tool.js";
import {hasOpenAiApiKey, WhisperTool} from "./tools/whisper-tool.js";

export interface BuildPandaToolsOptions {
  bash?: BashToolOptions;
  browser?: BrowserToolOptions;
}

export function buildPandaTools(
  extraTools: ReadonlyArray<Tool> = [],
  options: BuildPandaToolsOptions = {},
): ReadonlyArray<Tool> {
  // Keep provider-specific web search self-contained until Panda actually needs a bigger abstraction.
  const openAiTools = hasOpenAiApiKey() ? [new WebResearchTool(), new WhisperTool()] : [];
  const braveTools = hasBraveSearchApiKey() ? [new BraveSearchTool()] : [];
  const bashJobTools = options.bash?.jobService
    ? [
      new BashJobStatusTool({
        service: options.bash.jobService,
      }),
      new BashJobWaitTool({
        service: options.bash.jobService,
      }),
      new BashJobCancelTool({
        service: options.bash.jobService,
      }),
    ]
    : [];
  return [
    new BashTool(options.bash),
    ...bashJobTools,
    new MediaTool(),
    new WebFetchTool(),
    new BrowserTool(options.browser),
    ...openAiTools,
    ...braveTools,
    ...extraTools,
  ];
}
