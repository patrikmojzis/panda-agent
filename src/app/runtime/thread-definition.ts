import type {LlmContext} from "../../kernel/agent/llm-context.js";
import {Agent} from "../../kernel/agent/agent.js";
import {mergeInferenceProjection} from "../../kernel/transcript/inference-projection.js";
import type {ScheduledTaskStore} from "../../domain/scheduling/tasks/store.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/types.js";
import {isExecutionToolAllowedByPolicy} from "../../domain/execution-environments/policy.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {AgentSessionKind, SessionPromptRecord, SessionRecord, SessionRuntimeConfigRecord} from "../../domain/sessions/types.js";
import type {InferenceProjection, ResolvedThreadDefinition, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {buildDefaultAgentLlmContexts, type AgentProfileStore, type DefaultAgentLlmContextSection,} from "../../panda/contexts/builder.js";
import {buildDefaultAgentToolsetsFromRegistry, createDefaultAgentToolRegistry} from "../../panda/definition.js";
import {DEFAULT_AGENT_INSTRUCTIONS} from "../../prompts/runtime/default-agent.js";
import {SubagentRuntimeContext} from "../../panda/contexts/subagent-runtime-context.js";
import type {SubagentProfileStore} from "../../domain/subagents/store.js";
import type {DefaultAgentSessionContext} from "./panda-session-context.js";
import type {BashToolOptions} from "../../panda/tools/bash-tool.js";
import type {BrowserToolOptions} from "../../panda/tools/browser-tool.js";
import type {ImageGenerateToolOptions} from "../../panda/tools/image-generate-tool.js";
import {resolveRemoteInitialCwd} from "../../integrations/shell/bash-executor.js";
import {mapHostAgentPathToRunner} from "../../integrations/shell/path-mapping.js";
import type {Tool} from "../../kernel/agent/tool.js";
import type {WikiBindingService} from "../../domain/wiki/service.js";
import {resolveSessionPromptCacheKey, resolveThreadPromptCacheKey} from "../../domain/threads/runtime/prompt-cache-key.js";
import {readSubagentSessionMetadata, type SubagentSessionMetadata} from "../../domain/subagents/session-metadata.js";

const POSTGRES_READONLY_TOOL_NAME = "postgres_readonly_query";
const LEGACY_WORKER_SPAWN_TOOL_NAME = ["worker", "spawn"].join("_");
const SUBAGENT_LLM_CONTEXT_SECTIONS: readonly DefaultAgentLlmContextSection[] = [
  "environment",
  "bash_targets",
  "background_jobs",
  "skills",
  "todo_context",
];

export const DEFAULT_INFERENCE_PROJECTION: InferenceProjection = {
  dropToolCalls: {
    preserveRecentUserTurns: 20,
  },
  dropThinking: {
    preserveRecentUserTurns: 10,
  },
  dropImages: {
    preserveRecentUserTurns: 20,
  },
};

export interface CreateThreadDefinitionOptions {
  thread: ThreadRecord;
  session: Pick<SessionRecord, "id" | "agentKey" | "metadata"> & {kind?: AgentSessionKind};
  fallbackContext: Pick<DefaultAgentSessionContext, "cwd">;
  agentStore?: AgentProfileStore;
  sessionStore?: Pick<SessionStore, "listAgentSessions" | "readSessionTodo">;
  subagentProfiles?: Pick<SubagentProfileStore, "listProfiles">;
  threadStore?: Pick<ThreadRuntimeStore, "listToolJobs"> & Partial<Pick<ThreadRuntimeStore, "listThreadSummaries">>;
  scheduledTasks?: Pick<ScheduledTaskStore, "listActiveTasks">;
  executionEnvironments?: Pick<ExecutionEnvironmentStore, "getEnvironment" | "listBindingsForEnvironments" | "listDisposableEnvironmentsByOwner" | "listBindingsForSession">;
  wikiBindings?: Pick<WikiBindingService, "getBinding">;
  bashToolOptions?: BashToolOptions;
  browserToolOptions?: BrowserToolOptions;
  imageGenerateToolOptions?: ImageGenerateToolOptions;
  executionEnvironment?: ResolvedExecutionEnvironment;
  tools?: readonly Tool[];
  sessionPrompt?: SessionPromptRecord | null;
  runtimeConfig?: SessionRuntimeConfigRecord;
  extraLlmContexts?: readonly LlmContext[];
  llmContextSections?: readonly DefaultAgentLlmContextSection[];
  extraContext?: Omit<
    DefaultAgentSessionContext,
    "cwd" | "threadId" | "sessionId" | "agentKey" | "subagentDepth"
  >;
}

function isWorkerSession(session: Pick<SessionRecord, "id" | "agentKey" | "metadata"> & {kind?: AgentSessionKind}): boolean {
  return session.kind === "worker";
}

function isSubagentSession(session: Pick<SessionRecord, "id" | "agentKey" | "metadata"> & {kind?: AgentSessionKind}): boolean {
  return session.kind === "subagent";
}

function readRequiredSubagentMetadata(
  session: Pick<SessionRecord, "id" | "metadata">,
): SubagentSessionMetadata {
  const subagent = readSubagentSessionMetadata(session.metadata);
  if (!subagent) {
    throw new Error(`Subagent session ${session.id} is missing subagent metadata.`);
  }
  return subagent;
}

function resolveLlmContextSections(
  session: Pick<SessionRecord, "id" | "agentKey" | "metadata"> & {kind?: AgentSessionKind},
  sections: readonly DefaultAgentLlmContextSection[] | undefined,
): readonly DefaultAgentLlmContextSection[] | undefined {
  if (isSubagentSession(session)) {
    const allowed = new Set(SUBAGENT_LLM_CONTEXT_SECTIONS);
    const requested = sections?.length ? sections : SUBAGENT_LLM_CONTEXT_SECTIONS;
    return requested.filter((section) => allowed.has(section));
  }

  return sections;
}

function isSubagentToolAllowed(toolName: string, executionEnvironment?: ResolvedExecutionEnvironment): boolean {
  if (toolName === LEGACY_WORKER_SPAWN_TOOL_NAME || toolName === "spawn_subagent") {
    return false;
  }

  const policy = executionEnvironment?.toolPolicy;
  if (!isExecutionToolAllowedByPolicy(policy, toolName, {requireAllowlist: true})) {
    return false;
  }
  if (toolName === POSTGRES_READONLY_TOOL_NAME && policy?.postgresReadonly?.allowed !== true) {
    return false;
  }

  return true;
}

function resolveSessionTools(
  tools: readonly Tool[] | undefined,
  options: Pick<CreateThreadDefinitionOptions, "bashToolOptions" | "browserToolOptions" | "imageGenerateToolOptions" | "executionEnvironment" | "session">,
): readonly Tool[] {
  const baseTools = tools ?? (() => {
    const toolsets = buildDefaultAgentToolsetsFromRegistry(createDefaultAgentToolRegistry({
      bash: options.bashToolOptions,
      browser: options.browserToolOptions,
      imageGenerate: options.imageGenerateToolOptions,
    }));
    return toolsets.main;
  })();

  if (isSubagentSession(options.session)) {
    return baseTools.filter((tool) => isSubagentToolAllowed(tool.name, options.executionEnvironment));
  }

  return baseTools;
}

export function resolveStoredContext(
  fallback: Pick<DefaultAgentSessionContext, "cwd">,
  agentKey?: string,
  executionEnvironment?: ResolvedExecutionEnvironment,
): Pick<DefaultAgentSessionContext, "cwd"> {
  const remoteInitialCwd = executionEnvironment?.initialCwd ?? (agentKey ? resolveRemoteInitialCwd(agentKey) : null);
  const selectedCwd = remoteInitialCwd ?? fallback.cwd;
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

function resolveSessionThinking(
  _session: Pick<SessionRecord, "id" | "agentKey" | "metadata"> & {kind?: AgentSessionKind},
  runtimeConfig: SessionRuntimeConfigRecord | undefined,
  subagent: SubagentSessionMetadata | undefined,
): SessionRuntimeConfigRecord["thinking"] {
  if (runtimeConfig?.thinkingConfigured) {
    return runtimeConfig.thinking;
  }
  if (subagent?.resolved.thinking) {
    return subagent.resolved.thinking;
  }

  return undefined;
}

function resolveSessionModel(
  runtimeConfig: SessionRuntimeConfigRecord | undefined,
  subagent: SubagentSessionMetadata | undefined,
): string | undefined {
  return runtimeConfig?.model ?? subagent?.resolved.model;
}

function resolveSessionInstructions(
  session: Pick<SessionRecord, "id" | "agentKey" | "metadata"> & {kind?: AgentSessionKind},
  subagent: SubagentSessionMetadata | undefined,
): string {
  if (isSubagentSession(session)) {
    if (!subagent) {
      throw new Error(`Subagent session ${session.id} is missing subagent metadata.`);
    }
    return subagent.profile.prompt;
  }

  return DEFAULT_AGENT_INSTRUCTIONS;
}

export function createThreadDefinition(
  options: CreateThreadDefinitionOptions,
): ResolvedThreadDefinition {
  const {session} = options;
  if (isWorkerSession(session)) {
    throw new Error(`Legacy worker session ${session.id} is not supported after the subagent hard cut.`);
  }
  const storedSubagent = isSubagentSession(session)
    ? readRequiredSubagentMetadata(session)
    : undefined;
  const context: DefaultAgentSessionContext = {
    ...resolveStoredContext(options.fallbackContext, session.agentKey, options.executionEnvironment),
    threadId: options.thread.id,
    sessionId: session.id,
    sessionKind: session.kind,
    agentKey: session.agentKey,
    subagentDepth: 0,
    ...(options.executionEnvironment ? {executionEnvironment: options.executionEnvironment} : {}),
    ...options.extraContext,
  };

  const llmContexts: LlmContext[] = buildDefaultAgentLlmContexts({
    context,
    agentStore: options.agentStore,
    sessionStore: options.sessionStore,
    subagentProfiles: options.subagentProfiles,
    threadStore: options.threadStore,
    scheduledTasks: options.scheduledTasks,
    executionEnvironments: options.executionEnvironments,
    wikiBindings: options.wikiBindings,
    agentKey: session.agentKey,
    threadId: options.thread.id,
    sections: resolveLlmContextSections(session, options.llmContextSections),
    skillPolicy: options.executionEnvironment?.skillPolicy,
    sessionPrompt: options.sessionPrompt,
    extraLlmContexts: options.extraLlmContexts,
  });
  if (storedSubagent) {
    llmContexts.unshift(new SubagentRuntimeContext({
      subagent: storedSubagent,
      executionEnvironment: options.executionEnvironment,
    }));
  }
  const tools = resolveSessionTools(options.tools, options);
  const threadPromptCacheKey = resolveThreadPromptCacheKey(options.thread.id);

  return {
    agent: new Agent({
      name: session.agentKey,
      instructions: resolveSessionInstructions(session, storedSubagent),
      tools,
    }),
    context,
    llmContexts,
    promptCacheKey: resolveSessionPromptCacheKey(threadPromptCacheKey, options.sessionPrompt),
    model: resolveSessionModel(options.runtimeConfig, storedSubagent),
    thinking: resolveSessionThinking(session, options.runtimeConfig, storedSubagent),
    inferenceProjection: mergeInferenceProjection(
      DEFAULT_INFERENCE_PROJECTION,
      options.runtimeConfig?.inferenceProjection,
    ),
  };
}
