import type {Tool as PiTool, ToolResultMessage} from "@mariozechner/pi-ai";
import {type output, ZodError, type ZodTypeAny} from "zod";

import {ToolError} from "./exceptions.js";
import {formatParameters} from "./helpers/schema.js";
import {stringifyUnknown} from "./helpers/stringify.js";
import type {RunContext} from "./run-context.js";
import type {JsonValue, ToolResultPayload} from "./types.js";

export type ToolOutput = JsonValue | ToolResultPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatToolCallFallback(args: Record<string, unknown>): string {
  return stringifyUnknown(args, { pretty: true });
}

function isToolResultContentItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "text") {
    return typeof value.text === "string";
  }

  if (value.type === "image") {
    return typeof value.data === "string" && typeof value.mimeType === "string";
  }

  return false;
}

export function isToolResultPayload(value: ToolOutput): value is ToolResultPayload {
  return isRecord(value)
    && Array.isArray(value.content)
    && value.content.every((item) => isToolResultContentItem(item));
}

export function formatToolResultFallback(message: ToolResultMessage<JsonValue>): string {
  const contentParts = message.content.flatMap((part) => {
    if (part.type === "text" && part.text.trim()) {
      return [part.text.trim()];
    }

    if (part.type === "image") {
      return ["[image attached]"];
    }

    return [];
  });

  if (contentParts.length > 0) {
    return contentParts.join("\n\n");
  }

  if (message.details !== undefined) {
    return stringifyUnknown(message.details, { pretty: true });
  }

  return message.isError ? "Tool failed." : "Tool completed.";
}

export abstract class Tool<TSchema extends ZodTypeAny = ZodTypeAny, TContext = unknown> {
  abstract name: string;
  abstract description: string;
  abstract schema: TSchema;

  get piTool(): PiTool {
    return {
      name: this.name,
      description: this.description,
      parameters: formatParameters(this.schema) as PiTool["parameters"],
    };
  }

  formatCall(args: Record<string, unknown>): string {
    return formatToolCallFallback(args);
  }

  formatResult(message: ToolResultMessage<JsonValue>): string {
    return formatToolResultFallback(message);
  }

  async run(rawArgs: unknown, runContext: RunContext<TContext>): Promise<ToolOutput> {
    try {
      const parsedArgs = await this.schema.parseAsync(rawArgs);
      return await this.handle(parsedArgs as output<TSchema>, runContext);
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues.map((issue) => issue.message);
        const message =
          issues.length === 1
            ? issues[0] ?? "Invalid tool arguments"
            : `Invalid tool arguments: ${issues.join("; ")}`;
        throw new ToolError(message, { details: issues });
      }

      if (error instanceof ToolError) {
        throw error;
      }

      throw error;
    }
  }

  abstract handle(args: output<TSchema>, run: RunContext<TContext>): Promise<ToolOutput>;
}
