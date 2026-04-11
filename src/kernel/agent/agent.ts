import type {ZodType} from "zod";

import {DEFAULT_AGENT_INSTRUCTIONS} from "../../prompts/runtime/default-agent.js";
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
    this.instructions = options.instructions ?? DEFAULT_AGENT_INSTRUCTIONS;
    this.tools = options.tools ?? [];
    this.outputSchema = options.outputSchema;
  }
}
