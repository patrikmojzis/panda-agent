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

export class ContextWindowExceededError extends AgentError {
  constructor(message = "Active transcript exceeds the model context window and auto-compaction could not reduce it. Start a fresh thread, reset or manually compact the conversation, or split the task into a smaller request.") {
    super(message);
  }
}

export type ProviderRuntimeFailureKind =
  | "provider_abort"
  | "provider_timeout"
  | "provider_server_error"
  | "provider_transport_terminated"
  | "provider_transport_network"
  | "provider_error";

export interface ProviderRuntimeErrorOptions {
  providerName: string;
  modelId: string;
  status?: number;
  requestId?: string;
  durationMs?: number;
  timedOut?: boolean;
  retryable?: boolean;
  stopReason?: string;
  failureKind?: ProviderRuntimeFailureKind;
  providerMessage?: string;
  cause?: unknown;
}

export class ProviderRuntimeError extends StreamingFailedError {
  readonly providerName: string;
  readonly modelId: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly durationMs?: number;
  readonly timedOut: boolean;
  readonly retryable: boolean;
  readonly stopReason?: string;
  readonly failureKind?: ProviderRuntimeFailureKind;
  readonly providerMessage?: string;

  constructor(message: string, options: ProviderRuntimeErrorOptions) {
    super(message);
    this.providerName = options.providerName;
    this.modelId = options.modelId;
    this.status = options.status;
    this.requestId = options.requestId;
    this.durationMs = options.durationMs;
    this.timedOut = options.timedOut === true;
    this.retryable = options.retryable === true;
    this.stopReason = options.stopReason;
    this.failureKind = options.failureKind;
    this.providerMessage = options.providerMessage;

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
