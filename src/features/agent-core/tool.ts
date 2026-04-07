import { ZodError, type ZodTypeAny, type output } from "zod";

import { ToolError } from "./exceptions.js";
import { formatParameters } from "./helpers/schema.js";
import type { RunContext } from "./run-context.js";
import { ToolResponse, type ToolOutput } from "./tool-response.js";
import type { ToolDefinition } from "./types.js";

export abstract class Tool<TSchema extends ZodTypeAny = ZodTypeAny, TContext = unknown> {
  abstract name: string;
  abstract description: string;
  abstract schema: TSchema;

  get toolDefinition(): ToolDefinition {
    return {
      type: "function",
      name: this.name,
      description: this.description,
      parameters: formatParameters(this.schema),
    };
  }

  async run(rawArgs: unknown, runContext: RunContext<TContext>): Promise<ToolResponse> {
    try {
      const parsedArgs = await this.schema.parseAsync(rawArgs);
      const result = await this.handle(parsedArgs as output<TSchema>, runContext);
      return result instanceof ToolResponse ? result : new ToolResponse({ output: result as ToolOutput });
    } catch (error) {
      if (error instanceof ZodError) {
        return ToolResponse.error(error.issues.map((issue) => issue.message));
      }

      if (error instanceof ToolError) {
        return ToolResponse.error(error.message);
      }

      throw error;
    }
  }

  abstract handle(args: output<TSchema>, run: RunContext<TContext>): Promise<ToolResponse | ToolOutput>;
}
