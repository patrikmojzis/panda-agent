import type {LlmContext} from "../../kernel/agent/llm-context.js";
import {Agent} from "../../kernel/agent/agent.js";
import {mergeInferenceProjection} from "../../kernel/transcript/inference-projection.js";
import type {AgentStore} from "../../domain/agents/index.js";
import type {SessionRecord} from "../../domain/sessions/index.js";
import type {InferenceProjection, ResolvedThreadDefinition, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {buildDefaultAgentLlmContexts, type DefaultAgentLlmContextSection,} from "../../panda/contexts/builder.js";
import {buildDefaultAgentTools} from "../../panda/definition.js";
import {DEFAULT_AGENT_INSTRUCTIONS} from "../../panda/prompt.js";
import type {DefaultAgentSessionContext} from "./panda-session-context.js";
import type {BashToolOptions} from "../../panda/tools/bash-tool.js";
import type {BrowserToolOptions} from "../../panda/tools/browser-tool.js";
import type {TelepathyScreenshotToolOptions} from "../../panda/tools/telepathy-screenshot-tool.js";
import {resolveRemoteInitialCwd} from "../../integrations/shell/bash-executor.js";
import {mapHostAgentPathToRunner} from "../../integrations/shell/path-mapping.js";
import type {Tool} from "../../kernel/agent/tool.js";
import type {WikiBindingService} from "../../domain/wiki/index.js";
import {isRecord} from "../../lib/records.js";
import {resolveThreadPromptCacheKey} from "../../domain/threads/runtime/prompt-cache-key.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_INFERENCE_PROJECTION: InferenceProjection = {
  dropToolCalls: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 14,
  },
  dropThinking: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 14,
  },
  dropImages: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 14,
  },
  dropMessages: {
    olderThanMs: 2 * DAY_MS,
  },
};

export interface CreateThreadDefinitionOptions {
  thread: ThreadRecord;
  session: Pick<SessionRecord, "id" | "agentKey">;
  fallbackContext: Pick<DefaultAgentSessionContext, "cwd">;
  agentStore?: AgentStore;
  threadStore?: Pick<ThreadRuntimeStore, "listBashJobs">;
  wikiBindings?: Pick<WikiBindingService, "getBinding">;
  bashToolOptions?: BashToolOptions;
  browserToolOptions?: BrowserToolOptions;
  telepathyToolOptions?: TelepathyScreenshotToolOptions;
  tools?: readonly Tool[];
  extraLlmContexts?: readonly LlmContext[];
  llmContextSections?: readonly DefaultAgentLlmContextSection[];
  extraContext?: Omit<
    DefaultAgentSessionContext,
    "cwd" | "threadId" | "sessionId" | "agentKey" | "subagentDepth"
  >;
}

function hasStoredShellCwd(value: Record<string, unknown>): boolean {
  const shell = value.shell;
  return isRecord(shell) && typeof shell.cwd === "string" && shell.cwd.trim().length > 0;
}

export function resolveStoredContext(
  value: ThreadRecord["context"],
  fallback: Pick<DefaultAgentSessionContext, "cwd">,
  agentKey?: string,
): Pick<DefaultAgentSessionContext, "cwd"> {
  const remoteInitialCwd = agentKey ? resolveRemoteInitialCwd(agentKey) : null;
  if (!isRecord(value)) {
    return {
      ...fallback,
      ...(remoteInitialCwd ? {cwd: remoteInitialCwd} : {}),
    };
  }

  const context = value;
  const storedCwd = typeof context.cwd === "string" && context.cwd.trim().length > 0
    ? context.cwd
    : null;
  const useRemoteInitialCwd = Boolean(
    remoteInitialCwd
    && !hasStoredShellCwd(context)
    && (!storedCwd || storedCwd === fallback.cwd),
  );
  const selectedCwd = useRemoteInitialCwd && remoteInitialCwd ? remoteInitialCwd : storedCwd ?? fallback.cwd;

  return {
    cwd: selectedCwd && agentKey ? mapHostAgentPathToRunner(selectedCwd, agentKey) : selectedCwd,
  };
}

export function createThreadDefinition(
  options: CreateThreadDefinitionOptions,
): ResolvedThreadDefinition {
  const {session} = options;
  const context: DefaultAgentSessionContext = {
    ...resolveStoredContext(options.thread.context, options.fallbackContext, session.agentKey),
    threadId: options.thread.id,
    sessionId: session.id,
    agentKey: session.agentKey,
    subagentDepth: 0,
    ...options.extraContext,
  };

  const llmContexts: LlmContext[] = buildDefaultAgentLlmContexts({
    context,
    agentStore: options.agentStore,
    threadStore: options.threadStore,
    wikiBindings: options.wikiBindings,
    agentKey: session.agentKey,
    threadId: options.thread.id,
    sections: options.llmContextSections,
    extraLlmContexts: options.extraLlmContexts,
  });

  return {
    agent: new Agent({
      name: session.agentKey,
      instructions: DEFAULT_AGENT_INSTRUCTIONS,
      tools: options.tools ?? buildDefaultAgentTools([], {
        bash: options.bashToolOptions,
        browser: options.browserToolOptions,
        telepathy: options.telepathyToolOptions,
      }),
    }),
    context,
    llmContexts,
    promptCacheKey: resolveThreadPromptCacheKey(options.thread.id, options.thread.promptCacheKey),
    inferenceProjection: mergeInferenceProjection(
      DEFAULT_INFERENCE_PROJECTION,
      options.thread.inferenceProjection,
    ),
  };
}
