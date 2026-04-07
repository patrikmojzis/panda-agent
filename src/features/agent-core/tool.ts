import { ZodError, type ZodTypeAny, type output } from "zod";

import { ToolError } from "./exceptions.js";
import { formatParameters } from "./helpers/schema.js";
import type { RunContext } from "./run-context.js";
import { ToolResponse, type ToolOutput } from "./tool-response.js";
import type { JsonObject } from "./types.js";

export abstract class Tool<TSchema extends ZodTypeAny = ZodTypeAny, TContext = unknown> {
  abstract name: string;
  abstract description: string;
  abstract schema: TSchema;
  partial = false;
  runContext!: RunContext<TContext>;

  get toolDefinition(): JsonObject {
    return {
      type: "function",
      name: this.name,
      description: this.description,
      parameters: formatParameters(this.schema, this.name),
    };
  }

  protected cloneForRun(runContext: RunContext<TContext>): this {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this)) as this,
      this,
    );

    clone.runContext = runContext;
    return clone;
  }

  async run(rawArgs: unknown, runContext: RunContext<TContext>): Promise<ToolResponse> {
    const tool = this.cloneForRun(runContext);

    try {
      const parsedArgs = await tool.schema.parseAsync(rawArgs);
      const result = await tool.handle(parsedArgs as output<TSchema>);
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

  abstract handle(args: output<TSchema>): Promise<ToolResponse | ToolOutput>;
}
