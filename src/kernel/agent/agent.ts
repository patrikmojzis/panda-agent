import type {ZodType} from "zod";

import type {Tool} from "./tool.js";

export interface AgentOptions<TOutput = unknown> {
  name?: string;
  instructions?: string;
  tools?: ReadonlyArray<Tool>;
  outputSchema?: ZodType<TOutput>;
}

export class Agent<TOutput = unknown> {
  readonly name: string;
  readonly instructions: string;
  readonly tools: ReadonlyArray<Tool>;
  readonly outputSchema?: ZodType<TOutput>;

  constructor(options: AgentOptions<TOutput> = {}) {
    this.name = options.name ?? "agent";
    this.instructions = options.instructions ?? "You are a helpful assistant.";
    this.tools = options.tools ?? [];
    this.outputSchema = options.outputSchema;
  }
}
