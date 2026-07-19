import {isRecord} from "../../../lib/records.js";
import {normalizeToJsonValue, type JsonObject} from "../../../lib/json.js";
import {commandScopeDenied} from "../../commands/errors.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../../commands/types.js";
import {normalizeScheduledTaskSchedule} from "./schedule.js";
import type {
  ListScheduledTasksStatus,
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  ScheduledTaskSchedule,
} from "./types.js";
import type {ScheduledTaskStore} from "./store.js";

export const SCHEDULE_LIST_COMMAND_NAME = "schedule.list";
export const SCHEDULE_SHOW_COMMAND_NAME = "schedule.show";
export const SCHEDULE_RUNS_COMMAND_NAME = "schedule.runs";
export const SCHEDULE_CREATE_COMMAND_NAME = "schedule.create";
export const SCHEDULE_UPDATE_COMMAND_NAME = "schedule.update";
export const SCHEDULE_CANCEL_COMMAND_NAME = "schedule.cancel";

type ScheduleListStore = Pick<ScheduledTaskStore, "listTasks">;
type ScheduleShowStore = Pick<ScheduledTaskStore, "getTask">;
type ScheduleRunsStore = Pick<ScheduledTaskStore, "getTask" | "listTaskRuns">;
type ScheduleCreateStore = Pick<ScheduledTaskStore, "createTask">;
type ScheduleUpdateStore = Pick<ScheduledTaskStore, "updateTask">;
type ScheduleCancelStore = Pick<ScheduledTaskStore, "cancelTask">;

interface ScheduleCreateCommandInput {
  title: string;
  instruction: string;
  schedule: ScheduledTaskSchedule;
  enabled?: boolean;
}

interface ScheduleUpdateCommandInput {
  taskId: string;
  title?: string;
  instruction?: string;
  schedule?: ScheduledTaskSchedule;
  enabled?: boolean;
}

interface ScheduleListCommandInput {
  status?: ListScheduledTasksStatus;
  limit?: number;
}

interface ScheduleShowCommandInput {
  taskId: string;
}

interface ScheduleRunsCommandInput {
  taskId: string;
  limit?: number;
}

interface ScheduleCancelCommandInput {
  taskId: string;
  reason?: string;
}

export interface ScheduleCreateCommandOutput extends JsonObject {
  taskId: string;
}

export interface ScheduleUpdateCommandOutput extends JsonObject {
  taskId: string;
  updated: true;
}

export interface ScheduleCancelCommandOutput extends JsonObject {
  taskId: string;
  cancelled: true;
}

export interface ScheduleListCommandOutput extends JsonObject {
  operation: "list";
  count: number;
}

export interface ScheduleShowCommandOutput extends JsonObject {
  operation: "show";
  taskId: string;
}

export interface ScheduleRunsCommandOutput extends JsonObject {
  operation: "runs";
  taskId: string;
  count: number;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return readRequiredString(value, label);
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }

  return value;
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function readOptionalListScheduledTasksStatus(value: unknown): ListScheduledTasksStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    value === "active"
    || value === "disabled"
    || value === "completed"
    || value === "cancelled"
    || value === "all"
  ) {
    return value;
  }

  throw new Error("schedule.list status must be active, disabled, completed, cancelled, or all.");
}

function rejectUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported field ${unexpected[0]}.`);
  }
}

function readSchedule(value: unknown, label: string): ScheduledTaskSchedule {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  if (value.kind === "once") {
    rejectUnexpectedKeys(value, ["kind", "runAt"], label);
    return normalizeScheduledTaskSchedule({
      kind: "once",
      runAt: readRequiredString(value.runAt, `${label}.runAt`),
    });
  }

  if (value.kind === "recurring") {
    rejectUnexpectedKeys(value, ["kind", "cron", "timezone"], label);
    return normalizeScheduledTaskSchedule({
      kind: "recurring",
      cron: readRequiredString(value.cron, `${label}.cron`),
      timezone: readRequiredString(value.timezone, `${label}.timezone`),
    });
  }

  throw new Error(`${label}.kind must be once or recurring.`);
}

function readOptionalSchedule(value: unknown, label: string): ScheduledTaskSchedule | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return readSchedule(value, label);
}

function parseScheduleCreateCommandInput(input: unknown): ScheduleCreateCommandInput {
  if (!isRecord(input)) {
    throw new Error("schedule.create input must be a JSON object.");
  }

  return {
    title: readRequiredString(input.title, "schedule.create title"),
    instruction: readRequiredString(input.instruction, "schedule.create instruction"),
    schedule: readSchedule(input.schedule, "schedule.create schedule"),
    enabled: readOptionalBoolean(input.enabled, "schedule.create enabled"),
  };
}

function parseScheduleListCommandInput(input: unknown): ScheduleListCommandInput {
  if (!isRecord(input)) {
    throw new Error("schedule.list input must be a JSON object.");
  }

  return {
    status: readOptionalListScheduledTasksStatus(input.status),
    limit: readOptionalPositiveInteger(input.limit, "schedule.list limit"),
  };
}

function parseScheduleShowCommandInput(input: unknown): ScheduleShowCommandInput {
  if (!isRecord(input)) {
    throw new Error("schedule.show input must be a JSON object.");
  }

  return {
    taskId: readRequiredString(input.taskId, "schedule.show taskId"),
  };
}

function parseScheduleRunsCommandInput(input: unknown): ScheduleRunsCommandInput {
  if (!isRecord(input)) {
    throw new Error("schedule.runs input must be a JSON object.");
  }

  return {
    taskId: readRequiredString(input.taskId, "schedule.runs taskId"),
    limit: readOptionalPositiveInteger(input.limit, "schedule.runs limit"),
  };
}

function parseScheduleUpdateCommandInput(input: unknown): ScheduleUpdateCommandInput {
  if (!isRecord(input)) {
    throw new Error("schedule.update input must be a JSON object.");
  }

  return {
    taskId: readRequiredString(input.taskId, "schedule.update taskId"),
    title: readOptionalString(input.title, "schedule.update title"),
    instruction: readOptionalString(input.instruction, "schedule.update instruction"),
    schedule: readOptionalSchedule(input.schedule, "schedule.update schedule"),
    enabled: readOptionalBoolean(input.enabled, "schedule.update enabled"),
  };
}

function parseScheduleCancelCommandInput(input: unknown): ScheduleCancelCommandInput {
  if (!isRecord(input)) {
    throw new Error("schedule.cancel input must be a JSON object.");
  }

  return {
    taskId: readRequiredString(input.taskId, "schedule.cancel taskId"),
    reason: readOptionalString(input.reason, "schedule.cancel reason"),
  };
}

function assertTaskInSession(task: ScheduledTaskRecord, request: CommandRequest): void {
  if (task.sessionId === request.scope.sessionId) {
    return;
  }

  throw commandScopeDenied(
    "The scheduled task is not visible to the current session.",
    "resource_scope_denied",
    "Use a scheduled task owned by the current session.",
  );
}

function serializeTaskSummary(task: ScheduledTaskRecord): JsonObject {
  return {
    taskId: task.id,
    title: task.title,
    enabled: task.enabled,
    schedule: normalizeToJsonValue(task.schedule),
    ...(task.nextFireAt !== undefined ? {nextFireAt: task.nextFireAt} : {}),
    ...(task.completedAt !== undefined ? {completedAt: task.completedAt} : {}),
    ...(task.cancelledAt !== undefined ? {cancelledAt: task.cancelledAt} : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function serializeTaskDetail(task: ScheduledTaskRecord): JsonObject {
  return {
    ...serializeTaskSummary(task),
    instruction: task.instruction,
    ...(task.createdFromMessageId !== undefined ? {createdFromMessageId: task.createdFromMessageId} : {}),
  };
}

function serializeTaskRun(run: ScheduledTaskRunRecord): JsonObject {
  return {
    runId: run.id,
    status: run.status,
    scheduledFor: run.scheduledFor,
    ...(run.resolvedThreadId !== undefined ? {resolvedThreadId: run.resolvedThreadId} : {}),
    ...(run.threadRunId !== undefined ? {threadRunId: run.threadRunId} : {}),
    ...(run.error !== undefined ? {error: run.error} : {}),
    createdAt: run.createdAt,
    ...(run.startedAt !== undefined ? {startedAt: run.startedAt} : {}),
    ...(run.finishedAt !== undefined ? {finishedAt: run.finishedAt} : {}),
  };
}

export const scheduleCreateCommandDescriptor: CommandDescriptor = {
  name: SCHEDULE_CREATE_COMMAND_NAME,
  summary: "Create a scheduled task.",
  description: "Creates a one-off or recurring task for the current session through Panda runtime policy.",
  usage: "panda schedule create <title> (--at <iso>|--cron <expr> --timezone <tz>) --instruction <text|@file|@-> [--disabled]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "title",
      description: "Task title.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "title",
    },
    {
      name: "at",
      description: "ISO timestamp for a one-off task. Mutually exclusive with --cron.",
      valueType: "string",
      valueName: "iso",
    },
    {
      name: "cron",
      description: "Cron expression for a recurring task. Requires --timezone.",
      valueType: "string",
      valueName: "expr",
    },
    {
      name: "timezone",
      description: "IANA timezone for recurring cron schedules.",
      valueType: "string",
      valueName: "tz",
    },
    {
      name: "instruction",
      description: "Instruction to run when the task fires. Accepts literal text, @file, or @-.",
      required: true,
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "disabled",
      description: "Create the task disabled.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "Structured JSON object containing title, instruction, schedule, and optional enabled.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Create a once task",
      command: "panda schedule create \"check CI\" --at 2026-05-25T09:00:00+02:00 --instruction \"Check CI status\"",
    },
    {
      description: "Create a recurring task from stdin",
      command: "cat instruction.md | panda schedule create \"daily report\" --cron \"0 9 * * *\" --timezone Europe/Bratislava --instruction @-",
    },
    {
      description: "Use JSON input",
      command: "panda schedule create --json '{\"title\":\"check CI\",\"instruction\":\"Check CI status\",\"schedule\":{\"kind\":\"once\",\"runAt\":\"2026-05-25T09:00:00+02:00\"}}'",
    },
  ],
  requiredCapabilities: ["schedule.create"],
  resultShape: {
    taskId: "string",
  },
};

export const scheduleListCommandDescriptor: CommandDescriptor = {
  name: SCHEDULE_LIST_COMMAND_NAME,
  summary: "List scheduled tasks for the current session.",
  description: "Lists session-scoped scheduled task summaries. Defaults to active tasks; use --status all for history.",
  usage: "panda schedule list [--status active|disabled|completed|cancelled|all] [--limit <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "status",
      description: "Optional status filter. Defaults to active.",
      valueType: "string",
      valueName: "active|disabled|completed|cancelled|all",
      defaultValue: "active",
    },
    {
      name: "limit",
      description: "Maximum number of scheduled tasks to return. Defaults to 25.",
      valueType: "number",
      valueName: "n",
      defaultValue: 25,
    },
    {
      name: "json",
      description: "Structured JSON object containing optional status and limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List active scheduled tasks",
      command: "panda schedule list",
    },
    {
      description: "List every scheduled task",
      command: "panda schedule list --status all --limit 50",
    },
  ],
  requiredCapabilities: [SCHEDULE_LIST_COMMAND_NAME],
  resultShape: {
    operation: "list",
    count: "number",
    tasks: [{
      taskId: "string",
      title: "string",
      enabled: "boolean",
      schedule: "object",
    }],
  },
};

export const scheduleShowCommandDescriptor: CommandDescriptor = {
  name: SCHEDULE_SHOW_COMMAND_NAME,
  summary: "Show a scheduled task for the current session.",
  description: "Shows one session-scoped scheduled task, including full instruction and schedule details.",
  usage: "panda schedule show <task-id>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "task-id",
      description: "Scheduled task id to inspect.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "task-id",
    },
    {
      name: "json",
      description: "Structured JSON object containing taskId.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Show scheduled task details",
      command: "panda schedule show task_123",
    },
    {
      description: "Use JSON input",
      command: "panda schedule show --json '{\"taskId\":\"task_123\"}'",
    },
  ],
  requiredCapabilities: [SCHEDULE_SHOW_COMMAND_NAME],
  resultShape: {
    operation: "show",
    taskId: "string",
    title: "string",
    instruction: "string",
    schedule: "object",
  },
};

export const scheduleRunsCommandDescriptor: CommandDescriptor = {
  name: SCHEDULE_RUNS_COMMAND_NAME,
  summary: "List recent scheduled task runs for the current session.",
  description:
    "Lists compact run history for one session-scoped scheduled task, including status, timestamps, thread linkage, and error text when present.",
  usage: "panda schedule runs <task-id> [--limit <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "task-id",
      description: "Scheduled task id to inspect.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "task-id",
    },
    {
      name: "limit",
      description: "Maximum number of runs to return. Defaults to 25.",
      valueType: "number",
      valueName: "n",
      defaultValue: 25,
    },
    {
      name: "json",
      description: "Structured JSON object containing taskId and optional limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List recent task runs",
      command: "panda schedule runs task_123 --limit 10",
    },
    {
      description: "Use JSON input",
      command: "panda schedule runs --json '{\"taskId\":\"task_123\",\"limit\":10}'",
    },
  ],
  requiredCapabilities: [SCHEDULE_RUNS_COMMAND_NAME],
  resultShape: {
    operation: "runs",
    taskId: "string",
    count: "number",
    runs: [{
      runId: "string",
      status: "claimed|running|succeeded|failed|cancelled",
      scheduledFor: "number",
      threadRunId: "string|absent",
      error: "string|absent",
    }],
  },
};

export const scheduleUpdateCommandDescriptor: CommandDescriptor = {
  name: SCHEDULE_UPDATE_COMMAND_NAME,
  summary: "Update a scheduled task.",
  description: "Updates an existing scheduled task in the current session.",
  usage: "panda schedule update <task-id> [--title <text|@file|@->] [--at <iso>|--cron <expr> --timezone <tz>] [--instruction <text|@file|@->] [--enable|--disable]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "task-id",
      description: "Scheduled task id to update.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "task-id",
    },
    {
      name: "title",
      description: "New task title. Accepts literal text, @file, or @-.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "at",
      description: "Replace the schedule with a one-off ISO timestamp. Mutually exclusive with --cron.",
      valueType: "string",
      valueName: "iso",
    },
    {
      name: "cron",
      description: "Replace the schedule with a recurring cron expression. Requires --timezone.",
      valueType: "string",
      valueName: "expr",
    },
    {
      name: "timezone",
      description: "IANA timezone for recurring cron schedules.",
      valueType: "string",
      valueName: "tz",
    },
    {
      name: "instruction",
      description: "New instruction. Accepts literal text, @file, or @-.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "enable",
      description: "Enable the scheduled task.",
      valueType: "boolean",
    },
    {
      name: "disable",
      description: "Disable the scheduled task.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "Structured JSON object containing taskId and any of title, instruction, schedule, or enabled.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Reschedule a task",
      command: "panda schedule update task_123 --at 2026-05-25T09:00:00+02:00",
    },
    {
      description: "Update instruction from stdin and disable",
      command: "cat instruction.md | panda schedule update task_123 --instruction @- --disable",
    },
    {
      description: "Use JSON input",
      command: "panda schedule update --json '{\"taskId\":\"task_123\",\"enabled\":false}'",
    },
  ],
  requiredCapabilities: ["schedule.update"],
  resultShape: {
    taskId: "string",
    updated: true,
  },
};

export const scheduleCancelCommandDescriptor: CommandDescriptor = {
  name: SCHEDULE_CANCEL_COMMAND_NAME,
  summary: "Cancel a scheduled task.",
  description: "Cancels a scheduled task without deleting its history.",
  usage: "panda schedule cancel <task-id> [--reason <text|@file|@->]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "task-id",
      description: "Scheduled task id to cancel.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "task-id",
    },
    {
      name: "reason",
      description: "Optional reason. Accepts literal text, @file, or @-.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "json",
      description: "Structured JSON object containing taskId and optional reason.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Cancel with a reason",
      command: "panda schedule cancel task_123 --reason \"obsolete\"",
    },
    {
      description: "Use JSON input",
      command: "panda schedule cancel --json '{\"taskId\":\"task_123\",\"reason\":\"obsolete\"}'",
    },
  ],
  requiredCapabilities: ["schedule.cancel"],
  resultShape: {
    taskId: "string",
    cancelled: true,
  },
};

export function createScheduleListCommand(store: ScheduleListStore): RegisteredCommand {
  return {
    descriptor: scheduleListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<ScheduleListCommandOutput>> {
      const input = parseScheduleListCommandInput(request.input);
      const tasks = await store.listTasks({
        sessionId: request.scope.sessionId,
        status: input.status,
        limit: input.limit,
      });

      return {
        ok: true,
        command: SCHEDULE_LIST_COMMAND_NAME,
        output: {
          operation: "list",
          count: tasks.length,
          tasks: tasks.map(serializeTaskSummary),
        },
        summary: `Listed ${tasks.length} scheduled task${tasks.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

export function createScheduleShowCommand(store: ScheduleShowStore): RegisteredCommand {
  return {
    descriptor: scheduleShowCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<ScheduleShowCommandOutput>> {
      const input = parseScheduleShowCommandInput(request.input);
      const task = await store.getTask(input.taskId);
      assertTaskInSession(task, request);

      return {
        ok: true,
        command: SCHEDULE_SHOW_COMMAND_NAME,
        output: {
          operation: "show",
          ...serializeTaskDetail(task),
          taskId: task.id,
        },
        summary: `Showed scheduled task ${task.id}.`,
      };
    },
  };
}

export function createScheduleRunsCommand(store: ScheduleRunsStore): RegisteredCommand {
  return {
    descriptor: scheduleRunsCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<ScheduleRunsCommandOutput>> {
      const input = parseScheduleRunsCommandInput(request.input);
      const task = await store.getTask(input.taskId);
      assertTaskInSession(task, request);
      const runs = await store.listTaskRuns({
        taskId: input.taskId,
        sessionId: request.scope.sessionId,
        limit: input.limit,
      });

      return {
        ok: true,
        command: SCHEDULE_RUNS_COMMAND_NAME,
        output: {
          operation: "runs",
          taskId: task.id,
          count: runs.length,
          runs: runs.map(serializeTaskRun),
        },
        summary: `Listed ${runs.length} run${runs.length === 1 ? "" : "s"} for scheduled task ${task.id}.`,
      };
    },
  };
}

export function createScheduleCreateCommand(store: ScheduleCreateStore): RegisteredCommand {
  return {
    descriptor: scheduleCreateCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<ScheduleCreateCommandOutput>> {
      const input = parseScheduleCreateCommandInput(request.input);
      const task = await store.createTask({
        sessionId: request.scope.sessionId,
        createdByIdentityId: request.scope.identityId,
        createdFromMessageId: request.scope.inputMessageId,
        title: input.title,
        instruction: input.instruction,
        schedule: input.schedule,
        enabled: input.enabled,
      });

      return {
        ok: true,
        command: SCHEDULE_CREATE_COMMAND_NAME,
        output: {
          taskId: task.id,
        },
        summary: `Created scheduled task ${task.id}.`,
      };
    },
  };
}

export function createScheduleUpdateCommand(store: ScheduleUpdateStore): RegisteredCommand {
  return {
    descriptor: scheduleUpdateCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<ScheduleUpdateCommandOutput>> {
      const input = parseScheduleUpdateCommandInput(request.input);
      const task = await store.updateTask({
        sessionId: request.scope.sessionId,
        taskId: input.taskId,
        title: input.title,
        instruction: input.instruction,
        schedule: input.schedule,
        enabled: input.enabled,
      });

      return {
        ok: true,
        command: SCHEDULE_UPDATE_COMMAND_NAME,
        output: {
          taskId: task.id,
          updated: true,
        },
        summary: `Updated scheduled task ${task.id}.`,
      };
    },
  };
}

export function createScheduleCancelCommand(store: ScheduleCancelStore): RegisteredCommand {
  return {
    descriptor: scheduleCancelCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<ScheduleCancelCommandOutput>> {
      const input = parseScheduleCancelCommandInput(request.input);
      const task = await store.cancelTask({
        sessionId: request.scope.sessionId,
        taskId: input.taskId,
        reason: input.reason,
      });

      return {
        ok: true,
        command: SCHEDULE_CANCEL_COMMAND_NAME,
        output: {
          taskId: task.id,
          cancelled: true,
        },
        summary: `Cancelled scheduled task ${task.id}.`,
      };
    },
  };
}
