import type {Message} from "@mariozechner/pi-ai";

import {formatToolResultFallback} from "../agent/tool.js";

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
