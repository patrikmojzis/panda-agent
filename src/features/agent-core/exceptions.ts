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
export class ToolError extends AgentError {}
