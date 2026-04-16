import {z} from "zod";

import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject, ToolResultPayload} from "../../kernel/agent/types.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {PANDA_SUBAGENT_ROLES, type PandaSubagentRole} from "../subagents/policy.js";
import {PandaSubagentService} from "../subagents/service.js";
import type {PandaSessionContext} from "../../app/runtime/panda-session-context.js";

function buildPayload(details: JsonObject): ToolResultPayload {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(details, null, 2),
    }],
    details,
  };
}

export interface SpawnSubagentToolOptions {
  service: PandaSubagentService;
}

export class SpawnSubagentTool<TContext = PandaSessionContext>
  extends Tool<typeof SpawnSubagentTool.schema, TContext> {
  static schema = z.object({
    role: z.enum(PANDA_SUBAGENT_ROLES).describe(
      'Subagent role to run. Use "workspace" for read-only workspace inspection, "memory" for Postgres-backed memory search, and "browser" for isolated browser automation.',
    ),
    task: z.string().trim().min(1).describe("The concrete task to delegate."),
    context: z.string().trim().min(1).optional().describe("Optional extra context for the child."),
    model: z.string().trim().min(1).optional().describe("Optional model override for the child run."),
  });

  name = "spawn_subagent";
  description = [
    "Run a fresh synchronous Panda subagent and return its final answer.",
    "Subagents do not inherit the parent transcript.",
    'Use role="workspace" for read-only codebase inspection, role="memory" for durable memory lookup through Postgres, and role="browser" for isolated browser work.',
    "Use this for scoped delegated exploration when a separate pass is faster or safer.",
  ].join("\n");
  schema = SpawnSubagentTool.schema;

  private readonly service: PandaSubagentService;

  constructor(options: SpawnSubagentToolOptions) {
    super();
    this.service = options.service;
  }

  override formatCall(args: Record<string, unknown>): string {
    const role = typeof args.role === "string" ? args.role : "subagent";
    const task = typeof args.task === "string" ? args.task : "";
    return `${role}: ${task}`.trim();
  }

  async handle(
    args: z.output<typeof SpawnSubagentTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    try {
      const result = await this.service.runSubagent({
        run: run as unknown as RunContext<PandaSessionContext>,
        role: args.role as PandaSubagentRole,
        task: args.task,
        context: args.context,
        model: args.model,
      });

      return buildPayload({
        role: result.role,
        finalMessage: result.finalMessage,
        toolCallCount: result.toolCallCount,
        durationMs: result.durationMs,
      });
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Subagent failed.";
      throw new ToolError(message);
    }
  }
}
