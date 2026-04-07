import type { InputItem, JsonObject, JsonValue } from "./types.js";

export type ToolOutput =
  | JsonObject
  | JsonValue;

export interface ToolResponseOptions {
  output: ToolOutput;
  isError?: boolean;
  additionalMessages?: InputItem[];
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolOutput(value: ToolOutput): JsonObject | null {
  if (value === null) {
    return null;
  }

  return isRecord(value) ? value : { message: value };
}

export class ToolResponse {
  readonly output: JsonObject | null;
  readonly isError: boolean;
  readonly additionalMessages?: InputItem[];

  constructor({ output, isError = false, additionalMessages }: ToolResponseOptions) {
    this.output = normalizeToolOutput(output);
    this.isError = isError;
    this.additionalMessages = additionalMessages;
  }

  static error(output: ToolOutput, additionalMessages?: InputItem[]): ToolResponse {
    return new ToolResponse({ output, isError: true, additionalMessages });
  }

  get outputString(): string {
    const dump = JSON.stringify({ output: this.output });
    return this.isError ? `[Error] ${dump}` : dump;
  }
}
