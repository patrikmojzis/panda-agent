import type { Message } from "@mariozechner/pi-ai";

import {
  formatToolCallFallback,
  formatToolResultFallback,
  type Tool,
  type ToolResultMessage,
} from "../agent-core/index.js";
import type { ThreadMessageMetadata, ThreadMessageRecord } from "../thread-runtime/index.js";

export type TranscriptEntryRole = "assistant" | "user" | "tool" | "meta" | "error";

export interface TranscriptEntryView {
  role: TranscriptEntryRole;
  title: string;
  body: string;
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sourceLabel(metadata: ThreadMessageMetadata): string {
  if (!metadata.channelId) {
    return metadata.source;
  }

  return `${metadata.source}:${metadata.channelId}`;
}

export function summarizeMessageText(message: Message): string {
  switch (message.role) {
    case "user":
      if (typeof message.content === "string") {
        return message.content.trim();
      }

      return message.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

    case "assistant":
      return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

    case "toolResult":
      return formatToolResultFallback(message);

    default:
      return JSON.stringify(message);
  }
}

export function renderTranscriptEntries(
  message: Message,
  metadata: ThreadMessageMetadata,
  tools: readonly Tool[] = [],
): TranscriptEntryView[] {
  if (message.role === "user") {
    return [{
      role: "user",
      title: sourceLabel(metadata),
      body: summarizeMessageText(message) || "(empty message)",
    }];
  }

  if (message.role === "assistant") {
    const entries: TranscriptEntryView[] = [];
    let text = "";

    const flushText = (): void => {
      const body = normalizeInlineText(text);
      if (!body) {
        return;
      }

      entries.push({
        role: "assistant",
        title: metadata.source === "assistant" ? "panda" : metadata.source,
        body,
      });
      text = "";
    };

    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        text += block.text;
        continue;
      }

      if (block.type === "toolCall") {
        flushText();
        const tool = tools.find((candidate) => candidate.name === block.name);
        entries.push({
          role: "tool",
          title: block.name,
          body: tool?.formatCall(block.arguments ?? {}) ?? formatToolCallFallback(block.arguments ?? {}),
        });
      }
    }

    flushText();
    return entries;
  }

  if (message.role === "toolResult") {
    const tool = tools.find((candidate) => candidate.name === message.toolName);
    return [{
      role: "tool",
      title: message.toolName,
      body: tool?.formatResult(message as ToolResultMessage) ?? formatToolResultFallback(message),
    }];
  }

  return [{
    role: "meta",
    title: metadata.source,
    body: JSON.stringify(message, null, 2),
  }];
}

export function renderStoredTranscriptEntries(
  record: ThreadMessageRecord,
  tools: readonly Tool[] = [],
): TranscriptEntryView[] {
  return renderTranscriptEntries(record.message, record, tools);
}
