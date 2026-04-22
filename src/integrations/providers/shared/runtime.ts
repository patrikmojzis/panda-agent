import {completeSimple, type SimpleStreamOptions, streamSimple} from "@mariozechner/pi-ai";

import type {LlmRuntime, LlmRuntimeRequest} from "../../../kernel/agent/runtime.js";
import {resolveProviderApiKey} from "./auth.js";
import {resolveProviderModel} from "./model.js";

const DEFAULT_MODEL_TIMEOUT_MS = 180_000;

function resolveModelTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MODEL_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_MODEL_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("MODEL_TIMEOUT_MS must be a positive integer.");
  }

  return parsed;
}

function buildRuntimeOptions(request: LlmRuntimeRequest): SimpleStreamOptions {
  const apiKey = resolveProviderApiKey(request.providerName);
  const options: SimpleStreamOptions = {};
  const timeoutSignal = AbortSignal.timeout(resolveModelTimeoutMs());

  options.signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

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
