import {createHash} from "node:crypto";

import type {ToolResultMessage} from "@earendil-works/pi-ai";

import {ProviderRuntimeError} from "../../kernel/agent/exceptions.js";
import type {LlmModelCallObservation} from "../../kernel/agent/runtime.js";
import type {Tool} from "../../kernel/agent/tool.js";
import {normalizeToJsonValue, stableStringify, type JsonObject, type JsonValue} from "../../lib/json.js";

const BLOB_KEY_PATTERN = /^(?:data|image|imageData|base64|blob|bytes|buffer|payload)$/i;
const PROMPT_CACHE_KEY_REDACTION_PATTERN = /^\[redacted:prompt-cache-key:sha256:[a-f0-9]{16}\]$/;
const ERROR_MAX_CHARS = 500;
const ERROR_CATEGORY_MAX_CHARS = 128;
const ERROR_SCAN_MAX_CHARS = 4_096;
const CREDENTIAL_REDACTION = "[redacted:credential]";
const REQUEST_ID_REDACTION = "[redacted:request-id]";
const SNAPSHOT_TRUNCATION_REASON = "snapshot_size_limit";
const MIN_SNAPSHOT_BYTES = 16 * 1024;
const SNAPSHOT_MAX_DEPTH = 12;
const SNAPSHOT_MAX_NODES = 4_096;
const SNAPSHOT_MAX_COLLECTION_ENTRIES = 256;
const SNAPSHOT_MAX_KEY_CHARS = 256;
const SNAPSHOT_MAX_STRING_CHARS = 64 * 1024;
export const MODEL_CALL_SNAPSHOT_REDACTION_VERSION = 1;

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

  const sanitized = Object.create(null) as JsonObject;
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

function exceedsRedactionInputBudget(value: unknown, maxChars: number): boolean {
  const pending: Array<{value: unknown; depth: number}> = [{value, depth: 0}];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let chars = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > SNAPSHOT_MAX_NODES || current.depth >= SNAPSHOT_MAX_DEPTH) return true;
    if (typeof current.value === "string") {
      chars += current.value.length;
      if (chars > maxChars) return true;
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (Buffer.isBuffer(current.value) || ArrayBuffer.isView(current.value)) return true;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > SNAPSHOT_MAX_COLLECTION_ENTRIES) return true;
      for (const entry of current.value) pending.push({value: entry, depth: current.depth + 1});
      continue;
    }
    let entries = 0;
    for (const key in current.value) {
      if (!Object.hasOwn(current.value, key)) continue;
      entries += 1;
      if (entries > SNAPSHOT_MAX_COLLECTION_ENTRIES) return true;
      try {
        pending.push({
          value: (current.value as Record<string, unknown>)[key],
          depth: current.depth + 1,
        });
      } catch {
        return true;
      }
    }
  }
  return false;
}

function sanitizeToolResultMessage(
  message: JsonObject,
  tools: readonly Tool[],
  maxBytes: number,
): JsonObject {
  const redacted = (reason: string, text: string): JsonObject => ({
    role: "toolResult",
    ...(typeof message.toolCallId === "string" ? {toolCallId: message.toolCallId} : {}),
    ...(typeof message.toolName === "string" ? {toolName: message.toolName} : {}),
    ...(typeof message.isError === "boolean" ? {isError: message.isError} : {}),
    ...(typeof message.timestamp === "number" ? {timestamp: message.timestamp} : {}),
    content: [{type: "text", text}],
    details: {redacted: true, reason},
  });
  const tool = toolByName(tools, message.toolName);
  if (!tool) {
    return redacted("unknown_tool_result", "[tool result redacted: unknown tool]");
  }

  if (exceedsRedactionInputBudget(message, Math.min(maxBytes, SNAPSHOT_MAX_STRING_CHARS))) {
    return redacted("tool_result_capture_budget", "[tool result redacted: capture budget exceeded]");
  }

  try {
    return tool.redactResultMessage(message as unknown as ToolResultMessage<JsonValue>) as unknown as JsonObject;
  } catch {
    return redacted("tool_result_redaction_failed", "[tool result redacted: redaction failed]");
  }
}

interface BoundedSanitizerState {
  remainingNodes: number;
  remainingStringChars: number;
  readonly seen: WeakSet<object>;
}

export function sanitizeBoundedPromptCacheKey(value: unknown): string {
  if (typeof value !== "string") return sanitizePromptCacheKey(`[bounded:${typeof value}]`);
  const bounded = value.length <= SNAPSHOT_MAX_STRING_CHARS
    ? value
    : `${value.slice(0, SNAPSHOT_MAX_STRING_CHARS)}[chars=${value.length}]`;
  return sanitizePromptCacheKey(bounded);
}

function boundedString(value: string, key: string | undefined, state: BoundedSanitizerState): JsonValue {
  if (isPromptCacheKeyField(key)) return sanitizeBoundedPromptCacheKey(value);
  if (/^data:[^,]+;base64,/i.test(value)) return blobPlaceholder("data_uri", value);
  if (key && BLOB_KEY_PATTERN.test(key) && value.length > 64) return blobPlaceholder(key, value);

  const allowed = Math.max(0, Math.min(
    value.length,
    state.remainingStringChars,
    SNAPSHOT_MAX_STRING_CHARS,
  ));
  const prefix = value.slice(0, allowed);
  state.remainingStringChars -= allowed;
  if (looksLikeBase64Blob(prefix)) return blobPlaceholder(key ?? "base64", value);
  const sanitized = sanitizeString(prefix, key);
  if (typeof sanitized !== "string" || allowed === value.length) return sanitized;
  return `${sanitized}… [truncated ${value.length - allowed} chars]`;
}

function boundedTraceJson(
  value: unknown,
  maxBytes: number,
  key?: string,
  state: BoundedSanitizerState = {
    remainingNodes: SNAPSHOT_MAX_NODES,
    remainingStringChars: Math.max(256, maxBytes),
    seen: new WeakSet<object>(),
  },
  depth = 0,
): JsonValue {
  if (state.remainingNodes <= 0) return truncationMarker();
  state.remainingNodes -= 1;
  if (depth >= SNAPSHOT_MAX_DEPTH) return truncationMarker();
  if (isPromptCacheKeyField(key)) return sanitizeBoundedPromptCacheKey(value);
  if (typeof value === "string") return boundedString(value, key, state);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  if (typeof value !== "object") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return {redacted: true, reason: "binary_value"};
  }
  if (state.seen.has(value)) return {truncated: true, reason: "circular_reference"};
  state.seen.add(value);

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    const count = Math.min(value.length, SNAPSHOT_MAX_COLLECTION_ENTRIES);
    for (let index = 0; index < count && state.remainingNodes > 0; index += 1) {
      result.push(boundedTraceJson(value[index], maxBytes, undefined, state, depth + 1));
    }
    if (result.length < value.length) result.push(truncationMarker(value.length - result.length));
    return result;
  }

  const result = Object.create(null) as JsonObject;
  let count = 0;
  for (const rawKey in value) {
    if (!Object.hasOwn(value, rawKey)) continue;
    if (count >= SNAPSHOT_MAX_COLLECTION_ENTRIES || state.remainingNodes <= 0) break;
    const boundedKey = rawKey.length <= SNAPSHOT_MAX_KEY_CHARS
      ? rawKey
      : `${rawKey.slice(0, SNAPSHOT_MAX_KEY_CHARS)}…`;
    try {
      result[boundedKey] = boundedTraceJson(
        (value as Record<string, unknown>)[rawKey],
        maxBytes,
        rawKey,
        state,
        depth + 1,
      );
    } catch {
      result[boundedKey] = {truncated: true, reason: "property_read_failed"};
    }
    count += 1;
  }
  if (count >= SNAPSHOT_MAX_COLLECTION_ENTRIES || state.remainingNodes <= 0) {
    result._snapshot = truncationMarker();
  }
  return result;
}

function sanitizeTraceMessageBounded(
  message: unknown,
  tools: readonly Tool[],
  maxBytes: number,
  state?: BoundedSanitizerState,
): JsonValue {
  if (!isJsonRecord(message)) return boundedTraceJson(message, maxBytes, undefined, state);
  let next: unknown = message;
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const assistant = Object.create(null) as JsonObject;
    let copied = 0;
    for (const key in message) {
      if (!Object.hasOwn(message, key) || key === "content") continue;
      if (copied >= SNAPSHOT_MAX_COLLECTION_ENTRIES) break;
      try {
        assistant[key] = message[key]!;
      } catch {
        assistant[key] = {truncated: true, reason: "property_read_failed"};
      }
      copied += 1;
    }
    assistant.content = message.content.slice(0, SNAPSHOT_MAX_COLLECTION_ENTRIES).map((block) => {
      if (!isJsonRecord(block) || block.type !== "toolCall" || !isJsonRecord(block.arguments)) return block;
      const withArguments = (args: Record<string, unknown>): JsonObject => ({
        type: "toolCall",
        ...(typeof block.id === "string" ? {id: block.id} : {}),
        ...(typeof block.name === "string" ? {name: block.name} : {}),
        arguments: args as JsonObject,
      });
      const tool = toolByName(tools, block.name);
      if (!tool) return withArguments({redacted: true, reason: "unknown_tool_arguments"});
      if (exceedsRedactionInputBudget(block.arguments, Math.min(maxBytes, SNAPSHOT_MAX_STRING_CHARS))) {
        return withArguments({redacted: true, reason: "tool_arguments_capture_budget"});
      }
      try {
        return withArguments(tool.redactCallArguments(block.arguments));
      } catch {
        return withArguments({redacted: true, reason: "tool_argument_redaction_failed"});
      }
    });
    next = assistant;
  } else if (message.role === "toolResult") {
    next = sanitizeToolResultMessage(message, tools, maxBytes);
  }
  return boundedTraceJson(next, maxBytes, undefined, state);
}

function sanitizeTraceResponseBounded(
  message: unknown,
  tools: readonly Tool[],
  maxBytes: number,
): JsonValue {
  const sanitized = sanitizeTraceMessageBounded(message, tools, maxBytes);
  if (!isJsonRecord(sanitized)
    || sanitized.role !== "assistant"
    || (sanitized.stopReason !== "error" && sanitized.stopReason !== "aborted")) {
    return sanitized;
  }
  const withoutErrorMessage = {...sanitized};
  delete withoutErrorMessage.errorMessage;
  return withoutErrorMessage;
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
  // Error normalization also runs on the observation path. Bound regex work
  // before inspecting provider text so a pathological error cannot add latency.
  const bounded = value.length > ERROR_SCAN_MAX_CHARS ? value.slice(0, ERROR_SCAN_MAX_CHARS) : value;
  const sanitized = redactCredentialShapedText(normalizeErrorWhitespace(cutStructuredErrorPayload(bounded)));
  if (!sanitized) {
    return "Model call failed.";
  }
  if (sanitized.length <= ERROR_MAX_CHARS) {
    return sanitized;
  }
  return `${sanitized.slice(0, ERROR_MAX_CHARS - 1).trimEnd()}…`;
}

function sanitizeErrorCategory(value: string): string {
  // Categories participate in a failure-group index. Keep malformed Error
  // names from exceeding PostgreSQL's index-entry limit or leaking secrets.
  const bounded = value.slice(0, ERROR_CATEGORY_MAX_CHARS);
  return redactCredentialShapedText(normalizeErrorWhitespace(bounded)) || "Error";
}

export function sanitizeTraceError(error: unknown): JsonObject {
  if (error instanceof ProviderRuntimeError) {
    return {
      category: sanitizeErrorCategory(error.failureKind ?? "provider_error"),
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
    category: sanitizeErrorCategory(name),
    message: sanitizeErrorMessage(message),
  };
}

function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateStringToJsonBytes(value: string, maxBytes: number): string {
  const suffix = "… [truncated]";
  if (jsonBytes(value) <= maxBytes) return value;
  if (maxBytes <= jsonBytes(suffix)) return "";

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${value.slice(0, middle).trimEnd()}${suffix}`;
    if (jsonBytes(candidate) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low).trimEnd()}${suffix}`;
}

interface BoundedJsonValue {
  value: JsonValue;
  truncated: boolean;
}

function truncationMarker(omitted?: number): JsonObject {
  return {
    truncated: true,
    reason: SNAPSHOT_TRUNCATION_REASON,
    ...(omitted === undefined ? {} : {omitted}),
  };
}

function fitJsonValue(value: JsonValue, maxBytes: number): BoundedJsonValue {
  if (jsonBytes(value) <= maxBytes) return {value, truncated: false};
  if (typeof value === "string") {
    return {value: truncateStringToJsonBytes(value, maxBytes), truncated: true};
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return {value: truncationMarker(), truncated: true};
  }

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    let truncated = false;
    let usedBytes = 2;
    for (let index = 0; index < value.length; index += 1) {
      const separatorBytes = result.length > 0 ? 1 : 0;
      const remaining = Math.max(64, maxBytes - usedBytes - separatorBytes);
      const fitted = fitJsonValue(value[index]!, remaining);
      const entryBytes = jsonBytes(fitted.value);
      if (usedBytes + separatorBytes + entryBytes > maxBytes) {
        truncated = true;
        break;
      }
      result.push(fitted.value);
      usedBytes += separatorBytes + entryBytes;
      truncated ||= fitted.truncated;
    }
    if (result.length < value.length) {
      truncated = true;
      const marker = truncationMarker(value.length - result.length);
      if (jsonBytes([...result, marker]) <= maxBytes) result.push(marker);
    }
    return {value: result, truncated};
  }

  const result = Object.create(null) as JsonObject;
  let truncated = false;
  let usedBytes = 2;
  const entries = Object.entries(value);
  for (let index = 0; index < entries.length; index += 1) {
    const [key, entry] = entries[index]!;
    const separatorBytes = index > 0 ? 1 : 0;
    const keyBytes = jsonBytes(key) + 1;
    const remaining = Math.max(64, maxBytes - usedBytes - separatorBytes - keyBytes);
    const fitted = fitJsonValue(entry, remaining);
    const entryBytes = jsonBytes(fitted.value);
    if (usedBytes + separatorBytes + keyBytes + entryBytes > maxBytes) {
      truncated = true;
      break;
    }
    result[key] = fitted.value;
    usedBytes += separatorBytes + keyBytes + entryBytes;
    truncated ||= fitted.truncated;
  }
  if (Object.keys(result).length < entries.length) {
    truncated = true;
    const marker = truncationMarker(entries.length - Object.keys(result).length);
    if (jsonBytes({...result, _snapshot: marker}) <= maxBytes) result._snapshot = marker;
  }
  return {value: result, truncated};
}

function boundedMessages(
  messages: readonly unknown[],
  tools: readonly Tool[],
  maxBytes: number,
): BoundedJsonValue {
  const newestFirst: JsonValue[] = [];
  const state: BoundedSanitizerState = {
    remainingNodes: SNAPSHOT_MAX_NODES,
    remainingStringChars: Math.max(256, maxBytes),
    seen: new WeakSet<object>(),
  };
  let truncated = false;
  let usedBytes = 2;
  const firstCandidate = Math.max(0, messages.length - SNAPSHOT_MAX_COLLECTION_ENTRIES);
  for (let index = messages.length - 1; index >= firstCandidate && state.remainingNodes > 0; index -= 1) {
    const separatorBytes = newestFirst.length > 0 ? 1 : 0;
    const remaining = Math.max(256, maxBytes - usedBytes - separatorBytes);
    const fitted = fitJsonValue(sanitizeTraceMessageBounded(messages[index], tools, remaining, state), remaining);
    const entryBytes = jsonBytes(fitted.value);
    if (usedBytes + separatorBytes + entryBytes > maxBytes) {
      truncated = true;
      break;
    }
    newestFirst.push(fitted.value);
    usedBytes += separatorBytes + entryBytes;
    truncated ||= fitted.truncated;
  }
  const messagesInOrder = newestFirst.reverse();
  const omitted = messages.length - messagesInOrder.length;
  if (omitted > 0) {
    truncated = true;
    const marker = truncationMarker(omitted);
    if (jsonBytes(marker) + usedBytes + 1 <= maxBytes) messagesInOrder.unshift(marker);
  }
  return {value: messagesInOrder, truncated};
}

function contextSectionDescriptors(input: LlmModelCallObservation): JsonValue {
  return (input.request.trace?.llmContextSections ?? [])
    .slice(0, SNAPSHOT_MAX_COLLECTION_ENTRIES)
    .map((section) => ({
      name: section.name,
      ...(section.source ? {source: section.source} : {}),
      ...(section.label ? {label: section.label} : {}),
      ...(section.contentPreview ? {contentPreview: section.contentPreview} : {}),
      ...(section.contentChars === undefined ? {} : {contentChars: section.contentChars}),
      ...(section.estimatedTokens === undefined ? {} : {estimatedTokens: section.estimatedTokens}),
      ...(section.dumpChars === undefined ? {} : {dumpChars: section.dumpChars}),
    }));
}

function buildSnapshotWithinBudget(input: LlmModelCallObservation, budget: number): {
  requestJson: JsonObject;
  responseJson?: JsonValue;
  truncated: boolean;
} {
  const request = input.request;
  const context = request.context;
  const promptCacheKey = request.promptCacheKey === undefined
    ? undefined
    : sanitizeBoundedPromptCacheKey(request.promptCacheKey);
  const systemPrompt = context.systemPrompt
    ? fitJsonValue(boundedTraceJson(context.systemPrompt, Math.floor(budget * 0.24)), Math.floor(budget * 0.24))
    : undefined;
  const messages = boundedMessages(context.messages, input.tools, Math.floor(budget * 0.43));
  const tools = fitJsonValue(
    boundedTraceJson(context.tools ?? [], Math.floor(budget * 0.09)),
    Math.floor(budget * 0.09),
  );
  const sections = fitJsonValue(
    boundedTraceJson(contextSectionDescriptors(input), Math.floor(budget * 0.08)),
    Math.floor(budget * 0.08),
  );
  const response = input.response
    ? fitJsonValue(
        sanitizeTraceResponseBounded(input.response, input.tools, Math.floor(budget * 0.14)),
        Math.floor(budget * 0.14),
      )
    : undefined;
  const requestJson: JsonObject = {
    provider: request.providerName,
    model: request.modelId,
    ...(promptCacheKey !== undefined ? {promptCacheKey} : {}),
    ...(systemPrompt ? {systemPrompt: systemPrompt.value} : {}),
    messages: messages.value,
    tools: tools.value,
    ...(request.trace?.llmContextSections?.length ? {llmContextSections: sections.value} : {}),
  };

  return {
    requestJson,
    ...(response ? {responseJson: response.value} : {}),
    truncated: Boolean(
      systemPrompt?.truncated
      || messages.truncated
      || tools.truncated
      || sections.truncated
      || response?.truncated
    ),
  };
}

export interface SanitizedModelCallSnapshot {
  requestJson: JsonObject;
  responseJson?: JsonValue;
  bytes: number;
  truncated: boolean;
}

/**
 * Builds one bounded forensic snapshot. The provider-bound system prompt is the
 * sole full copy of LLM context; section diagnostics intentionally keep only
 * metadata and previews so tracing cannot multiply context payloads.
 */
export function buildSanitizedModelCallSnapshot(
  input: LlmModelCallObservation,
  maxBytes: number,
): SanitizedModelCallSnapshot {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_SNAPSHOT_BYTES) {
    throw new Error(`Model call snapshot max bytes must be at least ${MIN_SNAPSHOT_BYTES}.`);
  }

  let snapshot = buildSnapshotWithinBudget(input, Math.floor(maxBytes * 0.9));
  let bytes = jsonBytes({request: snapshot.requestJson, response: snapshot.responseJson ?? null});
  if (bytes > maxBytes) {
    snapshot = buildSnapshotWithinBudget(input, Math.floor(maxBytes * 0.7));
    bytes = jsonBytes({request: snapshot.requestJson, response: snapshot.responseJson ?? null});
  }
  if (bytes > maxBytes) {
    const requestJson: JsonObject = {
      provider: input.request.providerName,
      model: input.request.modelId,
      _snapshot: truncationMarker(),
    };
    return {
      requestJson,
      bytes: jsonBytes({request: requestJson, response: null}),
      truncated: true,
    };
  }

  return {
    requestJson: snapshot.requestJson,
    ...(snapshot.responseJson === undefined ? {} : {responseJson: snapshot.responseJson}),
    bytes,
    truncated: snapshot.truncated,
  };
}
