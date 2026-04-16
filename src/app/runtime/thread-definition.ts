import type {LlmContext} from "../../kernel/agent/llm-context.js";
import {Agent} from "../../kernel/agent/agent.js";
import {mergeInferenceProjection} from "../../kernel/transcript/inference-projection.js";
import type {AgentStore} from "../../domain/agents/index.js";
import type {SessionRecord} from "../../domain/sessions/index.js";
import type {InferenceProjection, ResolvedThreadDefinition, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {buildPandaLlmContexts, type PandaLlmContextSection,} from "../../panda/contexts/builder.js";
import {buildPandaTools} from "../../panda/definition.js";
import {PANDA_PROMPT} from "../../panda/prompt.js";
import type {PandaSessionContext} from "./panda-session-context.js";
import type {BashToolOptions} from "../../panda/tools/bash-tool.js";
import type {BrowserToolOptions} from "../../panda/tools/browser-tool.js";
import {resolveRemoteInitialCwd} from "../../integrations/shell/bash-executor.js";
import {mapHostAgentPathToRunner} from "../../integrations/shell/path-mapping.js";
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
  session: Pick<SessionRecord, "id" | "agentKey">;
  fallbackContext: Pick<PandaSessionContext, "cwd">;
  agentStore?: AgentStore;
  threadStore?: Pick<ThreadRuntimeStore, "listBashJobs">;
  bashToolOptions?: BashToolOptions;
  browserToolOptions?: BrowserToolOptions;
  tools?: readonly Tool[];
  extraLlmContexts?: readonly LlmContext[];
  llmContextSections?: readonly PandaLlmContextSection[];
  extraContext?: Omit<
    PandaSessionContext,
    "cwd" | "threadId" | "sessionId" | "agentKey" | "subagentDepth"
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
  fallback: Pick<PandaSessionContext, "cwd">,
  agentKey?: string,
): Pick<PandaSessionContext, "cwd"> {
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

export function createPandaThreadDefinition(
  options: CreatePandaThreadDefinitionOptions,
): ResolvedThreadDefinition {
  const {session} = options;
  const context: PandaSessionContext = {
    ...resolveStoredPandaContext(options.thread.context, options.fallbackContext, session.agentKey),
    threadId: options.thread.id,
    sessionId: session.id,
    agentKey: session.agentKey,
    subagentDepth: 0,
    ...options.extraContext,
  };

  const llmContexts: LlmContext[] = buildPandaLlmContexts({
    context,
    agentStore: options.agentStore,
    threadStore: options.threadStore,
    agentKey: session.agentKey,
    threadId: options.thread.id,
    sections: options.llmContextSections,
    extraLlmContexts: options.extraLlmContexts,
  });

  return {
    agent: new Agent({
      name: session.agentKey,
      instructions: PANDA_PROMPT,
      tools: options.tools ?? buildPandaTools([], {
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
