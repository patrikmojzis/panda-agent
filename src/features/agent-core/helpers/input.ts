import type { SystemMessage } from "../types.js";
import type { UserMessage } from "@mariozechner/pi-ai";

export function stringToUserMessage(message: string): UserMessage {
  return {
    role: "user",
    content: message,
    timestamp: Date.now(),
  };
}

export function stringToSystemMessage(message: string): SystemMessage {
  return {
    role: "system",
    content: message,
  };
}
