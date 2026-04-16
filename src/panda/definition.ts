import type {Tool} from "../kernel/agent/tool.js";
import {BashTool, type BashToolOptions} from "./tools/bash-tool.js";
import {BashJobCancelTool, BashJobStatusTool, BashJobWaitTool,} from "./tools/bash-job-tools.js";
import {BraveSearchTool, hasBraveSearchApiKey} from "./tools/brave-search-tool.js";
import {BrowserTool, type BrowserToolOptions} from "./tools/browser-tool.js";
import {MediaTool} from "./tools/media-tool.js";
import {
    PostgresReadonlyQueryTool,
    type PostgresReadonlyQueryToolOptions,
} from "./tools/postgres-readonly-query-tool.js";
import {WebFetchTool} from "./tools/web-fetch-tool.js";
import {WebResearchTool} from "./tools/web-research-tool.js";
import {hasOpenAiApiKey, WhisperTool} from "./tools/whisper-tool.js";
import {GlobFilesTool, GrepFilesTool, ReadFileTool} from "./tools/workspace-readonly-tools.js";

export interface BuildDefaultAgentToolsOptions {
  bash?: BashToolOptions;
  browser?: BrowserToolOptions;
  postgresReadonly?: PostgresReadonlyQueryToolOptions;
}

export interface BuildDefaultAgentToolsetsOptions extends BuildDefaultAgentToolsOptions {
  mainExtras?: ReadonlyArray<Tool>;
}

export type DefaultAgentToolsetKey = "main" | "workspace" | "memory" | "browser";

export interface DefaultAgentToolRegistry {
  bash: BashTool;
  bashJobStatus?: BashJobStatusTool;
  bashJobWait?: BashJobWaitTool;
  bashJobCancel?: BashJobCancelTool;
  readFile: ReadFileTool;
  globFiles: GlobFilesTool;
  grepFiles: GrepFilesTool;
  media: MediaTool;
  webFetch: WebFetchTool;
  browser: BrowserTool;
  braveSearch?: BraveSearchTool;
  webResearch?: WebResearchTool;
  whisper?: WhisperTool;
  postgresReadonlyQuery?: PostgresReadonlyQueryTool;
}

export interface DefaultAgentToolsets {
  main: readonly Tool[];
  workspace: readonly Tool[];
  memory: readonly Tool[];
  browser: readonly Tool[];
}

function compactTools(tools: ReadonlyArray<Tool | undefined>): readonly Tool[] {
  return tools.filter((tool): tool is Tool => tool !== undefined);
}

export function createDefaultAgentToolRegistry(
  options: BuildDefaultAgentToolsOptions = {},
): DefaultAgentToolRegistry {
  const registry: DefaultAgentToolRegistry = {
    bash: new BashTool(options.bash),
    readFile: new ReadFileTool(),
    globFiles: new GlobFilesTool(),
    grepFiles: new GrepFilesTool(),
    media: new MediaTool(),
    webFetch: new WebFetchTool(),
    browser: new BrowserTool(options.browser),
  };

  if (options.bash?.jobService) {
    registry.bashJobStatus = new BashJobStatusTool({
      service: options.bash.jobService,
    });
    registry.bashJobWait = new BashJobWaitTool({
      service: options.bash.jobService,
    });
    registry.bashJobCancel = new BashJobCancelTool({
      service: options.bash.jobService,
    });
  }

  if (hasOpenAiApiKey()) {
    registry.webResearch = new WebResearchTool();
    registry.whisper = new WhisperTool();
  }

  if (hasBraveSearchApiKey()) {
    registry.braveSearch = new BraveSearchTool();
  }

  if (options.postgresReadonly) {
    registry.postgresReadonlyQuery = new PostgresReadonlyQueryTool(options.postgresReadonly);
  }

  return registry;
}

export function buildDefaultAgentToolsetsFromRegistry(
  registry: DefaultAgentToolRegistry,
  mainExtras: ReadonlyArray<Tool> = [],
): DefaultAgentToolsets {
  return {
    main: compactTools([
      registry.bash,
      registry.bashJobStatus,
      registry.bashJobWait,
      registry.bashJobCancel,
      registry.media,
      registry.webFetch,
      registry.postgresReadonlyQuery,
      registry.webResearch,
      registry.whisper,
      registry.braveSearch,
      ...mainExtras,
    ]),
    workspace: compactTools([
      registry.readFile,
      registry.globFiles,
      registry.grepFiles,
      registry.media,
    ]),
    memory: compactTools([
      registry.postgresReadonlyQuery,
    ]),
    browser: compactTools([
      registry.readFile,
      registry.globFiles,
      registry.grepFiles,
      registry.media,
      registry.browser,
    ]),
  };
}

export function buildDefaultAgentToolsets(
  options: BuildDefaultAgentToolsetsOptions = {},
): DefaultAgentToolsets {
  const {mainExtras = [], ...toolOptions} = options;
  return buildDefaultAgentToolsetsFromRegistry(createDefaultAgentToolRegistry(toolOptions), mainExtras);
}

export function buildDefaultAgentTools(
  extraTools: ReadonlyArray<Tool> = [],
  options: BuildDefaultAgentToolsOptions = {},
): ReadonlyArray<Tool> {
  return buildDefaultAgentToolsets({
    ...options,
    mainExtras: extraTools,
  }).main;
}
