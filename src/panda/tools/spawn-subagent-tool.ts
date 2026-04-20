import {z} from "zod";

import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {DEFAULT_AGENT_SUBAGENT_ROLES, type DefaultAgentSubagentRole} from "../subagents/policy.js";
import {DefaultAgentSubagentService} from "../subagents/service.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {buildJsonToolPayload} from "./shared.js";

export interface SpawnSubagentToolOptions {
  service: DefaultAgentSubagentService;
}

export class SpawnSubagentTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof SpawnSubagentTool.schema, TContext> {
  static schema = z.object({
    role: z.enum(DEFAULT_AGENT_SUBAGENT_ROLES).describe(
      'Subagent role to run. Use "workspace" for read-only workspace inspection, "memory" for Postgres-backed memory search, "browser" for isolated browser automation, and "skill_maintainer" for skill reflection and maintenance.',
    ),
    task: z.string().trim().min(1).describe("The concrete task to delegate."),
    context: z.string().trim().min(1).optional().describe("Optional extra context for the child."),
    model: z.string().trim().min(1).optional().describe("Optional model override for the child run."),
  });

  name = "spawn_subagent";
  description = [
    "Run a fresh synchronous subagent and return its final answer.",
    "Subagents do not inherit the parent transcript.",
    'Use role="workspace" for read-only codebase inspection, role="memory" for durable memory lookup through Postgres, role="browser" for isolated browser work, and role="skill_maintainer" for skill reflection and maintenance.',
    "Use this for scoped delegated exploration when a separate pass is faster or safer.",
  ].join("\n");
  schema = SpawnSubagentTool.schema;

  private readonly service: DefaultAgentSubagentService;

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
        run: run as unknown as RunContext<DefaultAgentSessionContext>,
        role: args.role as DefaultAgentSubagentRole,
        task: args.task,
        context: args.context,
        model: args.model,
      });

      return buildJsonToolPayload({
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
