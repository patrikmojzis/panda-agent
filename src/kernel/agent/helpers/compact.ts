import type {Message} from "@mariozechner/pi-ai";
import {COMPACT_SUMMARY_PREFIX, renderCompactSummaryMessage,} from "../../../prompts/runtime/compaction.js";

export {COMPACT_SUMMARY_PREFIX} from "../../../prompts/runtime/compaction.js";

export function buildCompactSummaryMessage(summary: string): string {
  return renderCompactSummaryMessage(summary);
}

export function stripCompactSummaryPrefix(text: string): string {
  if (!text.startsWith(COMPACT_SUMMARY_PREFIX)) {
    return text;
  }

  return text.slice(COMPACT_SUMMARY_PREFIX.length).trimStart();
}

export function isCompactSummaryMessage(message: Message): boolean {
  return message.role === "user"
    && typeof message.content === "string"
    && message.content.startsWith(COMPACT_SUMMARY_PREFIX);
}
