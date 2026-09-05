import type {ThreadMessageRecord} from "../../kernel/transcript/types.js";
import type {JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";

/** Renders bounded text for channel history without exposing unrelated message content. */
export function textPreview(text: string | undefined, maxChars = 1200): JsonObject {
  const value = text?.trim();
  if (!value) {
    return {};
  }

  if (value.length <= maxChars) {
    return {text: value};
  }

  return {
    text: `${value.slice(0, maxChars)}...`,
    truncated: true,
  };
}

/** Reads durable history text, ignoring malformed and non-text content blocks. */
export function extractHistoryMessageText(record: Pick<ThreadMessageRecord, "message">): string | undefined {
  const content = (record.message as {content?: unknown}).content;
  if (typeof content === "string") {
    return trimToUndefined(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      return [];
    }
    const text = part.text.trim();
    return text ? [text] : [];
  });
  return trimToUndefined(parts.join("\n\n"));
}
