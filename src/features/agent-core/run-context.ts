import type { Agent } from "./agent.js";
import type { Message } from "@mariozechner/pi-ai";
import type { JsonObject } from "./types.js";

export interface RunContextOptions<TContext = unknown> {
  agent: Agent;
  turn: number;
  maxTurns: number;
  messages: Message[];
  context?: TContext;
  signal?: AbortSignal;
  onToolProgress?: (progress: JsonObject) => void;
}

export class RunContext<TContext = unknown> {
  readonly agent: Agent;
  readonly turn: number;
  readonly maxTurns: number;
  readonly messages: Message[];
  readonly context?: TContext;
  readonly signal?: AbortSignal;
  private readonly onToolProgress?: (progress: JsonObject) => void;

  constructor(options: RunContextOptions<TContext>) {
    this.agent = options.agent;
    this.turn = options.turn;
    this.maxTurns = options.maxTurns;
    this.messages = options.messages;
    this.context = options.context;
    this.signal = options.signal;
    this.onToolProgress = options.onToolProgress;
  }

  emitToolProgress(progress: JsonObject): void {
    this.onToolProgress?.(progress);
  }
}
