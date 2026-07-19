import type {JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import type {
  SubagentInventoryEnvironment,
  SubagentInventoryReader,
  SubagentInventoryRecord,
  SubagentInventoryRunStatusFilter,
} from "./inventory.js";
import {SUBAGENT_SPAWN_COMMAND_NAME} from "./commands.js";

export const SUBAGENT_LIST_COMMAND_NAME = "subagent.list";
export const SUBAGENT_SHOW_COMMAND_NAME = "subagent.show";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

function requireInputObject(input: unknown, commandName: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(`${commandName} input must be a JSON object.`);
  }
  return input;
}

function rejectUnexpectedKeys(
  input: Record<string, unknown>,
  commandName: string,
  allowedKeys: ReadonlySet<string>,
): void {
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${commandName} does not accept ${key}.`);
    }
  }
}

function readRunStatus(value: unknown): SubagentInventoryRunStatusFilter {
  if (value === undefined || value === null) return "all";
  if (value === "running" || value === "completed" || value === "failed" || value === "all") {
    return value;
  }
  throw new Error("subagent.list runStatus must be running, completed, failed, or all.");
}

function readLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LIST_LIMIT) {
    throw new Error(`subagent.list limit must be an integer from 1 to ${MAX_LIST_LIMIT}.`);
  }
  return value as number;
}

function parseListInput(input: unknown): {runStatus: SubagentInventoryRunStatusFilter; limit: number} {
  const object = requireInputObject(input, SUBAGENT_LIST_COMMAND_NAME);
  rejectUnexpectedKeys(object, SUBAGENT_LIST_COMMAND_NAME, new Set(["runStatus", "limit"]));
  return {
    runStatus: readRunStatus(object.runStatus),
    limit: readLimit(object.limit),
  };
}

function parseShowInput(input: unknown): {sessionId: string} {
  const object = requireInputObject(input, SUBAGENT_SHOW_COMMAND_NAME);
  rejectUnexpectedKeys(object, SUBAGENT_SHOW_COMMAND_NAME, new Set(["sessionId"]));
  return {
    sessionId: requireNonEmptyString(object.sessionId, "subagent.show sessionId must not be empty."),
  };
}

function compactEnvironment(environment: SubagentInventoryEnvironment | null): JsonObject | null {
  if (!environment) return null;
  return {
    environmentId: environment.id,
    alias: environment.alias,
    state: environment.state,
  };
}

function expandedEnvironment(environment: SubagentInventoryEnvironment | null): JsonObject | null {
  if (!environment) return null;
  return {
    ...compactEnvironment(environment),
    runnerCwd: environment.runnerCwd,
    rootPath: environment.rootPath,
    expiresAt: environment.expiresAt,
    paths: environment.paths,
  };
}

function serializeRecord(
  record: SubagentInventoryRecord,
  options: {expandedEnvironment?: boolean} = {},
): JsonObject {
  return {
    sessionId: record.sessionId,
    currentThreadId: record.currentThreadId,
    profile: record.profile,
    execution: record.execution,
    taskPreview: record.taskPreview,
    startedAt: record.startedAt,
    messageCount: record.messageCount,
    pendingInputCount: record.pendingInputCount,
    lastMessageAt: record.lastMessageAt,
    latestRun: record.latestRun
      ? {
        id: record.latestRun.id,
        status: record.latestRun.status,
        startedAt: record.latestRun.startedAt,
        finishedAt: record.latestRun.finishedAt,
        errorSummary: record.latestRun.errorSummary,
      }
      : null,
    environment: options.expandedEnvironment
      ? expandedEnvironment(record.environment)
      : compactEnvironment(record.environment),
  };
}

export const subagentListCommandDescriptor: CommandDescriptor = {
  name: SUBAGENT_LIST_COMMAND_NAME,
  summary: "List durable child subagent state.",
  description: "Lists direct child subagent sessions for the current parent session with bounded task, latest-run, message, and environment facts.",
  usage: "panda subagent list [--run-status running|completed|failed|all] [--limit <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "run-status",
      description: "Filter by latest run status. Sessions without a run are included only with all.",
      valueType: "string",
      valueName: "running|completed|failed|all",
      enumValues: ["running", "completed", "failed", "all"],
      defaultValue: "all",
    },
    {
      name: "limit",
      description: `Maximum subagents to return, 1-${MAX_LIST_LIMIT}.`,
      valueType: "number",
      valueName: "n",
      minimum: 1,
      maximum: MAX_LIST_LIMIT,
      defaultValue: DEFAULT_LIST_LIMIT,
    },
    {
      name: "json",
      description: "Structured JSON object containing optional runStatus and limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List recent child state",
      command: "panda subagent list",
    },
    {
      description: "List failed children",
      command: "panda subagent list --run-status failed --limit 10",
    },
  ],
  requiredCapabilities: [SUBAGENT_SPAWN_COMMAND_NAME],
  resultShape: {
    operation: "list",
    count: "number",
    hasMore: "boolean",
    subagents: [{
      sessionId: "string",
      currentThreadId: "string",
      profile: "string",
      execution: "agent_workspace|isolated_environment",
      latestRun: "object|null",
      environment: "object|null",
    }],
  },
};

export const subagentShowCommandDescriptor: CommandDescriptor = {
  name: SUBAGENT_SHOW_COMMAND_NAME,
  summary: "Show one durable child subagent.",
  description: "Shows bounded state for one direct child subagent of the current parent session, including its latest run and attached environment.",
  usage: "panda subagent show <session-id>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "session-id",
      description: "Direct child subagent session id.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "session-id",
    },
    {
      name: "json",
      description: "Structured JSON object containing sessionId.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Inspect one child",
      command: "panda subagent show 00000000-0000-0000-0000-000000000000",
    },
  ],
  requiredCapabilities: [SUBAGENT_SPAWN_COMMAND_NAME],
  resultShape: {
    operation: "show",
    sessionId: "string",
    currentThreadId: "string",
    profile: "string",
    execution: "agent_workspace|isolated_environment",
    latestRun: "object|null",
    environment: "object|null",
  },
};

export function createSubagentListCommand(inventory: SubagentInventoryReader): RegisteredCommand {
  return {
    descriptor: subagentListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseListInput(request.input);
      const result = await inventory.list({
        agentKey: request.scope.agentKey,
        parentSessionId: request.scope.sessionId,
        runStatus: input.runStatus,
        limit: input.limit,
      });
      const output = {
        operation: "list",
        count: result.records.length,
        hasMore: result.hasMore,
        subagents: result.records.map((record) => serializeRecord(record)),
      } satisfies JsonObject;

      return {
        ok: true,
        command: SUBAGENT_LIST_COMMAND_NAME,
        output,
        summary: `Listed ${result.records.length} subagent${result.records.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

export function createSubagentShowCommand(inventory: SubagentInventoryReader): RegisteredCommand {
  return {
    descriptor: subagentShowCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseShowInput(request.input);
      const record = await inventory.show({
        agentKey: request.scope.agentKey,
        parentSessionId: request.scope.sessionId,
        sessionId: input.sessionId,
      });
      if (!record) {
        throw new Error(`Subagent session ${input.sessionId} was not found.`);
      }
      const output = {
        operation: "show",
        ...serializeRecord(record, {expandedEnvironment: true}),
      } satisfies JsonObject;

      return {
        ok: true,
        command: SUBAGENT_SHOW_COMMAND_NAME,
        output,
        summary: `Showed subagent session ${record.sessionId}.`,
      };
    },
  };
}
