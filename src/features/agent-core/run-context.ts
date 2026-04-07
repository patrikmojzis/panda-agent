import type { Agent } from "./agent.js";
import type { InputItem } from "./types.js";

export interface RunContextOptions<TContext = unknown> {
  agent: Agent;
  turn: number;
  maxTurns: number;
  input: InputItem[];
  context?: TContext;
}

export class RunContext<TContext = unknown> {
  agent: Agent;
  turn: number;
  maxTurns: number;
  input: InputItem[];
  context?: TContext;

  constructor(options: RunContextOptions<TContext>) {
    this.agent = options.agent;
    this.turn = options.turn;
    this.maxTurns = options.maxTurns;
    this.input = options.input;
    this.context = options.context;
  }
}
