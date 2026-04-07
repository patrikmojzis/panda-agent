import type { InputItem } from "./types.js";

export type ToolOutput =
  | Record<string, unknown>
  | string
  | number
  | boolean
  | null
  | unknown[];

export interface ToolResponseOptions {
  output: ToolOutput;
  isError?: boolean;
  additionalInputs?: InputItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolOutput(value: ToolOutput): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }

  return isRecord(value) ? value : { message: value };
}

export class ToolResponse {
  readonly output: Record<string, unknown> | null;
  readonly isError: boolean;
  readonly additionalInputs?: InputItem[];

  constructor({ output, isError = false, additionalInputs }: ToolResponseOptions) {
    this.output = normalizeToolOutput(output);
    this.isError = isError;
    this.additionalInputs = additionalInputs;
  }

  static error(output: ToolOutput, additionalInputs?: InputItem[]): ToolResponse {
    return new ToolResponse({ output, isError: true, additionalInputs });
  }

  get outputString(): string {
    const dump = JSON.stringify({ output: this.output });
    return this.isError ? `[Error] ${dump}` : dump;
  }
}
