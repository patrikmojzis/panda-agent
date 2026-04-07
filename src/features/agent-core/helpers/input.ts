import type { InputItem } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function responseToRecord(item: unknown): InputItem {
  if (isRecord(item)) {
    return { ...item };
  }

  if (item && typeof item === "object" && "model_dump" in item && typeof item.model_dump === "function") {
    const dumped = item.model_dump();
    if (isRecord(dumped)) {
      return dumped;
    }
  }

  throw new TypeError(`Cannot convert item to record: ${String(item)}`);
}

export function stringToUserMessage(message: string): InputItem {
  return {
    role: "user",
    content: message,
    timestamp: Date.now(),
  };
}

export function toApiItems(items: InputItem[]): InputItem[] {
  return items.map((item) => responseToRecord(item));
}
