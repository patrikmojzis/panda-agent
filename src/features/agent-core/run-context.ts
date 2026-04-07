import type { Agent } from "./agent.js";
import type { InputItem, JsonObject } from "./types.js";

export interface RunContextOptions<TContext = unknown> {
  agent: Agent;
  turn: number;
  maxTurns: number;
  messages: InputItem[];
  context?: TContext;
  onToolProgress?: (progress: JsonObject) => void;
}

export class RunContext<TContext = unknown> {
  readonly agent: Agent;
  readonly turn: number;
  readonly maxTurns: number;
  readonly messages: InputItem[];
  readonly context?: TContext;
  private readonly onToolProgress?: (progress: JsonObject) => void;

  constructor(options: RunContextOptions<TContext>) {
    this.agent = options.agent;
    this.turn = options.turn;
    this.maxTurns = options.maxTurns;
    this.messages = options.messages;
    this.context = options.context;
    this.onToolProgress = options.onToolProgress;
  }

  emitToolProgress(progress: JsonObject): void {
    this.onToolProgress?.(progress);
  }
}
