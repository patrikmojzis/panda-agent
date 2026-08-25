import type {AssistantMessage, AssistantMessageEventStream, Context, ThinkingLevel,} from "@earendil-works/pi-ai";

import type {Tool} from "./tool.js";
import type {ProviderName} from "./types.js";

export interface LlmRuntimeRequestTraceSection {
  name: string;
  source?: string;
  label?: string;
  contentPreview?: string;
  contentChars?: number;
  estimatedTokens?: number;
  dumpChars?: number;
}

export interface LlmRuntimeRequestTraceContext {
  llmContextSections?: readonly LlmRuntimeRequestTraceSection[];
}

export interface LlmRuntimeRequestMetadata {
  runId?: string;
  threadId?: string;
  sessionId?: string;
  agentKey?: string;
  subagentDepth?: number;
  turn?: number;
}

export interface LlmRuntimeRequest {
  providerName: ProviderName;
  modelId: string;
  temperature?: number;
  thinking?: ThinkingLevel;
  promptCacheKey?: string;
  signal?: AbortSignal;
  metadata?: LlmRuntimeRequestMetadata;
  trace?: LlmRuntimeRequestTraceContext;
  context: Context;
}

export interface LlmModelCallObservation {
  mode: "complete" | "stream";
  attempt: number;
  request: LlmRuntimeRequest;
  tools: readonly Tool[];
  startedAt: number;
  finishedAt: number;
  response?: AssistantMessage;
  error?: unknown;
}

/**
 * A best-effort observability seam. Implementations must only enqueue bounded
 * work: model-call telemetry is never allowed to participate in run outcome.
 */
export interface LlmModelCallObserver {
  observeModelCall(input: LlmModelCallObservation): void;
}

export interface LlmRuntime {
  complete(request: LlmRuntimeRequest): Promise<AssistantMessage>;
  stream(request: LlmRuntimeRequest): AssistantMessageEventStream;
}
