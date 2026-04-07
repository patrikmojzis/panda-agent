import type { AssistantMessage, AssistantMessageEventStream, Context } from "@mariozechner/pi-ai";

import type { ReasoningEffort } from "./types.js";

export interface LlmRuntimeRequest {
  providerName: string;
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
