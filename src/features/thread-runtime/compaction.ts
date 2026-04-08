import type { Message } from "@mariozechner/pi-ai";

import { formatToolCallFallback, formatToolResultFallback } from "../agent-core/index.js";
import { buildCompactSummaryMessage } from "../agent-core/helpers/compact.js";
import { estimateTokensFromString } from "../agent-core/helpers/token-count.js";
import { stringToUserMessage } from "../agent-core/helpers/input.js";
import { stripCompactSummaryPrefix } from "../agent-core/helpers/compact.js";
import type { JsonObject, JsonValue } from "../agent-core/types.js";
import type { ThreadMessageRecord } from "./types.js";

export const DEFAULT_COMPACT_PRESERVED_USER_TURNS = 3;
const TOOL_TEXT_LIMIT = 4_000;

export interface CompactBoundaryMetadata extends JsonObject {
  kind: "compact_boundary";
  compactedUpToSequence: number;
  preservedTailUserTurns: number;
  trigger: "manual" | "auto";
  tokensBefore: number | null;
  tokensAfter: number | null;
}

export interface CompactTranscriptSplit {
  summaryRecords: readonly ThreadMessageRecord[];
  preservedTail: readonly ThreadMessageRecord[];
  compactedUpToSequence: number;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 12)).trimEnd()}\n[truncated]`;
}

function isCompactBoundaryMetadata(value: JsonValue | undefined): value is CompactBoundaryMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.kind === "compact_boundary"
    && typeof record.compactedUpToSequence === "number"
    && typeof record.preservedTailUserTurns === "number"
    && (record.trigger === "manual" || record.trigger === "auto");
}

export function isCompactBoundaryRecord(
  record: ThreadMessageRecord,
): record is ThreadMessageRecord & { metadata: CompactBoundaryMetadata } {
  return record.source === "compact" && isCompactBoundaryMetadata(record.metadata);
}

export function projectTranscriptForRun(
  transcript: readonly ThreadMessageRecord[],
): readonly ThreadMessageRecord[] {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const record = transcript[index];
    if (!record || !isCompactBoundaryRecord(record)) {
      continue;
    }

    const boundary = record;
    const tail = transcript.filter((record) => {
      return record.id !== boundary.id
        && record.sequence > boundary.metadata.compactedUpToSequence;
    });

    return [boundary, ...tail];
  }

  return transcript;
}

export function splitTranscriptForCompaction(
  transcript: readonly ThreadMessageRecord[],
  preservedUserTurns = DEFAULT_COMPACT_PRESERVED_USER_TURNS,
): CompactTranscriptSplit | null {
  const userMessageIndexes: number[] = [];

  for (const [index, record] of transcript.entries()) {
    if (record.source === "compact") {
      continue;
    }

    if (record.message.role === "user") {
      userMessageIndexes.push(index);
    }
  }

  if (userMessageIndexes.length <= preservedUserTurns) {
    return null;
  }

  const preservedStartIndex = userMessageIndexes[userMessageIndexes.length - preservedUserTurns];
  if (preservedStartIndex === undefined || preservedStartIndex <= 0) {
    return null;
  }

  const summaryRecords = transcript.slice(0, preservedStartIndex);
  const preservedTail = transcript.slice(preservedStartIndex);
  const lastSummarized = summaryRecords[summaryRecords.length - 1];

  if (!lastSummarized) {
    return null;
  }

  return {
    summaryRecords,
    preservedTail,
    compactedUpToSequence: lastSummarized.sequence,
  };
}

function renderUserMessage(message: Extract<Message, { role: "user" }>): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }

  return message.content
    .map((block) => {
      if (block.type === "text") {
        return block.text.trim();
      }

      if (block.type === "image") {
        return "[image attached]";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function renderAssistantMessage(message: Extract<Message, { role: "assistant" }>): string {
  const parts: string[] = [];

  for (const block of message.content) {
    if (block.type === "text" && block.text.trim()) {
      parts.push(block.text.trim());
      continue;
    }

    if (block.type === "toolCall") {
      parts.push(
        [
          `Tool call: ${block.name}`,
          `Arguments:\n${formatToolCallFallback(block.arguments ?? {})}`,
        ].join("\n"),
      );
    }
  }

  return parts.join("\n\n").trim();
}

function renderToolResultMessage(message: Extract<Message, { role: "toolResult" }>): string {
  return truncateText(formatToolResultFallback(message), TOOL_TEXT_LIMIT);
}

function renderRecordBody(record: ThreadMessageRecord): string {
  if (record.source === "compact" && record.message.role === "user") {
    return stripCompactSummaryPrefix(renderUserMessage(record.message));
  }

  switch (record.message.role) {
    case "user":
      return renderUserMessage(record.message);
    case "assistant":
      return renderAssistantMessage(record.message);
    case "toolResult":
      return renderToolResultMessage(record.message);
    default:
      return JSON.stringify(record.message, null, 2);
  }
}

export function formatTranscriptForCompaction(
  transcript: readonly ThreadMessageRecord[],
): string {
  return transcript.map((record) => {
    const label = record.source === "compact"
      ? "prior_compact_summary"
      : `${record.message.role} source=${record.source}`;
    const body = renderRecordBody(record) || "(empty)";
    return `[${record.sequence}] ${label}\n${body}`;
  }).join("\n\n");
}

export function getCompactPrompt(customInstructions?: string, maxSummaryTokens?: number): string {
  let prompt = [
    "CRITICAL: Respond with plain text only. Do not call tools.",
    "You are compacting an earlier portion of a coding-assistant conversation so the session can continue in the same repository.",
    "The most recent messages will be kept verbatim after this summary. Summarize only the older messages you were given.",
    "Optimize for continuity, not elegance. Preserve exact details that are likely to matter for continuing the work:",
    "- exact file paths",
    "- exact function, class, type, variable, and command names",
    "- exact error messages and test failures when important",
    "- user instructions, preferences, and prohibitions",
    "- key tool results and environment assumptions",
    "- current status, unfinished work, and next steps",
    "Compress aggressively:",
    "- omit small talk",
    "- merge repeated exploration",
    "- summarize bulky logs unless exact text matters",
    "- do not repeat information that is already obvious",
    ...(maxSummaryTokens
      ? [`- keep the final summary under roughly ${maxSummaryTokens} tokens`]
      : []),
    "Output exactly this format:",
    "<summary>",
    "Intent:",
    "- ...",
    "",
    "Key context:",
    "- ...",
    "",
    "Files and code:",
    "- /abs/path/to/file.ts - why it matters; exact symbols touched",
    "",
    "Commands and outputs:",
    "- `...` - key result",
    "",
    "Failures and fixes:",
    "- ...",
    "",
    "User guidance:",
    "- ...",
    "",
    "Pending work:",
    "- ...",
    "",
    "Open questions:",
    "- ...",
    "</summary>",
  ].join("\n");

  if (customInstructions?.trim()) {
    prompt += `\n\nAdditional instructions:\n${customInstructions.trim()}`;
  }

  return prompt;
}

export function parseCompactSummary(raw: string): string {
  const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();
  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i);
  const summary = summaryMatch?.[1] ?? withoutAnalysis;
  return summary.trim();
}

export function estimateMessageTokens(message: Message): number {
  return estimateTokensFromString(JSON.stringify(message));
}

export function estimateTranscriptTokens(transcript: readonly ThreadMessageRecord[]): number {
  return transcript.reduce((sum, record) => sum + estimateMessageTokens(record.message), 0);
}

export function createCompactBoundaryMessage(summary: string): ReturnType<typeof stringToUserMessage> {
  return stringToUserMessage(buildCompactSummaryMessage(summary));
}
