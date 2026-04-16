import type {Agent} from "./agent.js";
import type {Message, ThinkingLevel} from "@mariozechner/pi-ai";
import type {JsonObject} from "./types.js";

export interface RunContextOptions<TContext = unknown> {
  agent: Agent;
  turn: number;
  maxTurns: number;
  messages: Message[];
  context?: TContext;
  signal?: AbortSignal;
  onToolProgress?: (progress: JsonObject) => void;
  getThinking?: () => ThinkingLevel | undefined;
  setThinking?: (next: ThinkingLevel | undefined) => void;
}

export class RunContext<TContext = unknown> {
  readonly agent: Agent;
  readonly turn: number;
  readonly maxTurns: number;
  readonly messages: Message[];
  readonly context?: TContext;
  readonly signal?: AbortSignal;
  private readonly onToolProgress?: (progress: JsonObject) => void;
  private readonly readThinking?: () => ThinkingLevel | undefined;
  private readonly writeThinking?: (next: ThinkingLevel | undefined) => void;

  constructor(options: RunContextOptions<TContext>) {
    this.agent = options.agent;
    this.turn = options.turn;
    this.maxTurns = options.maxTurns;
    this.messages = options.messages;
    this.context = options.context;
    this.signal = options.signal;
    this.onToolProgress = options.onToolProgress;
    this.readThinking = options.getThinking;
    this.writeThinking = options.setThinking;
  }

  emitToolProgress(progress: JsonObject): void {
    this.onToolProgress?.(progress);
  }

  getThinking(): ThinkingLevel | undefined {
    if (!this.readThinking) {
      throw new Error("Thinking state is unavailable in this run context.");
    }

    return this.readThinking();
  }

  setThinking(next: ThinkingLevel | undefined): void {
    if (!this.writeThinking) {
      throw new Error("Thinking control is unavailable in this run context.");
    }

    this.writeThinking(next);
  }
}
