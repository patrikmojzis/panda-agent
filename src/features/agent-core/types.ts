import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

export type { ProviderName } from "./provider.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type ToolResultContent = ToolResultMessage<JsonValue>["content"];
export type ToolResultPayload = Pick<ToolResultMessage<JsonValue>, "content" | "details">;

export interface ToolProgressEvent<TDetails extends JsonObject = JsonObject> {
  type: "tool_progress";
  toolCallId: string;
  toolName: string;
  details: TDetails;
  timestamp: number;
}

export type ThreadRunEvent =
  | AssistantMessage
  | ToolResultMessage<JsonValue>
  | ToolProgressEvent;

export type ThreadStreamEvent =
  | AssistantMessageEvent
  | ToolResultMessage<JsonValue>
  | ToolProgressEvent;
