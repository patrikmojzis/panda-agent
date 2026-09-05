import {ToolError} from "../../kernel/agent/exceptions.js";
import {joinMessageTextParts} from "../../kernel/agent/helpers/message-text.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";

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
