import {createHash} from "node:crypto";

import type {ToolResultMessage} from "@earendil-works/pi-ai";

import {ProviderRuntimeError} from "../../kernel/agent/exceptions.js";
import type {Tool} from "../../kernel/agent/tool.js";
import {normalizeToJsonValue, stableStringify, type JsonObject, type JsonValue} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {RecordModelCallTraceInput} from "./types.js";

const BLOB_KEY_PATTERN = /^(?:data|image|imageData|base64|blob|bytes|buffer|payload)$/i;
const PROMPT_CACHE_KEY_REDACTION_PATTERN = /^\[redacted:prompt-cache-key:sha256:[a-f0-9]{16}\]$/;
const ERROR_MAX_CHARS = 500;
const CREDENTIAL_REDACTION = "[redacted:credential]";
const REQUEST_ID_REDACTION = "[redacted:request-id]";

function isJsonRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeBase64Blob(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 128) {
    return false;
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    return false;
  }
  const padding = compact.match(/=+$/)?.[0].length ?? 0;
  return padding <= 2;
}

function blobPlaceholder(kind: string, value: string): JsonObject {
  return {
    redacted: true,
    reason: "large_blob",
    kind,
    chars: value.length,
  };
}

function isPromptCacheKeyField(key: string | undefined): boolean {
  return key?.replace(/[^a-z0-9]/gi, "").toLowerCase().includes("promptcachekey") ?? false;
}

function redactCredentialShapedText(value: string): string {
  return value
    .replace(/\bBearer\s+(?!\[redacted:credential\])[^\s,;]+/gi, `Bearer ${CREDENTIAL_REDACTION}`)
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}\b/g, CREDENTIAL_REDACTION)
    .replace(/([?&](?:access_?token|api_?key|auth|credential|secret|token)=)[^&#\s]+/gi, `$1${CREDENTIAL_REDACTION}`)
    .replace(/(\b(?:access_?token|api_?key|auth(?:orization)?|credential|password|secret|sessionid|token)\b\s*[:=]\s*)(?!\[redacted:credential\])(?:["']?)[^\s,;"']+/gi, `$1${CREDENTIAL_REDACTION}`)
    .replace(/(\b(?:x[-_])?request[-_\s]*id\b\s*[:=]\s*)(?!\[redacted:request-id\])(?:["']?)[^\s,;"']+/gi, `$1${REQUEST_ID_REDACTION}`)
    .replace(/\breq[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g, REQUEST_ID_REDACTION);
}

function sanitizeString(value: string, key?: string): JsonValue {
  if (isPromptCacheKeyField(key)) {
    return sanitizePromptCacheKey(value);
  }

  if (/^data:[^,]+;base64,/i.test(value)) {
    return blobPlaceholder("data_uri", value);
  }

  if ((key && BLOB_KEY_PATTERN.test(key) && value.length > 64) || looksLikeBase64Blob(value)) {
    return blobPlaceholder(key ?? "base64", value);
  }

  return value;
}

function sanitizeJsonValue(value: JsonValue, key?: string): JsonValue {
  if (isPromptCacheKeyField(key)) {
    return sanitizePromptCacheKey(value);
  }

  if (typeof value === "string") {
    return sanitizeString(value, key);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry));
  }

  const sanitized: JsonObject = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    sanitized[entryKey] = sanitizeJsonValue(entry, entryKey);
  }
  return sanitized;
}

export function sanitizeTraceJson(value: unknown): JsonValue {
  return sanitizeJsonValue(normalizeToJsonValue(value));
}

export function sanitizeTraceRequestJson(value: JsonObject): JsonObject {
  const sanitized = sanitizeTraceJson(value);
  return isJsonRecord(sanitized) ? sanitized : {};
}

export function sanitizeTraceString(value: string, key?: string): string {
  const sanitized = sanitizeString(value, key);
  return typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
}

export function sanitizePromptCacheKey(value: unknown): string {
  if (typeof value === "string" && PROMPT_CACHE_KEY_REDACTION_PATTERN.test(value)) {
    return value;
  }

  const hashInput = typeof value === "string" ? value : stableStringify(normalizeToJsonValue(value));
  const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
  return `[redacted:prompt-cache-key:sha256:${hash}]`;
}

function toolByName(tools: readonly Tool[], name: unknown): Tool | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  return tools.find((tool) => tool.name === name);
}

function sanitizeAssistantToolCalls(message: JsonObject, tools: readonly Tool[]): JsonObject {
  const content = message.content;
  if (!Array.isArray(content)) {
    return message;
  }

  return {
    ...message,
    content: content.map((block) => {
      if (!isJsonRecord(block) || block.type !== "toolCall") {
        return block;
      }

      const args = block.arguments;
      if (!isJsonRecord(args)) {
        return block;
      }

      const tool = toolByName(tools, block.name);
      if (!tool) {
        return {
          ...block,
          arguments: {
            redacted: true,
            reason: "unknown_tool_arguments",
          },
        } satisfies JsonObject;
      }

      try {
        return {
          ...block,
          arguments: normalizeToJsonValue(tool.redactCallArguments(args)),
        } satisfies JsonObject;
      } catch {
        return {
          ...block,
          arguments: {
            redacted: true,
            reason: "tool_argument_redaction_failed",
          },
        } satisfies JsonObject;
      }
    }),
  };
}

function sanitizeToolResultMessage(message: JsonObject, tools: readonly Tool[]): JsonObject {
  const tool = toolByName(tools, message.toolName);
  if (!tool) {
    return {
      ...message,
      content: [{type: "text", text: "[tool result redacted: unknown tool]"}],
      details: {redacted: true, reason: "unknown_tool_result"},
    };
  }

  try {
    return normalizeToJsonValue(tool.redactResultMessage(message as unknown as ToolResultMessage<JsonValue>)) as JsonObject;
  } catch {
    return {
      ...message,
      content: [{type: "text", text: "[tool result redacted: redaction failed]"}],
      details: {redacted: true, reason: "tool_result_redaction_failed"},
    };
  }
}

export function sanitizeTraceMessage(message: unknown, tools: readonly Tool[]): JsonValue {
  const normalized = normalizeToJsonValue(message);
  if (!isJsonRecord(normalized)) {
    return sanitizeJsonValue(normalized);
  }

  let next = normalized;
  if (next.role === "assistant") {
    next = sanitizeAssistantToolCalls(next, tools);
  } else if (next.role === "toolResult") {
    next = sanitizeToolResultMessage(next, tools);
  }

  return sanitizeJsonValue(next);
}

function sanitizeTraceResponse(message: unknown, tools: readonly Tool[]): JsonValue {
  const sanitized = sanitizeTraceMessage(message, tools);
  if (!isJsonRecord(sanitized)
    || sanitized.role !== "assistant"
    || (sanitized.stopReason !== "error" && sanitized.stopReason !== "aborted")) {
    return sanitized;
  }

  const withoutErrorMessage = {...sanitized};
  delete withoutErrorMessage.errorMessage;
  return withoutErrorMessage;
}

function sanitizeTraceMessages(messages: readonly unknown[], tools: readonly Tool[]): JsonValue[] {
  return messages.map((message) => sanitizeTraceMessage(message, tools));
}

function normalizeErrorWhitespace(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cutStructuredErrorPayload(value: string): string {
  const trimmed = value.trim();
  if (/^[{[]/.test(trimmed)) {
    return "";
  }
  const objectStart = trimmed.search(/[\[{]/);
  return objectStart > 0 ? trimmed.slice(0, objectStart) : trimmed;
}

function sanitizeErrorMessage(value: string): string {
  const sanitized = redactCredentialShapedText(normalizeErrorWhitespace(cutStructuredErrorPayload(value)));
  if (!sanitized) {
    return "Model call failed.";
  }
  if (sanitized.length <= ERROR_MAX_CHARS) {
    return sanitized;
  }
  return `${sanitized.slice(0, ERROR_MAX_CHARS - 1).trimEnd()}…`;
}

export function sanitizeTraceError(error: unknown): JsonObject {
  if (error instanceof ProviderRuntimeError) {
    return {
      category: error.failureKind ?? "provider_error",
      message: sanitizeErrorMessage(error.providerMessage ?? error.message),
      provider: error.providerName,
      model: error.modelId,
      ...(typeof error.status === "number" ? {status: error.status} : {}),
      ...(error.requestId ? {requestId: REQUEST_ID_REDACTION} : {}),
      ...(error.stopReason ? {stopReason: sanitizeErrorMessage(error.stopReason)} : {}),
      retryable: error.retryable,
      timedOut: error.timedOut,
    };
  }

  const name = error instanceof Error && error.name ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return {
    category: name,
    message: sanitizeErrorMessage(message),
  };
}

export function buildSanitizedModelCallTrace(input: RecordModelCallTraceInput): {
  promptCacheKey?: string;
  requestJson: JsonObject;
  responseJson?: JsonValue;
  errorJson?: JsonObject;
  usageJson?: JsonValue;
} {
  const request = input.request;
  const context = request.context;
  const promptCacheKey = request.promptCacheKey === undefined ? undefined : sanitizePromptCacheKey(request.promptCacheKey);
  const requestJson: JsonObject = {
    provider: request.providerName,
    model: request.modelId,
    ...(promptCacheKey !== undefined ? {promptCacheKey} : {}),
    ...(context.systemPrompt ? {systemPrompt: sanitizeTraceJson(context.systemPrompt)} : {}),
    messages: sanitizeTraceMessages(context.messages, input.tools),
    tools: sanitizeTraceJson(context.tools ?? []),
    ...(request.trace?.llmContextDump ? {llmContextDump: sanitizeTraceJson(request.trace.llmContextDump)} : {}),
    ...(request.trace?.llmContextSections?.length
      ? {llmContextSections: sanitizeTraceJson(request.trace.llmContextSections)}
      : {}),
  };
  const responseJson = input.response ? sanitizeTraceResponse(input.response, input.tools) : undefined;
  const usageJson = input.response && isRecord(input.response.usage)
    ? sanitizeTraceJson(input.response.usage)
    : undefined;
  const errorJson = input.error === undefined ? undefined : sanitizeTraceError(input.error);

  return {
    ...(promptCacheKey !== undefined ? {promptCacheKey} : {}),
    requestJson,
    ...(responseJson !== undefined ? {responseJson} : {}),
    ...(errorJson !== undefined ? {errorJson} : {}),
    ...(usageJson !== undefined ? {usageJson} : {}),
  };
}
