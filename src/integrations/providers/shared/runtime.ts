import {completeSimple, type ProviderResponse, type SimpleStreamOptions, streamSimple} from "@mariozechner/pi-ai";

import type {LlmRuntime, LlmRuntimeRequest} from "../../../kernel/agent/runtime.js";
import {ProviderRuntimeError} from "../../../kernel/agent/exceptions.js";
import {isRecord} from "../../../lib/records.js";
import {resolveProviderApiKey} from "./auth.js";
import {resolveProviderModel} from "./model.js";
import {getProviderConfig} from "./provider.js";

const DEFAULT_MODEL_TIMEOUT_MS = 180_000;

type RuntimeCallKind = "complete" | "stream";

type RuntimeResponseState = {
  status?: number;
  headers?: Record<string, string>;
};

type ProviderErrorInfo = {
  name?: string;
  status?: number;
  requestId?: string;
  type?: string;
  code?: string;
  message?: string;
};

type BuiltRuntimeOptions = {
  options: SimpleStreamOptions;
  timeoutSignal: AbortSignal;
};

function resolveModelTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PANDA_MODEL_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_MODEL_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("PANDA_MODEL_TIMEOUT_MS must be a positive integer.");
  }

  return parsed;
}

function logProviderRuntimeEvent(
  event: string,
  request: LlmRuntimeRequest,
  payload: Record<string, unknown> = {},
): void {
  const metadata = request.metadata;
  const authKind = getProviderConfig(request.providerName).authKind;
  process.stdout.write(`${JSON.stringify({
    source: "runtime",
    event,
    timestamp: new Date().toISOString(),
    provider: request.providerName,
    model: request.modelId,
    authKind,
    runId: metadata?.runId ?? null,
    threadId: metadata?.threadId ?? null,
    sessionId: metadata?.sessionId ?? null,
    agentKey: metadata?.agentKey ?? null,
    subagentDepth: metadata?.subagentDepth ?? null,
    turn: metadata?.turn ?? null,
    ...payload,
  })}\n`);
}

function readHeaderValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  const direct = headers[name];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName || typeof value !== "string" || !value.trim()) {
      continue;
    }

    return value.trim();
  }

  return undefined;
}

function readRequestIdFromHeaders(headers: Record<string, string> | undefined): string | undefined {
  return readHeaderValue(headers, "request-id") ?? readHeaderValue(headers, "x-request-id");
}

function stripDuplicatedStatusPrefix(message: string | undefined, status: number | undefined): string | undefined {
  if (!message) {
    return undefined;
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return undefined;
  }

  if (status && trimmed.startsWith(`${status} `)) {
    const withoutStatus = trimmed.slice(String(status).length).trim();
    return withoutStatus || undefined;
  }

  return trimmed;
}

function readErrorInfo(value: unknown): ProviderErrorInfo {
  const base = value instanceof Error ? value : undefined;
  const record = isRecord(value) ? value : undefined;
  const cause = record?.cause;
  const causeRecord = isRecord(cause) ? cause : undefined;

  const status = typeof record?.status === "number"
    ? record.status
    : typeof causeRecord?.status === "number"
      ? causeRecord.status
      : undefined;
  const requestId = typeof record?.requestID === "string"
    ? record.requestID
    : typeof record?.requestId === "string"
      ? record.requestId
      : typeof causeRecord?.requestID === "string"
        ? causeRecord.requestID
        : typeof causeRecord?.requestId === "string"
          ? causeRecord.requestId
          : undefined;
  const type = typeof record?.type === "string"
    ? record.type
    : typeof causeRecord?.type === "string"
      ? causeRecord.type
      : undefined;
  const code = typeof record?.code === "string"
    ? record.code
    : typeof causeRecord?.code === "string"
      ? causeRecord.code
      : undefined;
  const message = stripDuplicatedStatusPrefix(
    base?.message
      ?? (typeof record?.message === "string" ? record.message : undefined)
      ?? (cause instanceof Error ? cause.message : undefined)
      ?? (typeof causeRecord?.message === "string" ? causeRecord.message : undefined),
    status,
  );

  return {
    name: base?.name ?? (typeof record?.name === "string" ? record.name : undefined),
    status,
    requestId,
    type,
    code,
    message,
  };
}

function buildProviderRuntimeErrorMessage(
  request: LlmRuntimeRequest,
  info: ProviderErrorInfo,
  durationMs: number,
  timedOut: boolean,
): string {
  const label = `${request.providerName}/${request.modelId}`;
  const requestIdSuffix = info.requestId ? `, request id ${info.requestId}` : "";

  if (timedOut) {
    return `Provider request timed out for ${label} after ${durationMs}ms.`;
  }

  if (request.signal?.aborted) {
    const reason = request.signal.reason instanceof Error
      ? request.signal.reason.message
      : typeof request.signal.reason === "string"
        ? request.signal.reason
        : undefined;
    return `Provider request aborted for ${label}${reason ? `: ${reason}` : "."}`;
  }

  if (info.status === 429) {
    return `Provider rate limit or quota exceeded for ${label} (status 429${requestIdSuffix})${info.message ? `: ${info.message}` : "."}`;
  }

  if (info.status === 401 || info.status === 403) {
    return `Provider auth failed for ${label} (status ${info.status}${requestIdSuffix})${info.message ? `: ${info.message}` : "."}`;
  }

  if (info.status !== undefined) {
    return `Provider request failed for ${label} (status ${info.status}${requestIdSuffix})${info.message ? `: ${info.message}` : "."}`;
  }

  if (info.message) {
    return `Provider request failed for ${label}: ${info.message}`;
  }

  return `Provider request failed for ${label}.`;
}

function buildProviderRuntimeError(
  request: LlmRuntimeRequest,
  error: unknown,
  options: {
    durationMs: number;
    timeoutSignal: AbortSignal;
    responseState?: RuntimeResponseState;
  },
): ProviderRuntimeError {
  const info = readErrorInfo(error);
  const requestId = info.requestId ?? readRequestIdFromHeaders(options.responseState?.headers);
  const status = info.status ?? options.responseState?.status;
  const timedOut = options.timeoutSignal.aborted;

  return new ProviderRuntimeError(
    buildProviderRuntimeErrorMessage(request, {
      ...info,
      requestId,
      status,
    }, options.durationMs, timedOut),
    {
      providerName: request.providerName,
      modelId: request.modelId,
      status,
      requestId,
      durationMs: options.durationMs,
      timedOut,
      cause: error,
    },
  );
}

function buildRuntimeOptions(
  request: LlmRuntimeRequest,
  onResponse?: (response: ProviderResponse) => void | Promise<void>,
): BuiltRuntimeOptions {
  const apiKey = resolveProviderApiKey(request.providerName);
  const options: SimpleStreamOptions = {};
  const timeoutSignal = AbortSignal.timeout(resolveModelTimeoutMs());

  options.signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

  if (onResponse) {
    options.onResponse = onResponse;
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

  return {
    options,
    timeoutSignal,
  };
}

function logProviderRequestStarted(kind: RuntimeCallKind, request: LlmRuntimeRequest): number {
  const startedAt = Date.now();
  logProviderRuntimeEvent("provider_request_started", request, {
    kind,
  });
  return startedAt;
}

function logProviderResponse(
  kind: RuntimeCallKind,
  request: LlmRuntimeRequest,
  response: ProviderResponse,
): RuntimeResponseState {
  const requestId = readRequestIdFromHeaders(response.headers);
  logProviderRuntimeEvent("provider_request_response", request, {
    kind,
    status: response.status,
    requestId: requestId ?? null,
  });

  return {
    status: response.status,
    headers: response.headers,
  };
}

function logProviderRequestCompleted(
  kind: RuntimeCallKind,
  request: LlmRuntimeRequest,
  startedAt: number,
  response: {
    responseId?: string;
    stopReason?: string;
  },
): void {
  logProviderRuntimeEvent("provider_request_completed", request, {
    kind,
    durationMs: Date.now() - startedAt,
    responseId: response.responseId ?? null,
    stopReason: response.stopReason ?? null,
  });
}

function logProviderRequestFailed(
  kind: RuntimeCallKind,
  request: LlmRuntimeRequest,
  error: ProviderRuntimeError,
  rawError: unknown,
): void {
  const info = readErrorInfo(rawError);
  logProviderRuntimeEvent("provider_request_failed", request, {
    kind,
    durationMs: error.durationMs ?? null,
    status: error.status ?? null,
    requestId: error.requestId ?? null,
    timedOut: error.timedOut,
    errorName: info.name ?? null,
    errorType: info.type ?? null,
    errorCode: info.code ?? null,
    message: error.message,
  });
}

export class PiAiRuntime implements LlmRuntime {
  async complete(request: LlmRuntimeRequest) {
    let responseState: RuntimeResponseState | undefined;
    const model = resolveProviderModel(request.providerName, request.modelId);
    const built = buildRuntimeOptions(request, async (response) => {
      responseState = logProviderResponse("complete", request, response);
    });
    const startedAt = logProviderRequestStarted("complete", request);

    try {
      const result = await completeSimple(model, request.context, built.options);
      logProviderRequestCompleted("complete", request, startedAt, result);
      return result;
    } catch (error) {
      const wrapped = buildProviderRuntimeError(request, error, {
        durationMs: Date.now() - startedAt,
        timeoutSignal: built.timeoutSignal,
        responseState,
      });
      logProviderRequestFailed("complete", request, wrapped, error);
      throw wrapped;
    }
  }

  stream(request: LlmRuntimeRequest) {
    let responseState: RuntimeResponseState | undefined;
    const model = resolveProviderModel(request.providerName, request.modelId);
    const built = buildRuntimeOptions(request, async (response) => {
      responseState = logProviderResponse("stream", request, response);
    });
    const startedAt = logProviderRequestStarted("stream", request);

    try {
      const stream = streamSimple(model, request.context, built.options);
      const originalResult = stream.result.bind(stream);
      let wrappedResultPromise: Promise<Awaited<ReturnType<typeof originalResult>>> | null = null;

      stream.result = () => {
        if (!wrappedResultPromise) {
          wrappedResultPromise = originalResult()
            .then((result) => {
              if (result.stopReason === "error" || result.stopReason === "aborted") {
                throw new Error(result.errorMessage ?? "Streaming failed");
              }

              logProviderRequestCompleted("stream", request, startedAt, result);
              return result;
            })
            .catch((error: unknown) => {
              const wrapped = buildProviderRuntimeError(request, error, {
                durationMs: Date.now() - startedAt,
                timeoutSignal: built.timeoutSignal,
                responseState,
              });
              logProviderRequestFailed("stream", request, wrapped, error);
              throw wrapped;
            });
        }

        return wrappedResultPromise;
      };

      return stream;
    } catch (error) {
      const wrapped = buildProviderRuntimeError(request, error, {
        durationMs: Date.now() - startedAt,
        timeoutSignal: built.timeoutSignal,
        responseState,
      });
      logProviderRequestFailed("stream", request, wrapped, error);
      throw wrapped;
    }
  }
}
