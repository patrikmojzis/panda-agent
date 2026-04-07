import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool as PiTool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

import type { Agent } from "../agent.js";
import { formatParameters } from "../helpers/schema.js";
import type { InputItem, NativeToolDefinition, ResponseOutputItemLike } from "../types.js";
import type { Tool } from "../tool.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractLegacyTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (!isRecord(part)) {
      return [];
    }

    const text = getString(part.text);
    if (!text) {
      return [];
    }

    switch (part.type) {
      case "input_text":
      case "output_text":
      case "text":
        return [text];
      default:
        return [];
    }
  });
}

function isTextContent(value: unknown): value is TextContent {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageContent(value: unknown): value is ImageContent {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  );
}

function isPiUserMessage(value: unknown): value is UserMessage {
  return isRecord(value) && value.role === "user";
}

function isPiAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    isRecord(value) &&
    value.role === "assistant" &&
    Array.isArray(value.content) &&
    typeof value.provider === "string" &&
    typeof value.model === "string"
  );
}

function isPiToolResultMessage(value: unknown): value is ToolResultMessage {
  return (
    isRecord(value) &&
    value.role === "toolResult" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    Array.isArray(value.content)
  );
}

function normalizeUserContent(content: unknown): UserMessage["content"] {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content) && content.every((part) => isTextContent(part) || isImageContent(part))) {
    return content as UserMessage["content"];
  }

  const textParts = extractLegacyTextParts(content);
  if (textParts.length === 0) {
    return "";
  }

  return textParts.map((text) => ({ type: "text", text }));
}

function legacyAssistantMessage(item: Record<string, unknown>): AssistantMessage | null {
  if (item.type === "function_call") {
    const name = getString(item.name);
    const callId = getString(item.call_id);
    const rawArgs = getString(item.arguments) ?? "{}";
    if (!name || !callId) {
      return null;
    }

    let argumentsValue: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawArgs);
      argumentsValue = isRecord(parsed) ? parsed : {};
    } catch {
      argumentsValue = {};
    }

    return {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name, arguments: argumentsValue }],
      api: "openai-responses",
      provider: "legacy",
      model: "legacy",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
    };
  }

  const textParts = extractLegacyTextParts(item.content);
  if (textParts.length === 0) {
    return null;
  }

  return {
    role: "assistant",
    content: textParts.map((text) => ({ type: "text", text })),
    api: "openai-responses",
    provider: "legacy",
    model: "legacy",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
  };
}

function legacyToolResultMessage(item: Record<string, unknown>): ToolResultMessage | null {
  if (item.type !== "function_call_output") {
    return null;
  }

  const toolCallId = getString(item.call_id);
  if (!toolCallId) {
    return null;
  }

  const output = getString(item.output) ?? "";

  return {
    role: "toolResult",
    toolCallId,
    toolName: getString(item.name) ?? "tool",
    content: [{ type: "text", text: output }],
    isError: output.startsWith("[Error] "),
    timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
  };
}

function toPiMessage(item: InputItem): Message | null {
  if (!isRecord(item)) {
    return null;
  }

  if (isPiUserMessage(item)) {
    return {
      ...item,
      content: normalizeUserContent(item.content),
      timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
    };
  }

  if (isPiAssistantMessage(item)) {
    return item;
  }

  if (isPiToolResultMessage(item)) {
    return {
      ...item,
      timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
    };
  }

  if (item.role === "user") {
    return {
      role: "user",
      content: normalizeUserContent(item.content),
      timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
    };
  }

  if (item.role === "assistant") {
    return legacyAssistantMessage(item);
  }

  if (item.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: String(item.toolCallId ?? ""),
      toolName: String(item.toolName ?? "tool"),
      content: Array.isArray(item.content) ? (item.content as ToolResultMessage["content"]) : [],
      isError: item.isError === true,
      timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
    };
  }

  return legacyAssistantMessage(item) ?? legacyToolResultMessage(item);
}

function extractSystemPrompt(item: InputItem): string[] {
  if (!isRecord(item) || item.role !== "system") {
    return [];
  }

  return extractLegacyTextParts(item.content);
}

function isToolInstance(tool: Tool | NativeToolDefinition): tool is Tool {
  return tool instanceof Object && "toolDefinition" in tool;
}

export function buildPiTools(tools: Array<Tool | NativeToolDefinition>): PiTool[] {
  return tools.flatMap((tool) => {
    const definition = isToolInstance(tool) ? tool.toolDefinition : tool;
    if (!isRecord(definition)) {
      return [];
    }

    if (
      definition.type === "function" &&
      typeof definition.name === "string" &&
      typeof definition.description === "string" &&
      isRecord(definition.parameters)
    ) {
      return [{
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters as PiTool["parameters"],
      }];
    }

    if (
      typeof definition.name === "string" &&
      typeof definition.description === "string" &&
      isRecord(definition.parameters)
    ) {
      return [{
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters as PiTool["parameters"],
      }];
    }

    return [];
  });
}

export function createStructuredOutputInstruction(agent: Agent): string | null {
  if (!agent.outputSchema) {
    return null;
  }

  const schema = JSON.stringify(formatParameters(agent.outputSchema, `${agent.name}_output`), null, 2);
  return [
    "Return only valid JSON.",
    "Do not wrap the JSON in Markdown fences.",
    "The JSON must match this schema exactly:",
    "```json",
    schema,
    "```",
  ].join("\n");
}

export function buildConversationContext(options: {
  agent: Agent;
  input: InputItem[];
  llmContextDump?: string;
}): Context {
  const systemParts = options.input.flatMap((item) => extractSystemPrompt(item));
  const messages = options.input.flatMap((item) => {
    const message = toPiMessage(item);
    return message ? [message] : [];
  });

  const structuredOutput = createStructuredOutputInstruction(options.agent);
  const systemPrompt = [
    options.agent.instructions,
    structuredOutput,
    options.llmContextDump,
    ...systemParts,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");

  const tools = buildPiTools(options.agent.tools);

  return {
    systemPrompt: systemPrompt || undefined,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

export function assistantMessageToOutputItems(message: AssistantMessage): ResponseOutputItemLike[] {
  const outputs: ResponseOutputItemLike[] = [];
  let textParts: string[] = [];

  const flushText = (): void => {
    if (textParts.length === 0) {
      return;
    }

    outputs.push({
      type: "message",
      role: "assistant",
      content: textParts.map((text) => ({ type: "output_text", text })),
    });
    textParts = [];
  };

  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text) {
        textParts.push(block.text);
      }
      continue;
    }

    if (block.type === "toolCall") {
      flushText();
      outputs.push({
        type: "function_call",
        name: block.name,
        arguments: JSON.stringify(block.arguments ?? {}),
        call_id: block.id,
      });
    }
  }

  flushText();
  return outputs;
}

export function collectAssistantToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

export function buildToolResultMessage(options: {
  toolCall: ToolCall;
  output: string;
  isError: boolean;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: options.toolCall.id,
    toolName: options.toolCall.name,
    content: [{ type: "text", text: options.output }],
    isError: options.isError,
    timestamp: Date.now(),
  };
}
