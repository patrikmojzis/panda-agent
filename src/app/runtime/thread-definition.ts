import type {LlmContext} from "../../kernel/agent/llm-context.js";
import {Agent} from "../../kernel/agent/agent.js";
import {mergeInferenceProjection} from "../../kernel/transcript/inference-projection.js";
import type {AgentStore} from "../../domain/agents/index.js";
import type {InferenceProjection, ResolvedThreadDefinition, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {buildPandaLlmContexts, type PandaLlmContextSection,} from "../../personas/panda/contexts/builder.js";
import {buildPandaTools} from "../../personas/panda/definition.js";
import {PANDA_PROMPT} from "../../personas/panda/prompt.js";
import type {PandaSessionContext} from "../../personas/panda/types.js";
import type {BashToolOptions} from "../../personas/panda/tools/bash-tool.js";
import type {BrowserToolOptions} from "../../personas/panda/tools/browser-tool.js";
import {resolveRemoteInitialCwd} from "../../integrations/shell/bash-executor.js";
import type {Tool} from "../../kernel/agent/tool.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_PANDA_INFERENCE_PROJECTION: InferenceProjection = {
  dropToolCalls: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 13,
  },
  dropThinking: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 13,
  },
  dropImages: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 13,
  },
  dropMessages: {
    olderThanMs: 1 * DAY_MS,
  },
};

export interface CreatePandaThreadDefinitionOptions {
  thread: ThreadRecord;
  fallbackContext: Pick<PandaSessionContext, "cwd" | "identityId" | "identityHandle">;
  agentStore?: AgentStore;
  threadStore?: Pick<ThreadRuntimeStore, "listBashJobs">;
  bashToolOptions?: BashToolOptions;
  browserToolOptions?: BrowserToolOptions;
  extraTools?: readonly Tool[];
  extraLlmContexts?: readonly LlmContext[];
  llmContextSections?: readonly PandaLlmContextSection[];
  extraContext?: Omit<
    PandaSessionContext,
    "cwd" | "timezone" | "identityId" | "identityHandle" | "threadId" | "agentKey" | "subagentDepth"
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStoredShellCwd(value: Record<string, unknown>): boolean {
  const shell = value.shell;
  return isRecord(shell) && typeof shell.cwd === "string" && shell.cwd.trim().length > 0;
}

export function resolveStoredPandaContext(
  value: ThreadRecord["context"],
  fallback: Pick<PandaSessionContext, "cwd" | "identityId" | "identityHandle">,
  agentKey?: string,
): PandaSessionContext {
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

  return {
    cwd: useRemoteInitialCwd && remoteInitialCwd ? remoteInitialCwd : storedCwd ?? fallback.cwd,
    timezone: typeof context.timezone === "string" ? context.timezone : undefined,
    identityId: typeof context.identityId === "string" ? context.identityId : fallback.identityId,
    identityHandle: typeof context.identityHandle === "string" ? context.identityHandle : fallback.identityHandle,
  };
}

export function createPandaThreadDefinition(
  options: CreatePandaThreadDefinitionOptions,
): ResolvedThreadDefinition {
  const context: PandaSessionContext = {
    ...resolveStoredPandaContext(options.thread.context, options.fallbackContext, options.thread.agentKey),
    threadId: options.thread.id,
    agentKey: options.thread.agentKey,
    identityId: options.fallbackContext.identityId,
    identityHandle: options.fallbackContext.identityHandle,
    subagentDepth: 0,
    ...options.extraContext,
  };
  const resolvedIdentityId = context.identityId ?? options.fallbackContext.identityId;
  if (!resolvedIdentityId) {
    throw new Error(`Missing identityId for thread ${options.thread.id}.`);
  }

  const llmContexts: LlmContext[] = buildPandaLlmContexts({
    context,
    agentStore: options.agentStore,
    threadStore: options.threadStore,
    agentKey: options.thread.agentKey,
    identityId: resolvedIdentityId,
    threadId: options.thread.id,
    sections: options.llmContextSections,
    extraLlmContexts: options.extraLlmContexts,
  });

  return {
    agent: new Agent({
      name: options.thread.agentKey,
      instructions: PANDA_PROMPT,
      tools: buildPandaTools(options.extraTools, {
        bash: options.bashToolOptions,
        browser: options.browserToolOptions,
      }),
    }),
    context,
    llmContexts,
    inferenceProjection: mergeInferenceProjection(
      DEFAULT_PANDA_INFERENCE_PROJECTION,
      options.thread.inferenceProjection,
    ),
  };
}
