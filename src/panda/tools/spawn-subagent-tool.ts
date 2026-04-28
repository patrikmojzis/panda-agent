import {z} from "zod";

import {Tool, type ToolOutput} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {RunContext} from "../../kernel/agent/run-context.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import {DEFAULT_AGENT_SUBAGENT_ROLES, type DefaultAgentSubagentRole} from "../subagents/policy.js";
import {DefaultAgentSubagentService} from "../subagents/service.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {readThreadId} from "../../integrations/shell/runtime-context.js";
import {buildBackgroundJobPayload} from "./background-job-tools.js";

export interface SpawnSubagentToolOptions {
  service: DefaultAgentSubagentService;
  jobService?: BackgroundToolJobService;
}

export class SpawnSubagentTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof SpawnSubagentTool.schema, TContext> {
  static schema = z.object({
    role: z.enum(DEFAULT_AGENT_SUBAGENT_ROLES).describe(
      'Subagent role to run. Use "workspace" for read-only workspace inspection, "memory" for Postgres history plus wiki memory work, "browser" for isolated browser automation, and "skill_maintainer" for skill reflection and maintenance.',
    ),
    task: z.string().trim().min(1).describe("The concrete task to delegate."),
    context: z.string().trim().min(1).optional().describe("Optional extra context for the child."),
    model: z.string().trim().min(1).optional().describe("Optional model override for the child run."),
  });

  name = "spawn_subagent";
  description = [
    "Start a fresh background subagent and return its job id.",
    "Subagents do not inherit the parent transcript.",
    'Use role="workspace" for read-only codebase inspection, role="memory" for Postgres history plus wiki memory work, role="browser" for isolated browser work, and role="skill_maintainer" for skill reflection and maintenance.',
    "The subagent result returns later as a background tool event. Use background_job_wait only when the current response truly needs the answer now.",
  ].join("\n");
  schema = SpawnSubagentTool.schema;

  private readonly service: DefaultAgentSubagentService;
  private readonly jobService?: BackgroundToolJobService;

  constructor(options: SpawnSubagentToolOptions) {
    super();
    this.service = options.service;
    this.jobService = options.jobService;
  }

  override formatCall(args: Record<string, unknown>): string {
    const role = typeof args.role === "string" ? args.role : "subagent";
    const task = typeof args.task === "string" ? args.task : "";
    return `${role}: ${task}`.trim();
  }

  async handle(
    args: z.output<typeof SpawnSubagentTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolOutput> {
    if (!this.jobService) {
      throw new ToolError("spawn_subagent requires background jobs in this runtime.");
    }

    const context = run.context as DefaultAgentSessionContext | undefined;
    const messages = [...(run as unknown as RunContext<DefaultAgentSessionContext>).messages];
    const job = await this.jobService.start({
      threadId: readThreadId(context),
      runId: context?.runId,
      kind: "spawn_subagent",
      summary: `${args.role}: ${args.task}`,
      start: ({signal}) => ({
        progress: {
          role: args.role,
          status: "running",
        },
        done: this.service.runSubagent({
          run: new RunContext<DefaultAgentSessionContext>({
            agent: run.agent,
            turn: run.turn,
            maxTurns: run.maxTurns,
            messages,
            context,
            signal,
          }),
          role: args.role as DefaultAgentSubagentRole,
          task: args.task,
          context: args.context,
          model: args.model,
          signal,
        }).then((result) => ({
          status: "completed" as const,
          result: {
            role: result.role,
            finalMessage: result.finalMessage,
            toolCallCount: result.toolCallCount,
            durationMs: result.durationMs,
          },
        })),
      }),
    });

    return buildBackgroundJobPayload(job);
  }
}
