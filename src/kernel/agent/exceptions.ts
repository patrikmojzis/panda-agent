import type {JsonValue, ToolResultContent} from "./types.js";

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MaxTurnsReachedError extends AgentError {
  constructor() {
    super("Max turns reached");
  }
}

export class RefusalError extends AgentError {}
export class InvalidJSONResponseError extends AgentError {}
export class InvalidSchemaResponseError extends AgentError {}

export class StreamingFailedError extends AgentError {
  constructor(message = "Streaming failed") {
    super(message);
  }
}

export class ConfigurationError extends AgentError {}

export interface ProviderRuntimeErrorOptions {
  providerName: string;
  modelId: string;
  status?: number;
  requestId?: string;
  durationMs?: number;
  timedOut?: boolean;
  cause?: unknown;
}

export class ProviderRuntimeError extends AgentError {
  readonly providerName: string;
  readonly modelId: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly durationMs?: number;
  readonly timedOut: boolean;

  constructor(message: string, options: ProviderRuntimeErrorOptions) {
    super(message);
    this.providerName = options.providerName;
    this.modelId = options.modelId;
    this.status = options.status;
    this.requestId = options.requestId;
    this.durationMs = options.durationMs;
    this.timedOut = options.timedOut === true;

    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }
}

export interface ToolErrorOptions {
  details?: JsonValue;
  content?: ToolResultContent;
}

export class ToolError extends AgentError {
  readonly details?: JsonValue;
  readonly content?: ToolResultContent;

  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message);
    this.details = options.details;
    this.content = options.content;
  }
}
