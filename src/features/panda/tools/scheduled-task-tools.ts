import {z} from "zod";

import {ToolError} from "../../agent-core/exceptions.js";
import type {RunContext} from "../../agent-core/run-context.js";
import {Tool} from "../../agent-core/tool.js";
import {normalizeScheduledTaskSchedule, type ScheduledTaskStore} from "../../scheduled-tasks/index.js";
import type {PandaSessionContext} from "../types.js";

const onceScheduleSchema = z.object({
  kind: z.literal("once"),
  runAt: z.string().trim().min(1).describe("Absolute ISO timestamp with timezone, for example 2026-04-11T03:00:00+02:00."),
  deliverAt: z.string().trim().min(1).optional()
    .describe("Optional absolute ISO timestamp with timezone. Only valid for once tasks and must be later than runAt."),
});

const recurringScheduleSchema = z.object({
  kind: z.literal("recurring"),
  cron: z.string().trim().min(1).describe("Five-field cron expression such as 0 8 * * *."),
  timezone: z.string().trim().min(1).describe("IANA timezone such as Europe/Bratislava."),
});

const scheduledTaskScheduleSchema = z.discriminatedUnion("kind", [
  onceScheduleSchema,
  recurringScheduleSchema,
]);

function readTaskScope(context: unknown): {
  identityId: string;
  agentKey: string;
} {
  if (
    !context
    || typeof context !== "object"
    || Array.isArray(context)
    || typeof (context as {identityId?: unknown}).identityId !== "string"
    || !(context as {identityId: string}).identityId.trim()
    || typeof (context as {agentKey?: unknown}).agentKey !== "string"
    || !(context as {agentKey: string}).agentKey.trim()
  ) {
    throw new ToolError("Scheduled task tools require both identityId and agentKey in the Panda thread context.");
  }

  return {
    identityId: (context as {identityId: string}).identityId,
    agentKey: (context as {agentKey: string}).agentKey,
  };
}

function wrapScheduledTaskError(error: unknown): never {
  if (error instanceof ToolError) {
    throw error;
  }

  const message = error instanceof Error ? error.message : String(error);
  throw new ToolError(message);
}

export interface ScheduledTaskToolOptions {
  store: ScheduledTaskStore;
}

export class ScheduledTaskCreateTool<TContext = PandaSessionContext>
  extends Tool<typeof ScheduledTaskCreateTool.schema, TContext> {
  static schema = z.object({
    title: z.string().trim().min(1),
    instruction: z.string().trim().min(1),
    schedule: scheduledTaskScheduleSchema,
    targetThreadId: z.string().trim().min(1).optional()
      .describe("Optional explicit thread id. Omit to follow the current home thread dynamically."),
    enabled: z.boolean().optional(),
  });

  name = "scheduled_task_create";
  description =
    "Create a one-off or recurring scheduled task. Use absolute ISO timestamps with timezone offsets for once tasks. Omit targetThreadId to follow home dynamically.";
  schema = ScheduledTaskCreateTool.schema;

  constructor(private readonly options: ScheduledTaskToolOptions) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.title === "string" ? args.title : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof ScheduledTaskCreateTool.schema>,
    run: RunContext<TContext>,
  ): Promise<{taskId: string}> {
    try {
      const scope = readTaskScope(run.context);
      const task = await this.options.store.createTask({
        ...scope,
        title: args.title,
        instruction: args.instruction,
        schedule: normalizeScheduledTaskSchedule(args.schedule),
        targetThreadId: args.targetThreadId,
        enabled: args.enabled,
      });
      return {
        taskId: task.id,
      };
    } catch (error) {
      wrapScheduledTaskError(error);
    }
  }
}

export class ScheduledTaskUpdateTool<TContext = PandaSessionContext>
  extends Tool<typeof ScheduledTaskUpdateTool.schema, TContext> {
  static schema = z.object({
    taskId: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    instruction: z.string().trim().min(1).optional(),
    schedule: scheduledTaskScheduleSchema.optional(),
    targetThreadId: z.string().trim().min(1).nullable().optional()
      .describe("Explicit thread id, or null to reset the task back to the home thread."),
    enabled: z.boolean().optional(),
  });

  name = "scheduled_task_update";
  description =
    "Update an existing scheduled task. Use null targetThreadId to reset an explicitly targeted task back to home-following behavior.";
  schema = ScheduledTaskUpdateTool.schema;

  constructor(private readonly options: ScheduledTaskToolOptions) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.taskId === "string" ? args.taskId : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof ScheduledTaskUpdateTool.schema>,
    run: RunContext<TContext>,
  ): Promise<{taskId: string; updated: true}> {
    try {
      const scope = readTaskScope(run.context);
      const task = await this.options.store.updateTask({
        ...scope,
        taskId: args.taskId,
        title: args.title,
        instruction: args.instruction,
        schedule: args.schedule === undefined ? undefined : normalizeScheduledTaskSchedule(args.schedule),
        targetThreadId: args.targetThreadId,
        enabled: args.enabled,
      });
      return {
        taskId: task.id,
        updated: true,
      };
    } catch (error) {
      wrapScheduledTaskError(error);
    }
  }
}

export class ScheduledTaskCancelTool<TContext = PandaSessionContext>
  extends Tool<typeof ScheduledTaskCancelTool.schema, TContext> {
  static schema = z.object({
    taskId: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional(),
  });

  name = "scheduled_task_cancel";
  description = "Cancel a scheduled task without deleting its history.";
  schema = ScheduledTaskCancelTool.schema;

  constructor(private readonly options: ScheduledTaskToolOptions) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.taskId === "string" ? args.taskId : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof ScheduledTaskCancelTool.schema>,
    run: RunContext<TContext>,
  ): Promise<{taskId: string; cancelled: true}> {
    try {
      const scope = readTaskScope(run.context);
      const task = await this.options.store.cancelTask({
        ...scope,
        taskId: args.taskId,
        reason: args.reason,
      });
      return {
        taskId: task.id,
        cancelled: true,
      };
    } catch (error) {
      wrapScheduledTaskError(error);
    }
  }
}
