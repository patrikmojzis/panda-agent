import type {AssistantMessage, AssistantMessageEventStream, Context, ThinkingLevel,} from "@earendil-works/pi-ai";

import type {Tool} from "./tool.js";
import type {ProviderName} from "./types.js";

export interface LlmRuntimeRequestTraceSection {
  name: string;
  content: string;
  dump: string;
}

export interface LlmRuntimeRequestTraceContext {
  llmContextDump?: string;
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

export interface LlmModelCallTraceInput {
  mode: "complete" | "stream";
  request: LlmRuntimeRequest;
  tools: readonly Tool[];
  startedAt: number;
  finishedAt: number;
  response?: AssistantMessage;
  error?: unknown;
}

export interface LlmModelCallTracer {
  recordModelCallTrace(input: LlmModelCallTraceInput): Promise<void>;
}

export interface LlmRuntime {
  complete(request: LlmRuntimeRequest): Promise<AssistantMessage>;
  stream(request: LlmRuntimeRequest): AssistantMessageEventStream;
}
