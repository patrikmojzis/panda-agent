import type { AssistantMessage, Message } from "@mariozechner/pi-ai";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type InputItem = Message | Record<string, unknown>;
export type ResponseOutputItemLike = Record<string, unknown>;
export type ResponseLike =
  | AssistantMessage
  | (Record<string, unknown> & {
      output?: ResponseOutputItemLike[];
    });

export type NativeToolDefinition = Record<string, unknown>;
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
