import type { ThinkingLevel } from "@mariozechner/pi-ai";
import type { ZodType } from "zod";

import type { Tool } from "./tool.js";

export interface AgentOptions<TOutput = unknown> {
  name?: string;
  instructions?: string;
  model?: string;
  tools?: ReadonlyArray<Tool>;
  outputSchema?: ZodType<TOutput>;
  temperature?: number;
  thinking?: ThinkingLevel;
}

export class Agent<TOutput = unknown> {
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: ReadonlyArray<Tool>;
  readonly outputSchema?: ZodType<TOutput>;
  readonly temperature?: number;
  readonly thinking?: ThinkingLevel;

  constructor(options: AgentOptions<TOutput> = {}) {
    this.name = options.name ?? "agent";
    this.instructions = options.instructions ?? "You are a helpful assistant.";
    this.model = options.model ?? "gpt-5.1";
    this.tools = options.tools ?? [];
    this.outputSchema = options.outputSchema;
    this.temperature = options.temperature;
    this.thinking = options.thinking;
  }
}
