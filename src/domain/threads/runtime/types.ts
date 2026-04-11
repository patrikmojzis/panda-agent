import type {Message, ThinkingLevel} from "@mariozechner/pi-ai";

import type {Agent} from "../../../kernel/agent/agent.js";
import type {TokenCounter} from "../../../kernel/agent/helpers/token-count.js";
import type {Hook} from "../../../kernel/agent/hook.js";
import type {LlmContext} from "../../../kernel/agent/llm-context.js";
import type {JsonValue} from "../../../kernel/agent/types.js";
import type {LlmRuntime} from "../../../kernel/agent/runtime.js";
import type {RunPipeline} from "../../../kernel/agent/run-pipeline.js";

export interface AutoCompactionRuntimeState {
  consecutiveFailures: number;
  lastFailureReason?: string;
  lastFailureAt?: number;
  cooldownUntil?: number;
}

export interface ThreadRuntimeState {
  autoCompaction?: AutoCompactionRuntimeState;
}

export interface InferenceProjectionRule {
  preserveRecentUserTurns?: number;
  olderThanMs?: number;
  preserveTailMessages?: number;
}

export interface InferenceProjection {
  dropThinking?: InferenceProjectionRule;
  dropToolCalls?: InferenceProjectionRule;
  dropImages?: InferenceProjectionRule;
  dropMessages?: InferenceProjectionRule;
}

export interface CreateThreadInput {
  id: string;
  identityId?: string;
  agentKey: string;
  systemPrompt?: string | ReadonlyArray<string>;
  maxTurns?: number;
  context?: JsonValue;
  runtimeState?: ThreadRuntimeState;
  maxInputTokens?: number;
  promptCacheKey?: string;
  model?: string;
  temperature?: number;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
}

export type ThreadUpdate = Partial<Omit<CreateThreadInput, "id" | "identityId" | "thinking" | "runtimeState">> & {
  thinking?: ThinkingLevel | null;
  runtimeState?: ThreadRuntimeState | null;
  inferenceProjection?: InferenceProjection | null;
};

export interface ThreadRecord extends Omit<CreateThreadInput, "identityId"> {
  identityId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedThreadDefinition {
  agent: Agent<unknown>;
  systemPrompt?: string | ReadonlyArray<string>;
  maxTurns?: number;
  context?: unknown;
  llmContexts?: ReadonlyArray<LlmContext>;
  hooks?: ReadonlyArray<Hook>;
  maxInputTokens?: number;
  promptCacheKey?: string;
  runPipelines?: ReadonlyArray<RunPipeline>;
  model?: string;
  temperature?: number;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
  runtime?: LlmRuntime;
  countTokens?: TokenCounter;
}

export type ThreadDefinitionResolver = (
  thread: ThreadRecord,
) => Promise<ResolvedThreadDefinition> | ResolvedThreadDefinition;

export interface ThreadMessageMetadata {
  source: string;
  channelId?: string;
  externalMessageId?: string;
  actorId?: string;
}

export function missingThreadError(threadId: string): Error {
  return new Error(`Unknown thread ${threadId}`);
}

export function isMissingThreadError(error: unknown, threadId?: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (threadId === undefined) {
    return error.message.startsWith("Unknown thread ");
  }

  return error.message === `Unknown thread ${threadId}`;
}

export function matchesThreadInputIdentity(
  left: Pick<ThreadMessageMetadata, "source" | "channelId" | "externalMessageId">,
  right: Pick<ThreadMessageMetadata, "source" | "channelId" | "externalMessageId">,
): boolean {
  if (!left.externalMessageId || !right.externalMessageId) {
    return false;
  }

  return left.source === right.source
    && left.externalMessageId === right.externalMessageId
    && (left.channelId ?? null) === (right.channelId ?? null);
}

export type ThreadMessageOrigin = "input" | "runtime";
export type ThreadInputDeliveryMode = "wake" | "queue";

export interface ThreadMessageRecord extends ThreadMessageMetadata {
  id: string;
  threadId: string;
  sequence: number;
  origin: ThreadMessageOrigin;
  message: Message;
  metadata?: JsonValue;
  runId?: string;
  createdAt: number;
}

export interface ThreadSummaryRecord {
  thread: ThreadRecord;
  messageCount: number;
  pendingInputCount: number;
  lastMessage?: ThreadMessageRecord;
}

export interface ThreadInputRecord extends ThreadMessageMetadata {
  id: string;
  threadId: string;
  order: number;
  deliveryMode: ThreadInputDeliveryMode;
  message: Message;
  metadata?: JsonValue;
  createdAt: number;
  appliedAt?: number;
}

export interface ThreadInputPayload extends ThreadMessageMetadata {
  message: Message;
  metadata?: JsonValue;
}

export interface ThreadRuntimeMessagePayload extends ThreadMessageMetadata {
  message: Message;
  metadata?: JsonValue;
  runId?: string;
}

export type ThreadRunStatus = "running" | "completed" | "failed";

export interface ThreadRunRecord {
  id: string;
  threadId: string;
  status: ThreadRunStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  abortRequestedAt?: number;
  abortReason?: string;
}

export type ThreadBashJobStatus = "running" | "completed" | "failed" | "cancelled" | "lost";
export type ThreadBashJobMode = "local" | "remote";

export interface ThreadBashJobRecord {
  id: string;
  threadId: string;
  runId?: string;
  status: ThreadBashJobStatus;
  command: string;
  mode: ThreadBashJobMode;
  initialCwd: string;
  finalCwd?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutChars: number;
  stderrChars: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutPersisted: boolean;
  stderrPersisted: boolean;
  stdoutPath?: string;
  stderrPath?: string;
  trackedEnvKeys: string[];
  statusReason?: string;
}

export interface CreateThreadBashJobInput {
  id: string;
  threadId: string;
  runId?: string;
  status?: ThreadBashJobStatus;
  command: string;
  mode: ThreadBashJobMode;
  initialCwd: string;
  startedAt?: number;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  stdoutChars?: number;
  stderrChars?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutPersisted?: boolean;
  stderrPersisted?: boolean;
  stdoutPath?: string;
  stderrPath?: string;
  trackedEnvKeys?: string[];
  statusReason?: string;
}

export type ThreadBashJobUpdate = Partial<
  Omit<CreateThreadBashJobInput, "id" | "threadId" | "command" | "mode" | "stdoutPath" | "stderrPath" | "trackedEnvKeys" | "statusReason">
> & {
  finalCwd?: string | null;
  finishedAt?: number | null;
  durationMs?: number | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutPath?: string | null;
  stderrPath?: string | null;
  trackedEnvKeys?: string[] | null;
  statusReason?: string | null;
};
