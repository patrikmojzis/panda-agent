import type {Message} from "@mariozechner/pi-ai";

import {
    formatToolCallFallback,
    formatToolResultFallback,
    type Tool,
    type ToolResultMessage,
} from "../../kernel/agent/index.js";
import {summarizeMessageText} from "../../personas/panda/message-preview.js";
import type {ThreadMessageMetadata} from "../../domain/threads/runtime/index.js";

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
      const body = text.trim();
      if (!body) {
        return;
      }

      entries.push({
        role: "assistant",
        title: metadata.source === "assistant" ? "agent" : metadata.source,
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
