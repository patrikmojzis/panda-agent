import type {LlmContext} from "../../kernel/agent/llm-context.js";
import {Agent} from "../../kernel/agent/agent.js";
import {mergeInferenceProjection} from "../../kernel/transcript/inference-projection.js";
import type {AgentStore} from "../../domain/agents/index.js";
import type {ScheduledTaskStore} from "../../domain/scheduling/tasks/index.js";
import type {
  ExecutionEnvironmentStore,
  ResolvedExecutionEnvironment
} from "../../domain/execution-environments/index.js";
import type {AgentSessionKind, SessionRecord, SessionStore} from "../../domain/sessions/index.js";
import type {InferenceProjection, ResolvedThreadDefinition, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {buildDefaultAgentLlmContexts, type DefaultAgentLlmContextSection,} from "../../panda/contexts/builder.js";
import {buildDefaultAgentTools} from "../../panda/definition.js";
import {DEFAULT_AGENT_INSTRUCTIONS} from "../../panda/prompt.js";
import {DEFAULT_WORKER_INSTRUCTIONS} from "../../prompts/runtime/worker.js";
import {WorkerRuntimeContext} from "../../panda/contexts/worker-runtime-context.js";
import {
  DEFAULT_WORKER_ALLOWED_TOOL_NAMES,
  POSTGRES_READONLY_TOOL_NAME,
  WORKER_CONTROL_TOOL_NAMES,
} from "../../panda/tools/worker-tool-policy.js";
import type {DefaultAgentSessionContext} from "./panda-session-context.js";
import type {BashToolOptions} from "../../panda/tools/bash-tool.js";
import type {BrowserToolOptions} from "../../panda/tools/browser-tool.js";
import type {ImageGenerateToolOptions} from "../../panda/tools/image-generate-tool.js";
import type {TelepathyScreenshotToolOptions} from "../../panda/tools/telepathy-screenshot-tool.js";
import {resolveRemoteInitialCwd} from "../../integrations/shell/bash-executor.js";
import {mapHostAgentPathToRunner} from "../../integrations/shell/path-mapping.js";
import type {Tool} from "../../kernel/agent/tool.js";
import type {WikiBindingService} from "../../domain/wiki/index.js";
import type {AgentCalendarService} from "../../integrations/calendar/types.js";
import {isRecord} from "../../lib/records.js";
import {resolveThreadPromptCacheKey} from "../../domain/threads/runtime/prompt-cache-key.js";
import type {JsonValue} from "../../kernel/agent/types.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const WORKER_LLM_CONTEXT_SECTIONS: readonly DefaultAgentLlmContextSection[] = [
  "environment",
  "background_jobs",
  "skills",
];

export const DEFAULT_INFERENCE_PROJECTION: InferenceProjection = {
  dropToolCalls: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 20,
  },
  dropThinking: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 10,
  },
  dropImages: {
    olderThanMs: 8 * HOUR_MS,
    preserveRecentUserTurns: 20,
  },
  dropMessages: {
    olderThanMs: 2 * DAY_MS,
  },
};

export interface CreateThreadDefinitionOptions {
  thread: ThreadRecord;
  session: Pick<SessionRecord, "id" | "agentKey"> & {kind?: AgentSessionKind};
  fallbackContext: Pick<DefaultAgentSessionContext, "cwd">;
  agentStore?: AgentStore;
  sessionStore?: Pick<SessionStore, "listAgentSessions">;
  threadStore?: Pick<ThreadRuntimeStore, "listToolJobs">;
  scheduledTasks?: Pick<ScheduledTaskStore, "listActiveTasks">;
  executionEnvironments?: Pick<ExecutionEnvironmentStore, "getDefaultBinding" | "getEnvironment">;
  wikiBindings?: Pick<WikiBindingService, "getBinding">;
  calendarService?: AgentCalendarService | null;
  bashToolOptions?: BashToolOptions;
  browserToolOptions?: BrowserToolOptions;
  imageGenerateToolOptions?: ImageGenerateToolOptions;
  telepathyToolOptions?: TelepathyScreenshotToolOptions;
  executionEnvironment?: ResolvedExecutionEnvironment;
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

function readStoredWorkerContext(value: ThreadRecord["context"]): JsonValue | undefined {
  if (!isRecord(value) || value.worker === undefined) {
    return undefined;
  }

  return value.worker as JsonValue;
}

function isWorkerSession(session: Pick<SessionRecord, "id" | "agentKey"> & {kind?: AgentSessionKind}): boolean {
  return session.kind === "worker";
}

function resolveLlmContextSections(
  session: Pick<SessionRecord, "id" | "agentKey"> & {kind?: AgentSessionKind},
  sections: readonly DefaultAgentLlmContextSection[] | undefined,
): readonly DefaultAgentLlmContextSection[] | undefined {
  if (!isWorkerSession(session)) {
    return sections;
  }

  const allowed = new Set(WORKER_LLM_CONTEXT_SECTIONS);
  const requested = sections?.length ? sections : WORKER_LLM_CONTEXT_SECTIONS;
  return requested.filter((section) => allowed.has(section));
}

function resolveWorkerAllowedToolNames(executionEnvironment?: ResolvedExecutionEnvironment): Set<string> {
  const allowedTools = executionEnvironment?.toolPolicy.allowedTools?.length
    ? executionEnvironment.toolPolicy.allowedTools
    : DEFAULT_WORKER_ALLOWED_TOOL_NAMES;
  return new Set(allowedTools);
}

function isWorkerToolAllowed(toolName: string, executionEnvironment?: ResolvedExecutionEnvironment): boolean {
  if (WORKER_CONTROL_TOOL_NAMES.has(toolName)) {
    return false;
  }

  const policy = executionEnvironment?.toolPolicy;
  if (toolName === "bash" && policy?.bash?.allowed === false) {
    return false;
  }
  if (toolName === POSTGRES_READONLY_TOOL_NAME && policy?.postgresReadonly?.allowed !== true) {
    return false;
  }

  return resolveWorkerAllowedToolNames(executionEnvironment).has(toolName);
}

function resolveSessionTools(
  tools: readonly Tool[] | undefined,
  options: Pick<CreateThreadDefinitionOptions, "bashToolOptions" | "browserToolOptions" | "imageGenerateToolOptions" | "telepathyToolOptions" | "executionEnvironment" | "session">,
): readonly Tool[] {
  const baseTools = tools ?? buildDefaultAgentTools([], {
    bash: options.bashToolOptions,
    browser: options.browserToolOptions,
    imageGenerate: options.imageGenerateToolOptions,
    telepathy: options.telepathyToolOptions,
  });

  if (!isWorkerSession(options.session)) {
    return baseTools;
  }

  return baseTools.filter((tool) => isWorkerToolAllowed(tool.name, options.executionEnvironment));
}

export function resolveStoredContext(
  value: ThreadRecord["context"],
  fallback: Pick<DefaultAgentSessionContext, "cwd">,
  agentKey?: string,
  executionEnvironment?: ResolvedExecutionEnvironment,
): Pick<DefaultAgentSessionContext, "cwd"> {
  const remoteInitialCwd = executionEnvironment?.initialCwd ?? (agentKey ? resolveRemoteInitialCwd(agentKey) : null);
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
  const shouldMapHostAgentPath = Boolean(
    agentKey
    && (
      !executionEnvironment
      || executionEnvironment.source === "fallback"
      || executionEnvironment.kind === "persistent_agent_runner"
    ),
  );

  return {
    cwd: selectedCwd && shouldMapHostAgentPath && agentKey
      ? mapHostAgentPathToRunner(selectedCwd, agentKey)
      : selectedCwd,
  };
}

export function createThreadDefinition(
  options: CreateThreadDefinitionOptions,
): ResolvedThreadDefinition {
  const {session} = options;
  const storedWorker = isWorkerSession(session)
    ? readStoredWorkerContext(options.thread.context)
    : undefined;
  const context: DefaultAgentSessionContext = {
    ...resolveStoredContext(options.thread.context, options.fallbackContext, session.agentKey, options.executionEnvironment),
    threadId: options.thread.id,
    sessionId: session.id,
    agentKey: session.agentKey,
    subagentDepth: 0,
    ...(options.executionEnvironment ? {executionEnvironment: options.executionEnvironment} : {}),
    ...(storedWorker !== undefined ? {worker: storedWorker} : {}),
    ...options.extraContext,
  };

  const llmContexts: LlmContext[] = buildDefaultAgentLlmContexts({
    context,
    agentStore: options.agentStore,
    sessionStore: options.sessionStore,
    threadStore: options.threadStore,
    scheduledTasks: options.scheduledTasks,
    executionEnvironments: options.executionEnvironments,
    wikiBindings: options.wikiBindings,
    calendarService: options.calendarService,
    agentKey: session.agentKey,
    threadId: options.thread.id,
    sections: resolveLlmContextSections(session, options.llmContextSections),
    skillPolicy: options.executionEnvironment?.skillPolicy,
    extraLlmContexts: options.extraLlmContexts,
  });
  if (isWorkerSession(session)) {
    llmContexts.unshift(new WorkerRuntimeContext({
      worker: context.worker,
      executionEnvironment: options.executionEnvironment,
    }));
  }
  const tools = resolveSessionTools(options.tools, options);

  return {
    agent: new Agent({
      name: session.agentKey,
      instructions: isWorkerSession(session) ? DEFAULT_WORKER_INSTRUCTIONS : DEFAULT_AGENT_INSTRUCTIONS,
      tools,
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
