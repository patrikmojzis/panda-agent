import { completeSimple, streamSimple } from "@mariozechner/pi-ai";

import { resolveProviderApiKey } from "./auth.js";
import { resolvePandaModel } from "./model.js";
import type { LlmRuntime, LlmRuntimeRequest } from "../runtime.js";

function buildRuntimeOptions(request: LlmRuntimeRequest): Record<string, unknown> {
  const apiKey = resolveProviderApiKey(request.providerName);
  const options: Record<string, unknown> = {};

  if (request.temperature !== undefined) {
    options.temperature = request.temperature;
  }

  if (request.reasoningEffort) {
    options.reasoning = request.reasoningEffort;
  }

  if (request.promptCacheKey) {
    options.sessionId = request.promptCacheKey;
  }

  if (apiKey) {
    options.apiKey = apiKey;
  }

  return options;
}

export class PiAiRuntime implements LlmRuntime {
  async complete(request: LlmRuntimeRequest) {
    const model = resolvePandaModel(request.providerName, request.model);
    return completeSimple(model, request.context, buildRuntimeOptions(request));
  }

  stream(request: LlmRuntimeRequest) {
    const model = resolvePandaModel(request.providerName, request.model);
    return streamSimple(model, request.context, buildRuntimeOptions(request));
  }
}
