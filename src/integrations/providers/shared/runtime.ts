import {completeSimple, streamSimple} from "@earendil-works/pi-ai/compat";
import type {SimpleStreamOptions} from "@earendil-works/pi-ai";

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

function buildRuntimeOptions(request: LlmRuntimeRequest): SimpleStreamOptions {
  const apiKey = resolveProviderApiKey(request.providerName);
  const runtimeOptions: SimpleStreamOptions = {};

  if (request.signal) {
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
    const timeoutMs = resolveModelTimeoutMs();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const options = buildRuntimeOptions(request);
    options.signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

    let response;
    try {
      response = await completeSimple(model, request.context, options);
    } catch (error) {
      if (timeoutSignal.aborted && request.signal?.aborted !== true) {
        throw new Error(`Provider request timed out after ${timeoutMs}ms`, {cause: error});
      }
      throw error;
    }
    if (timeoutSignal.aborted && request.signal?.aborted !== true) {
      throw new Error(`Provider request timed out after ${timeoutMs}ms`);
    }
    return response;
  }

  stream(request: LlmRuntimeRequest) {
    const model = resolveProviderModel(request.providerName, request.modelId);
    return streamSimple(model, request.context, buildRuntimeOptions(request));
  }
}
