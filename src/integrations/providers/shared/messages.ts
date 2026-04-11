import type {
    AssistantMessage,
    Context,
    Message,
    Tool as PiTool,
    ToolCall,
    ToolResultMessage,
} from "@mariozechner/pi-ai";

import type {Agent} from "../../../kernel/agent/agent.js";
import {formatParameters} from "../../../kernel/agent/helpers/schema.js";
import type {JsonValue, ToolResultContent} from "../../../kernel/agent/types.js";
import {Tool} from "../../../kernel/agent/tool.js";
import {renderStructuredOutputInstruction} from "../../../prompts/runtime/structured-output.js";

function normalizeSystemPrompt(systemPrompt?: string | ReadonlyArray<string>): string[] {
  if (typeof systemPrompt === "string") {
    return [systemPrompt];
  }

  return systemPrompt ? [...systemPrompt] : [];
}

function buildPiTools(tools: ReadonlyArray<Tool>): PiTool[] {
  return tools.map((tool) => tool.piTool);
}

function createStructuredOutputInstruction(agent: Agent): string | null {
  if (!agent.outputSchema) {
    return null;
  }

  const schema = JSON.stringify(formatParameters(agent.outputSchema), null, 2);
  return renderStructuredOutputInstruction(schema);
}

export function buildConversationContext(options: {
  agent: Agent;
  messages: readonly Message[];
  systemPrompt?: string | ReadonlyArray<string>;
  llmContextDump?: string;
}): Context {
  const structuredOutput = createStructuredOutputInstruction(options.agent);
  const systemPrompt = [
    options.agent.instructions,
    structuredOutput,
    options.llmContextDump,
    ...normalizeSystemPrompt(options.systemPrompt),
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");

  const tools = buildPiTools(options.agent.tools);

  return {
    systemPrompt: systemPrompt || undefined,
    messages: [...options.messages],
    ...(tools.length > 0 ? {tools} : {}),
  };
}

export function collectAssistantToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

export function buildToolResultMessage(options: {
  toolCall: ToolCall;
  content: ToolResultContent;
  isError: boolean;
  details?: JsonValue;
}): ToolResultMessage<JsonValue> {
  const message: ToolResultMessage<JsonValue> = {
    role: "toolResult",
    toolCallId: options.toolCall.id,
    toolName: options.toolCall.name,
    content: options.content,
    isError: options.isError,
    timestamp: Date.now(),
  };

  if (options.details !== undefined) {
    message.details = options.details;
  }

  return message;
}
