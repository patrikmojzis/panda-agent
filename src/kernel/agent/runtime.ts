import type {AssistantMessage, AssistantMessageEventStream, Context, ThinkingLevel,} from "@mariozechner/pi-ai";

import type {ProviderName} from "./types.js";

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
  context: Context;
}

export interface LlmRuntime {
  complete(request: LlmRuntimeRequest): Promise<AssistantMessage>;
  stream(request: LlmRuntimeRequest): AssistantMessageEventStream;
}
