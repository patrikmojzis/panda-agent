import type { AssistantMessage, AssistantMessageEventStream, Context } from "@mariozechner/pi-ai";

import type { ProviderName, ReasoningEffort } from "./types.js";

export interface LlmRuntimeRequest {
  providerName: ProviderName;
  model: string;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  promptCacheKey?: string;
  context: Context;
}

export interface LlmRuntime {
  complete(request: LlmRuntimeRequest): Promise<AssistantMessage>;
  stream(request: LlmRuntimeRequest): AssistantMessageEventStream;
}
