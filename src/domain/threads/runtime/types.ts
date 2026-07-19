import type {Message, ThinkingLevel} from "@earendil-works/pi-ai";

import type {Agent} from "../../../kernel/agent/agent.js";
import type {TokenCounter} from "../../../kernel/agent/helpers/token-count.js";
import type {Hook} from "../../../kernel/agent/hook.js";
import type {LlmContext} from "../../../kernel/agent/llm-context.js";
import type {JsonObject, JsonValue} from "../../../lib/json.js";
import type {LlmRuntime} from "../../../kernel/agent/runtime.js";
import type {RunPipeline} from "../../../kernel/agent/run-pipeline.js";
import type {
  InferenceProjection,
  ThreadMessageMetadata,
  ThreadMessageRecord,
  ThreadRuntimeState,
} from "../../../kernel/transcript/types.js";
import type {MediaDescriptor} from "../../channels/types.js";

export type {
  AutoCompactionRuntimeState,
  InferenceProjection,
  InferenceProjectionRule,
  ThreadMessageMetadata,
  ThreadMessageOrigin,
  ThreadMessageRecord,
  ThreadRuntimeMessagePayload,
  ThreadRuntimeState,
} from "../../../kernel/transcript/types.js";

export interface CreateThreadInput {
  id: string;
  sessionId: string;
  runtimeState?: ThreadRuntimeState;
}

export interface ThreadUpdate {
  runtimeState?: ThreadRuntimeState | null;
}

export interface ThreadRecord extends CreateThreadInput {
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

export type ThreadInputDeliveryMode = "wake" | "queue";

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

export interface ThreadChannelMessageFilter {
  sessionId: string;
  source: string;
  connectorKey: string;
  channelId: string;
  limit?: number;
}

export interface ThreadChannelMediaFilter {
  sessionId: string;
  source: string;
  connectorKey: string;
  channelId: string;
  mediaId: string;
}

export interface ThreadChannelMediaRecord {
  message: ThreadMessageRecord;
  media: MediaDescriptor;
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

export type ThreadToolJobKind = "bash" | "command" | "image_generate" | "spawn_subagent" | "web_research";
export type ThreadToolJobStatus = "running" | "completed" | "failed" | "cancelled" | "lost";

export interface ThreadToolJobRecord {
  id: string;
  threadId: string;
  runId?: string;
  parentToolCallId?: string;
  commandOrdinal?: number;
  kind: ThreadToolJobKind;
  status: ThreadToolJobStatus;
  summary: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  result?: JsonObject;
  error?: string;
  statusReason?: string;
  progress?: JsonObject;
}

export interface CreateThreadToolJobInput {
  id: string;
  threadId: string;
  runId?: string;
  parentToolCallId?: string;
  kind: ThreadToolJobKind;
  status?: ThreadToolJobStatus;
  summary?: string;
  startedAt?: number;
  result?: JsonObject;
  error?: string;
  statusReason?: string;
  progress?: JsonObject;
}

export type ThreadToolJobUpdate = Partial<
  Omit<CreateThreadToolJobInput, "id" | "threadId" | "runId" | "parentToolCallId" | "kind" | "result" | "error" | "statusReason" | "progress">
> & {
  finishedAt?: number | null;
  durationMs?: number | null;
  result?: JsonObject | null;
  error?: string | null;
  statusReason?: string | null;
  progress?: JsonObject | null;
};
