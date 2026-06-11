import type {Message, ToolResultMessage} from "@earendil-works/pi-ai";

import {
    formatToolCallFallback,
    formatToolResultFallback,
    type Tool,
} from "../../kernel/agent/tool.js";
import {joinMessageTextParts} from "../../kernel/agent/helpers/message-text.js";
import type {ThreadMessageMetadata} from "../../domain/threads/runtime/types.js";

interface TranscriptEntryView {
  role: TranscriptEntryRole;
  title: string;
  body: string;
}

type TranscriptEntryRole = "assistant" | "user" | "tool" | "meta" | "error";

function sourceLabel(metadata: ThreadMessageMetadata): string {
  if (!metadata.channelId) {
    return metadata.source;
  }

  return `${metadata.source}:${metadata.channelId}`;
}

function summarizeMessageText(message: Message): string {
  switch (message.role) {
    case "user":
      if (typeof message.content === "string") {
        return message.content.trim();
      }

      return joinMessageTextParts(message.content, "\n");

    case "assistant":
      return joinMessageTextParts(message.content, "\n");

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
    const textBlocks: Array<{type: string; text?: unknown}> = [];

    const flushText = (): void => {
      const body = joinMessageTextParts(textBlocks, "\n");
      if (!body) {
        textBlocks.length = 0;
        return;
      }

      entries.push({
        role: "assistant",
        title: metadata.source === "assistant" ? "agent" : metadata.source,
        body,
      });
      textBlocks.length = 0;
    };

    for (const block of message.content) {
      if (block.type === "text") {
        textBlocks.push(block);
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
