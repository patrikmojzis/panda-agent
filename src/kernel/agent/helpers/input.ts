import type {UserMessage} from "@earendil-works/pi-ai";

export function stringToUserMessage(message: string): UserMessage {
  return {
    role: "user",
    content: message,
    timestamp: Date.now(),
  };
}
