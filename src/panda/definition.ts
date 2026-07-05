import type {Tool} from "../kernel/agent/tool.js";
import {BashTool, type BashToolOptions} from "./tools/bash-tool.js";
import {
    BackgroundJobCancelTool,
    BackgroundJobStatusTool,
    BackgroundJobWaitTool,
} from "./tools/background-job-tools.js";
import {BrowserTool, type BrowserToolOptions} from "./tools/browser-tool.js";
import {MediaTool} from "./tools/media-tool.js";
import {ThinkingSetTool, type ThinkingSetToolOptions} from "./tools/thinking-set-tool.js";

export interface BuildDefaultAgentToolsOptions {
  bash?: BashToolOptions;
  browser?: BrowserToolOptions;
  thinking?: ThinkingSetToolOptions;
}

// `worker` remains only as a legacy in-process toolset key for non-runtime policy tests.
// Durable V2 subagents are profile/tool-group driven and must not use this toolset.
export type DefaultAgentToolsetKey = "main" | "workspace" | "memory" | "browser" | "worker" | "skill_maintainer";

export interface DefaultAgentToolRegistry {
  bash: BashTool;
  backgroundJobStatus?: BackgroundJobStatusTool;
  backgroundJobWait?: BackgroundJobWaitTool;
  backgroundJobCancel?: BackgroundJobCancelTool;
  media: MediaTool;
  browser: BrowserTool;
  thinking: ThinkingSetTool;
}

export interface DefaultAgentToolsets {
  main: readonly Tool[];
  workspace: readonly Tool[];
  memory: readonly Tool[];
  browser: readonly Tool[];
  worker: readonly Tool[];
  skill_maintainer: readonly Tool[];
}

function compactTools(tools: ReadonlyArray<Tool | undefined>): readonly Tool[] {
  return tools.filter((tool): tool is Tool => tool !== undefined);
}

export function buildCoreAgentToolsFromRegistry(
  registry: DefaultAgentToolRegistry,
): readonly Tool[] {
  return compactTools([
    registry.bash,
    registry.backgroundJobStatus,
    registry.backgroundJobWait,
    registry.backgroundJobCancel,
    registry.media,
    registry.thinking,
  ]);
}

export function createDefaultAgentToolRegistry(
  options: BuildDefaultAgentToolsOptions = {},
): DefaultAgentToolRegistry {
  const jobService = options.bash?.jobService;
  const bashOptions = jobService ? {...options.bash, jobService} : options.bash;
  const registry: DefaultAgentToolRegistry = {
    bash: new BashTool(bashOptions),
    media: new MediaTool(),
    browser: new BrowserTool(options.browser),
    thinking: new ThinkingSetTool(options.thinking),
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

  return registry;
}

export function buildDefaultAgentToolsetsFromRegistry(
  registry: DefaultAgentToolRegistry,
  mainExtras: ReadonlyArray<Tool> = [],
  memoryExtras: ReadonlyArray<Tool> = [],
  skillMaintainerExtras: ReadonlyArray<Tool> = [],
  workerExtras: ReadonlyArray<Tool> = [],
): DefaultAgentToolsets {
  return {
    main: compactTools([
      ...buildCoreAgentToolsFromRegistry(registry),
      ...mainExtras,
    ]),
    workspace: compactTools([
      registry.media,
    ]),
    memory: compactTools(memoryExtras),
    browser: compactTools([
      registry.media,
      registry.browser,
    ]),
    worker: compactTools([
      registry.bash,
      registry.backgroundJobStatus,
      registry.backgroundJobWait,
      registry.backgroundJobCancel,
      registry.media,
      registry.browser,
      registry.thinking,
      ...workerExtras,
    ]),
    skill_maintainer: compactTools([
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
