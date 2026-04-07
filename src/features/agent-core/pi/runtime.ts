import { completeSimple, streamSimple, type SimpleStreamOptions } from "@mariozechner/pi-ai";

import { resolveProviderApiKey } from "./auth.js";
import { resolvePandaModel } from "./model.js";
import type { LlmRuntime, LlmRuntimeRequest } from "../runtime.js";

function buildRuntimeOptions(request: LlmRuntimeRequest): SimpleStreamOptions {
  const apiKey = resolveProviderApiKey(request.providerName);
  const options: SimpleStreamOptions = {};

  if (request.temperature !== undefined) {
    options.temperature = request.temperature;
  }

  if (request.thinking) {
    options.reasoning = request.thinking;
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
