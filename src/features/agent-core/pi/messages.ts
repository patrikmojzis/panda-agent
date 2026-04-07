import type {
  AssistantMessage,
  Context,
  Message,
  Tool as PiTool,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

import type { Agent } from "../agent.js";
import { formatParameters } from "../helpers/schema.js";
import type { InputItem, MessageTextOutput, ResponseOutputItemLike, SystemMessage, ToolDefinition } from "../types.js";
import { Tool } from "../tool.js";

function isSystemMessage(item: InputItem): item is SystemMessage {
  return item.role === "system";
}

function isToolInstance(tool: Tool | ToolDefinition): tool is Tool {
  return tool instanceof Tool;
}

export function buildPiTools(tools: ReadonlyArray<Tool | ToolDefinition>): PiTool[] {
  return tools.map((tool) => {
    const definition = isToolInstance(tool) ? tool.toolDefinition : tool;

    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters as PiTool["parameters"],
    };
  });
}

export function createStructuredOutputInstruction(agent: Agent): string | null {
  if (!agent.outputSchema) {
    return null;
  }

  const schema = JSON.stringify(formatParameters(agent.outputSchema), null, 2);
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
  messages: readonly InputItem[];
  llmContextDump?: string;
}): Context {
  const systemParts = options.messages.flatMap((item) => {
    return isSystemMessage(item) ? [item.content] : [];
  });

  const messages = options.messages.filter((item): item is Message => !isSystemMessage(item));
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
  let textParts: MessageTextOutput["content"] = [];

  const flushText = (): void => {
    if (textParts.length === 0) {
      return;
    }

    outputs.push({
      type: "message",
      role: "assistant",
      content: textParts,
    });
    textParts = [];
  };

  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text) {
        textParts.push({ type: "output_text", text: block.text });
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
