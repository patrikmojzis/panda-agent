import {completeSimple, type SimpleStreamOptions, streamSimple} from "@mariozechner/pi-ai";

import type {LlmRuntime, LlmRuntimeRequest} from "../../../kernel/agent/runtime.js";
import {resolveProviderApiKey} from "./auth.js";
import {resolveProviderModel} from "./model.js";

const DEFAULT_MODEL_TIMEOUT_MS = 600_000;

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

function buildRuntimeOptions(
  request: LlmRuntimeRequest,
  options: {
    applyHardTimeout: boolean;
  },
): SimpleStreamOptions {
  const apiKey = resolveProviderApiKey(request.providerName);
  const runtimeOptions: SimpleStreamOptions = {};

  if (options.applyHardTimeout) {
    // Keep the hard wall-clock deadline on complete() only. Streaming calls can
    // stay healthy for a long time as long as events keep flowing.
    const timeoutSignal = AbortSignal.timeout(resolveModelTimeoutMs());
    runtimeOptions.signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
  } else if (request.signal) {
    runtimeOptions.signal = request.signal;
  }

  if (request.temperature !== undefined) {
    runtimeOptions.temperature = request.temperature;
  }

  if (request.thinking) {
    runtimeOptions.reasoning = request.thinking;
  }

  if (request.promptCacheKey) {
    runtimeOptions.sessionId = request.promptCacheKey;
  }

  if (apiKey) {
    runtimeOptions.apiKey = apiKey;
  }

  return runtimeOptions;
}

export class PiAiRuntime implements LlmRuntime {
  async complete(request: LlmRuntimeRequest) {
    const model = resolveProviderModel(request.providerName, request.modelId);
    return completeSimple(model, request.context, buildRuntimeOptions(request, {
      applyHardTimeout: true,
    }));
  }

  stream(request: LlmRuntimeRequest) {
    const model = resolveProviderModel(request.providerName, request.modelId);
    return streamSimple(model, request.context, buildRuntimeOptions(request, {
      applyHardTimeout: false,
    }));
  }
}
