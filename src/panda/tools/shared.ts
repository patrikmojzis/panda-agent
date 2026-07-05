import {ToolError} from "../../kernel/agent/exceptions.js";
import {joinMessageTextParts} from "../../kernel/agent/helpers/message-text.js";
import {stringifyUnknown} from "../../kernel/agent/helpers/stringify.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";

export interface AgentSessionToolScope {
  agentKey: string;
  sessionId: string;
  identityId?: string;
  messageId?: string;
}

export interface SessionToolScope {
  sessionId: string;
  identityId?: string;
  messageId?: string;
}

function readCurrentInputField(context: unknown, field: string): string | undefined {
  if (!isRecord(context) || !isRecord(context.currentInput)) {
    return undefined;
  }

  return trimToUndefined(context.currentInput[field]);
}

function readCurrentInputIdentityId(context: unknown): string | undefined {
  return readCurrentInputField(context, "identityId");
}

function readCurrentInputMessageId(context: unknown): string | undefined {
  return readCurrentInputField(context, "messageId");
}

/**
 * Reads the common Panda tool scope carried by runtime session context.
 */
export function readRequiredAgentSessionToolScope(context: unknown, message: string): AgentSessionToolScope {
  const agentKey = isRecord(context) ? trimToUndefined(context.agentKey) : undefined;
  const sessionId = isRecord(context) ? trimToUndefined(context.sessionId) : undefined;
  if (
    !agentKey
    || !sessionId
  ) {
    throw new ToolError(message);
  }

  const identityId = readCurrentInputIdentityId(context);
  const messageId = readCurrentInputMessageId(context);
  return {
    agentKey,
    sessionId,
    ...(identityId ? {identityId} : {}),
    ...(messageId ? {messageId} : {}),
  };
}

/**
 * Reads the session-only tool scope for tools that do not need agent access.
 */
export function readRequiredSessionToolScope(context: unknown, message: string): SessionToolScope {
  const sessionId = isRecord(context) ? trimToUndefined(context.sessionId) : undefined;
  if (
    !sessionId
  ) {
    throw new ToolError(message);
  }

  const identityId = readCurrentInputIdentityId(context);
  const messageId = readCurrentInputMessageId(context);
  return {
    sessionId,
    ...(identityId ? {identityId} : {}),
    ...(messageId ? {messageId} : {}),
  };
}

/**
 * Narrows model-facing tool detail payloads before they cross async/runtime
 * boundaries where a bad value would otherwise be persisted as trusted JSON.
 */
export function requireJsonObject(value: unknown, message: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new ToolError(message);
  }
  return value;
}

/**
 * Builds a text-first tool payload that mirrors `details` as pretty JSON.
 */
export function buildJsonToolPayload(details: JsonObject): ToolResultPayload {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(details, null, 2),
    }],
    details,
  };
}

/**
 * Builds a tool payload with explicit text while still preserving `details`.
 */
export function buildTextToolPayload(text: string, details: JsonObject): ToolResultPayload {
  return {
    content: [{
      type: "text",
      text,
    }],
    details,
  };
}

/**
 * Serializes completed background tool payloads into the durable tool-job
 * result shape used by `background_job_wait`.
 */
export function serializeToolResultForBackgroundJob(payload: ToolResultPayload): JsonObject {
  const result: JsonObject = {
    contentText: joinMessageTextParts(payload.content),
  };

  if (payload.details !== undefined) {
    result.details = requireJsonObject(
      payload.details,
      "Background tool result details must be a JSON object.",
    );
  }

  return result;
}

/**
 * Re-throws `ToolError` instances unchanged and wraps other failures in a
 * regular `ToolError` using the best available message.
 */
export function rethrowAsToolError(error: unknown): never {
  if (error instanceof ToolError) {
    throw error;
  }

  throw new ToolError(stringifyUnknown(error, {preferErrorMessage: true}));
}
