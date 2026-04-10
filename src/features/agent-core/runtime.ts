import type {AssistantMessage, AssistantMessageEventStream, Context, ThinkingLevel,} from "@mariozechner/pi-ai";

import type {ProviderName} from "./types.js";

export interface LlmRuntimeRequest {
  providerName: ProviderName;
  modelId: string;
  temperature?: number;
  thinking?: ThinkingLevel;
  promptCacheKey?: string;
  signal?: AbortSignal;
  context: Context;
}

export interface LlmRuntime {
  complete(request: LlmRuntimeRequest): Promise<AssistantMessage>;
  stream(request: LlmRuntimeRequest): AssistantMessageEventStream;
}
