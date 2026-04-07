import type {
  AssistantMessageEvent,
  Message,
  ThinkingLevel,
} from "@mariozechner/pi-ai";

export type { ProviderName } from "./provider.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface ToolDefinition {
  type?: "function";
  name: string;
  description: string;
  parameters: JsonObject;
}

export interface MessageTextOutput {
  type: "message";
  role: "assistant";
  content: Array<{
    type: "output_text";
    text: string;
  }>;
}

export interface FunctionCallOutput {
  type: "function_call";
  name: string;
  arguments: string;
  call_id: string;
}

export interface FunctionCallResultOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface ToolProgressOutput {
  type: "tool_progress";
  call_id: string;
  name: string;
  output: JsonObject;
}

export type InputItem = SystemMessage | Message;
export type ResponseOutputItemLike =
  | MessageTextOutput
  | FunctionCallOutput
  | FunctionCallResultOutput
  | ToolProgressOutput;
export type ThreadStreamEvent = AssistantMessageEvent | ResponseOutputItemLike;

export type ReasoningEffort = ThinkingLevel;
