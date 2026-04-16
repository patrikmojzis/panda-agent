import {completeSimple, type SimpleStreamOptions, streamSimple} from "@mariozechner/pi-ai";

import type {LlmRuntime, LlmRuntimeRequest} from "../../../kernel/agent/runtime.js";
import {resolveProviderApiKey} from "./auth.js";
import {resolveProviderModel} from "./model.js";

function buildRuntimeOptions(request: LlmRuntimeRequest): SimpleStreamOptions {
  const apiKey = resolveProviderApiKey(request.providerName);
  const options: SimpleStreamOptions = {};

  if (request.signal) {
    options.signal = request.signal;
  }

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
    const model = resolveProviderModel(request.providerName, request.modelId);
    return completeSimple(model, request.context, buildRuntimeOptions(request));
  }

  stream(request: LlmRuntimeRequest) {
    const model = resolveProviderModel(request.providerName, request.modelId);
    return streamSimple(model, request.context, buildRuntimeOptions(request));
  }
}
