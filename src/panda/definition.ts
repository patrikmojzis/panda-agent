import type {Tool} from "../kernel/agent/tool.js";
import {BashTool, type BashToolOptions} from "./tools/bash-tool.js";
import {
    BackgroundJobCancelTool,
    BackgroundJobStatusTool,
    BackgroundJobWaitTool,
} from "./tools/background-job-tools.js";
import {BraveSearchTool, hasBraveSearchApiKey} from "./tools/brave-search-tool.js";
import {BrowserTool, type BrowserToolOptions} from "./tools/browser-tool.js";
import {MediaTool} from "./tools/media-tool.js";
import {
    PostgresReadonlyQueryTool,
    type PostgresReadonlyQueryToolOptions,
} from "./tools/postgres-readonly-query-tool.js";
import {CurrentDateTimeTool} from "./tools/current-datetime-tool.js";
import {ImageGenerateTool, type ImageGenerateToolOptions} from "./tools/image-generate-tool.js";
import {TelepathyScreenshotTool, type TelepathyScreenshotToolOptions,} from "./tools/telepathy-screenshot-tool.js";
import {WebFetchTool} from "./tools/web-fetch-tool.js";
import {WebResearchTool, type WebResearchToolOptions} from "./tools/web-research-tool.js";
import {hasOpenAiApiKey, WhisperTool} from "./tools/whisper-tool.js";
import {GlobFilesTool, GrepFilesTool, ReadFileTool} from "./tools/workspace-readonly-tools.js";

export interface BuildDefaultAgentToolsOptions {
  bash?: BashToolOptions;
  browser?: BrowserToolOptions;
  imageGenerate?: ImageGenerateToolOptions;
  postgresReadonly?: PostgresReadonlyQueryToolOptions;
  telepathy?: TelepathyScreenshotToolOptions;
  webResearch?: WebResearchToolOptions;
}

export type DefaultAgentToolsetKey = "main" | "workspace" | "memory" | "browser" | "skill_maintainer";

export interface DefaultAgentToolRegistry {
  bash: BashTool;
  backgroundJobStatus?: BackgroundJobStatusTool;
  backgroundJobWait?: BackgroundJobWaitTool;
  backgroundJobCancel?: BackgroundJobCancelTool;
  currentDateTime: CurrentDateTimeTool;
  readFile: ReadFileTool;
  globFiles: GlobFilesTool;
  grepFiles: GrepFilesTool;
  imageGenerate?: ImageGenerateTool;
  media: MediaTool;
  telepathy?: TelepathyScreenshotTool;
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
  skill_maintainer: readonly Tool[];
}

function compactTools(tools: ReadonlyArray<Tool | undefined>): readonly Tool[] {
  return tools.filter((tool): tool is Tool => tool !== undefined);
}

export function createDefaultAgentToolRegistry(
  options: BuildDefaultAgentToolsOptions = {},
): DefaultAgentToolRegistry {
  const jobService = options.bash?.jobService ?? options.imageGenerate?.jobService ?? options.webResearch?.jobService;
  const bashOptions = jobService ? {...options.bash, jobService} : options.bash;
  const registry: DefaultAgentToolRegistry = {
    bash: new BashTool(bashOptions),
    currentDateTime: new CurrentDateTimeTool(),
    readFile: new ReadFileTool(),
    globFiles: new GlobFilesTool(),
    grepFiles: new GrepFilesTool(),
    media: new MediaTool(),
    ...(jobService
      ? {
        imageGenerate: new ImageGenerateTool({
          ...options.imageGenerate,
          jobService,
        }),
      }
      : {}),
    ...(options.telepathy
      ? {
        telepathy: new TelepathyScreenshotTool(options.telepathy),
      }
      : {}),
    webFetch: new WebFetchTool(),
    browser: new BrowserTool(options.browser),
  };

  if (jobService) {
    registry.backgroundJobStatus = new BackgroundJobStatusTool({
      service: jobService,
    });
    registry.backgroundJobWait = new BackgroundJobWaitTool({
      service: jobService,
    });
    registry.backgroundJobCancel = new BackgroundJobCancelTool({
      service: jobService,
    });
  }

  if (hasOpenAiApiKey()) {
    if (jobService) {
      registry.webResearch = new WebResearchTool({
        ...options.webResearch,
        jobService,
      });
    }
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
  memoryExtras: ReadonlyArray<Tool> = [],
  skillMaintainerExtras: ReadonlyArray<Tool> = [],
): DefaultAgentToolsets {
  return {
    main: compactTools([
      registry.bash,
      registry.backgroundJobStatus,
      registry.backgroundJobWait,
      registry.backgroundJobCancel,
      registry.currentDateTime,
      registry.media,
      registry.imageGenerate,
      registry.telepathy,
      registry.webFetch,
      registry.postgresReadonlyQuery,
      registry.webResearch,
      registry.whisper,
      registry.braveSearch,
      ...mainExtras,
    ]),
    workspace: compactTools([
      registry.currentDateTime,
      registry.readFile,
      registry.globFiles,
      registry.grepFiles,
      registry.media,
    ]),
    memory: compactTools([
      registry.currentDateTime,
      registry.postgresReadonlyQuery,
      ...memoryExtras,
    ]),
    browser: compactTools([
      registry.currentDateTime,
      registry.readFile,
      registry.globFiles,
      registry.grepFiles,
      registry.media,
      registry.browser,
    ]),
    skill_maintainer: compactTools([
      registry.currentDateTime,
      registry.postgresReadonlyQuery,
      registry.readFile,
      registry.globFiles,
      registry.grepFiles,
      registry.media,
      ...skillMaintainerExtras,
    ]),
  };
}

export function buildDefaultAgentTools(
  extraTools: ReadonlyArray<Tool> = [],
  options: BuildDefaultAgentToolsOptions = {},
): ReadonlyArray<Tool> {
  return buildDefaultAgentToolsetsFromRegistry(
    createDefaultAgentToolRegistry(options),
    extraTools,
  ).main;
}
