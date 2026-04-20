import {ToolError} from "../../kernel/agent/exceptions.js";
import {stringifyUnknown} from "../../kernel/agent/helpers/stringify.js";
import type {JsonObject, ToolResultPayload} from "../../kernel/agent/types.js";

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
 * Re-throws `ToolError` instances unchanged and wraps other failures in a
 * regular `ToolError` using the best available message.
 */
export function rethrowAsToolError(error: unknown): never {
  if (error instanceof ToolError) {
    throw error;
  }

  throw new ToolError(stringifyUnknown(error, {preferErrorMessage: true}));
}
