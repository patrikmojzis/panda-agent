import type { ZodType } from "zod";

import type { Tool } from "./tool.js";
import type { NativeToolDefinition, ReasoningEffort } from "./types.js";

export interface AgentOptions<TOutput = unknown> {
  name?: string;
  instructions?: string;
  model?: string;
  tools?: Array<Tool | NativeToolDefinition>;
  outputSchema?: ZodType<TOutput>;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
}

export class Agent<TOutput = unknown> {
  name: string;
  instructions: string;
  model: string;
  tools: Array<Tool | NativeToolDefinition>;
  outputSchema?: ZodType<TOutput>;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;

  constructor(options: AgentOptions<TOutput> = {}) {
    this.name = options.name ?? "agent";
    this.instructions = options.instructions ?? "You are a helpful assistant.";
    this.model = options.model ?? "gpt-5.1";
    this.tools = options.tools ?? [];
    this.outputSchema = options.outputSchema;
    this.temperature = options.temperature;
    this.reasoningEffort = options.reasoningEffort;
  }
}
