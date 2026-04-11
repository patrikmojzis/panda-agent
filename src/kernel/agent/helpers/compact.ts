import type {Message} from "@mariozechner/pi-ai";

export const COMPACT_SUMMARY_PREFIX = "[Conversation compacted. Summary of earlier context follows.]";

export function buildCompactSummaryMessage(summary: string): string {
  const trimmed = summary.trim();
  return trimmed
    ? `${COMPACT_SUMMARY_PREFIX}\n\n${trimmed}`
    : COMPACT_SUMMARY_PREFIX;
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
