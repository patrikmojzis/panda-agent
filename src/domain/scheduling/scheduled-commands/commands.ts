import {optionalNonEmptyString, requireNonEmptyString} from "../../../lib/strings.js";
import type {JsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import {SCHEDULED_COMMAND_STORAGE_NOTICE} from "../../../prompts/runtime/scheduled-commands.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../../commands/types.js";
import type {ScheduledCommandActor, ScheduledCommandService} from "./service.js";
import type {ScheduledCommandListStatus, ScheduledCommandRecord, ScheduledCommandRunRecord} from "./types.js";

export const CRON_LIST_COMMAND_NAME = "cron.list";
export const CRON_SHOW_COMMAND_NAME = "cron.show";
export const CRON_RUNS_COMMAND_NAME = "cron.runs";
export const CRON_CREATE_COMMAND_NAME = "cron.create";
export const CRON_UPDATE_COMMAND_NAME = "cron.update";
export const CRON_ENABLE_COMMAND_NAME = "cron.enable";
export const CRON_DISABLE_COMMAND_NAME = "cron.disable";
export const CRON_DELETE_COMMAND_NAME = "cron.delete";
export const CRON_RUN_COMMAND_NAME = "cron.run";

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return value === undefined || value === null ? undefined : requiredPositiveInteger(value, label);
}

function credentials(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  throw new Error(`${label} must be a comma-separated string or string array.`);
}

function objectInput(input: unknown, label: string): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`${label} input must be a JSON object.`);
  return input;
}

function actor(request: CommandRequest): ScheduledCommandActor {
  return {
    sessionId: request.scope.sessionId,
    agentKey: request.scope.agentKey,
    identityId: request.scope.identityId,
    inputMessageId: request.scope.inputMessageId,
    credentialPolicy: request.scope.credentialPolicy,
  };
}

function serializeSummary(service: ScheduledCommandService, record: ScheduledCommandRecord): JsonObject {
  const valid = service.verifyDefinition(record);
  return {
    commandId: record.commandId,
    version: record.version,
    title: valid ? record.title : "[integrity check failed]",
    enabled: record.enabled,
    integrityValid: valid,
    ...(record.nextFireAt === undefined ? {} : {nextFireAt: record.nextFireAt}),
    ...(record.blockedAt === undefined ? {} : {blockedAt: record.blockedAt}),
    ...(valid && record.blockedReason !== undefined ? {blockedReason: record.blockedReason} : {}),
    consecutiveFailures: record.consecutiveFailures,
    ...(record.lastFailureCode ? {lastFailureCode: record.lastFailureCode} : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeDetail(service: ScheduledCommandService, record: ScheduledCommandRecord): JsonObject {
  const summary = serializeSummary(service, record);
  if (summary.integrityValid !== true) return summary;
  return {
    ...summary,
    command: record.command,
    ...(record.cwd ? {cwd: record.cwd} : {}),
    cron: record.cron,
    timezone: record.timezone,
    credentials: [...record.credentialNames],
    timeoutMs: record.timeoutMs,
  };
}

function serializeRun(run: ScheduledCommandRunRecord): JsonObject {
  return {
    runId: run.id,
    version: run.version,
    trigger: run.trigger,
    scheduledFor: run.scheduledFor,
    status: run.status,
    ...(run.resolvedEnvironmentId ? {resolvedEnvironmentId: run.resolvedEnvironmentId} : {}),
    ...(run.resolvedCwd ? {resolvedCwd: run.resolvedCwd} : {}),
    ...(run.exitCode === undefined ? {} : {exitCode: run.exitCode}),
    ...(run.timedOut === undefined ? {} : {timedOut: run.timedOut}),
    ...(run.stdout === undefined ? {} : {stdout: run.stdout}),
    ...(run.stderr === undefined ? {} : {stderr: run.stderr}),
    ...(run.stdoutTruncated === undefined ? {} : {stdoutTruncated: run.stdoutTruncated}),
    ...(run.stderrTruncated === undefined ? {} : {stderrTruncated: run.stderrTruncated}),
    ...(run.failureCode ? {failureCode: run.failureCode} : {}),
    ...(run.error ? {error: run.error} : {}),
    ...(run.notificationKind ? {notificationKind: run.notificationKind} : {}),
    ...(run.notifiedAt === undefined ? {} : {notifiedAt: run.notifiedAt}),
    createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : {startedAt: run.startedAt}),
    ...(run.finishedAt === undefined ? {} : {finishedAt: run.finishedAt}),
  };
}

const jsonArgument = {
  name: "json",
  description: "Structured JSON command input.",
  valueType: "json" as const,
};
const commandIdArgument = {
  name: "command-id",
  description: "Scheduled command id.",
  required: true,
  kind: "positional" as const,
  valueType: "string" as const,
  valueName: "command-id",
};
const expectedVersionArgument = {
  name: "expected-version",
  description: "Expected immutable definition version.",
  required: true,
  valueType: "number" as const,
  valueName: "n",
  minimum: 1,
};

function descriptor(input: Pick<CommandDescriptor, "name" | "summary" | "description" | "usage" | "arguments" | "examples" | "resultShape">): CommandDescriptor {
  return {...input, inputModes: ["flags", "json", "stdin", "file"], outputModes: ["json", "text"], requiredCapabilities: [input.name]};
}

export const cronListCommandDescriptor = descriptor({
  name: CRON_LIST_COMMAND_NAME,
  summary: "List mechanical scheduled commands.",
  description: "Lists durable commands owned by the current session.",
  usage: "panda cron list [--status active|disabled|blocked|all] [--limit <n>]",
  arguments: [
    {name: "status", description: "Status filter.", valueType: "string", enumValues: ["active", "disabled", "blocked", "all"], defaultValue: "active"},
    {name: "limit", description: "Maximum results, up to 100.", valueType: "number", defaultValue: 25, minimum: 1, maximum: 100},
    jsonArgument,
  ],
  examples: [{description: "List active commands", command: "panda cron list"}],
  resultShape: {operation: "list", count: "number", commands: "array"},
});

export const cronShowCommandDescriptor = descriptor({
  name: CRON_SHOW_COMMAND_NAME,
  summary: "Show a mechanical scheduled command.",
  description: "Shows the active immutable version and integrity status for one session-owned command.",
  usage: "panda cron show <command-id>",
  arguments: [commandIdArgument, jsonArgument],
  examples: [{description: "Inspect a command", command: "panda cron show <command-id>"}],
  resultShape: {operation: "show", commandId: "string", version: "number", integrityValid: "boolean"},
});

export const cronRunsCommandDescriptor = descriptor({
  name: CRON_RUNS_COMMAND_NAME,
  summary: "List mechanical scheduled command runs.",
  description: "Lists bounded, redacted run results for one session-owned command.",
  usage: "panda cron runs <command-id> [--limit <n>]",
  arguments: [commandIdArgument, {name: "limit", description: "Maximum results, up to 100.", valueType: "number", defaultValue: 25, minimum: 1, maximum: 100}, jsonArgument],
  examples: [{description: "Inspect recent runs", command: "panda cron runs <command-id> --limit 10"}],
  resultShape: {operation: "runs", commandId: "string", count: "number", runs: "array"},
});

export const cronCreateCommandDescriptor = descriptor({
  name: CRON_CREATE_COMMAND_NAME,
  summary: "Create a mechanical scheduled command.",
  description: `Creates a signed recurring command in the current session's default remote execution environment. ${SCHEDULED_COMMAND_STORAGE_NOTICE}`,
  usage: "panda cron create <title> --cron <expr> --timezone <tz> --command <text|@file|@-> [--cwd <path>] [--credentials <csv>] [--timeout-ms <n>] [--disabled]",
  arguments: [
    {name: "title", description: "Command title.", required: true, kind: "positional", valueType: "string"},
    {name: "cron", description: "Five-field cron expression.", required: true, valueType: "string"},
    {name: "timezone", description: "IANA timezone.", required: true, valueType: "string"},
    {name: "command", description: "Shell command; accepts literal, @file, or @-. File/stdin input copies contents only; referenced files are not bundled.", required: true, valueType: "string", valueSources: ["literal", "file", "stdin"]},
    {name: "cwd", description: "Working directory, absolute or relative to the default target's initial cwd.", valueType: "string"},
    {name: "credentials", description: "Comma-separated stored credential environment names.", valueType: "string"},
    {name: "timeout-ms", description: "Execution timeout in milliseconds.", valueType: "number", minimum: 1000, maximum: 21600000, defaultValue: 300000},
    {name: "disabled", description: "Create without scheduling occurrences.", valueType: "boolean"},
    jsonArgument,
  ],
  examples: [{description: "Refresh gas prices hourly", command: "panda cron create \"sync gas prices\" --cron \"0 * * * *\" --timezone Europe/Bratislava --command @scripts/sync-gas.sh --credentials GAS_API_TOKEN,METABASE_DATABASE_URL"}],
  resultShape: {commandId: "string", version: "number", enabled: "boolean", storageNotice: "string"},
});

export const cronUpdateCommandDescriptor = descriptor({
  name: CRON_UPDATE_COMMAND_NAME,
  summary: "Replace a mechanical scheduled command definition.",
  description: `Creates a newly signed immutable version after a live credential preflight. ${SCHEDULED_COMMAND_STORAGE_NOTICE}`,
  usage: "panda cron update <command-id> --expected-version <n> [--title <text>] [--cron <expr>] [--timezone <tz>] [--command <text|@file|@->] [--cwd <path>] [--credentials <csv>] [--timeout-ms <n>]",
  arguments: [commandIdArgument, expectedVersionArgument,
    {name: "title", description: "New title.", valueType: "string"},
    {name: "cron", description: "New cron expression.", valueType: "string"},
    {name: "timezone", description: "New IANA timezone.", valueType: "string"},
    {name: "command", description: "New shell command; accepts literal, @file, or @-. File/stdin input copies contents only; referenced files are not bundled.", valueType: "string", valueSources: ["literal", "file", "stdin"]},
    {name: "cwd", description: "New working directory, absolute or relative to the default target's initial cwd.", valueType: "string"},
    {name: "credentials", description: "Replacement comma-separated credential names.", valueType: "string"},
    {name: "timeout-ms", description: "New timeout in milliseconds.", valueType: "number", minimum: 1000, maximum: 21600000},
    jsonArgument],
  examples: [{description: "Update a script", command: "panda cron update <command-id> --expected-version 1 --command @scripts/sync-gas.sh"}],
  resultShape: {commandId: "string", version: "number", updated: true, storageNotice: "string"},
});

function stateDescriptor(name: typeof CRON_ENABLE_COMMAND_NAME | typeof CRON_DISABLE_COMMAND_NAME, enabled: boolean): CommandDescriptor {
  return descriptor({
    name,
    summary: `${enabled ? "Enable" : "Disable"} a mechanical scheduled command.`,
    description: `Creates a signed immutable version with scheduling ${enabled ? "enabled" : "disabled"}.${enabled ? ` ${SCHEDULED_COMMAND_STORAGE_NOTICE}` : ""}`,
    usage: `panda cron ${enabled ? "enable" : "disable"} <command-id> --expected-version <n>`,
    arguments: [commandIdArgument, expectedVersionArgument, jsonArgument],
    examples: [{description: `${enabled ? "Enable" : "Disable"} a command`, command: `panda cron ${enabled ? "enable" : "disable"} <command-id> --expected-version 1`}],
    resultShape: {commandId: "string", version: "number", enabled, ...(enabled ? {storageNotice: "string"} : {})},
  });
}

export const cronEnableCommandDescriptor = stateDescriptor(CRON_ENABLE_COMMAND_NAME, true);
export const cronDisableCommandDescriptor = stateDescriptor(CRON_DISABLE_COMMAND_NAME, false);

export const cronDeleteCommandDescriptor = descriptor({
  name: CRON_DELETE_COMMAND_NAME,
  summary: "Delete a mechanical scheduled command.",
  description: "Deletes the command, versions, and run history. Session deletion also cascades all commands.",
  usage: "panda cron delete <command-id> --expected-version <n>",
  arguments: [commandIdArgument, expectedVersionArgument, jsonArgument],
  examples: [{description: "Delete a command", command: "panda cron delete <command-id> --expected-version 1"}],
  resultShape: {commandId: "string", deleted: true},
});

export const cronRunCommandDescriptor = descriptor({
  name: CRON_RUN_COMMAND_NAME,
  summary: "Queue a mechanical scheduled command now.",
  description: "Queues one manual occurrence, including for a disabled command, after live authority preflight.",
  usage: "panda cron run <command-id> --expected-version <n>",
  arguments: [commandIdArgument, expectedVersionArgument, jsonArgument],
  examples: [{description: "Test a command now", command: "panda cron run <command-id> --expected-version 1"}],
  resultShape: {commandId: "string", runId: "string", queued: true},
});

export function createCronListCommand(service: ScheduledCommandService): RegisteredCommand {
  return {descriptor: cronListCommandDescriptor, async execute(request): Promise<CommandSuccess<JsonObject>> {
    const input = objectInput(request.input, CRON_LIST_COMMAND_NAME);
    const rawStatus = input.status;
    if (rawStatus !== undefined && !["active", "disabled", "blocked", "all"].includes(String(rawStatus))) {
      throw new Error("cron.list status must be active, disabled, blocked, or all.");
    }
    const commands = await service.list(request.scope.sessionId, rawStatus as ScheduledCommandListStatus | undefined,
      optionalPositiveInteger(input.limit, "cron.list limit"));
    return {ok: true, command: CRON_LIST_COMMAND_NAME,
      output: {operation: "list", count: commands.length, commands: commands.map((record) => serializeSummary(service, record))},
      summary: `Listed ${commands.length} mechanical scheduled command${commands.length === 1 ? "" : "s"}.`};
  }};
}

export function createCronShowCommand(service: ScheduledCommandService): RegisteredCommand {
  return {descriptor: cronShowCommandDescriptor, async execute(request): Promise<CommandSuccess<JsonObject>> {
    const input = objectInput(request.input, CRON_SHOW_COMMAND_NAME);
    const record = await service.show(request.scope.sessionId, requireNonEmptyString(input.commandId, "cron.show commandId must not be empty."));
    return {ok: true, command: CRON_SHOW_COMMAND_NAME, output: {operation: "show", ...serializeDetail(service, record)}, summary: `Showed mechanical scheduled command ${record.commandId}.`};
  }};
}

export function createCronRunsCommand(service: ScheduledCommandService): RegisteredCommand {
  return {descriptor: cronRunsCommandDescriptor, async execute(request): Promise<CommandSuccess<JsonObject>> {
    const input = objectInput(request.input, CRON_RUNS_COMMAND_NAME);
    const commandId = requireNonEmptyString(input.commandId, "cron.runs commandId must not be empty.");
    const runs = await service.runs(request.scope.sessionId, commandId, optionalPositiveInteger(input.limit, "cron.runs limit"));
    return {ok: true, command: CRON_RUNS_COMMAND_NAME, output: {operation: "runs", commandId, count: runs.length, runs: runs.map(serializeRun)}, summary: `Listed ${runs.length} run${runs.length === 1 ? "" : "s"} for ${commandId}.`};
  }};
}

export function createCronCreateCommand(service: ScheduledCommandService): RegisteredCommand {
  return {descriptor: cronCreateCommandDescriptor, async execute(request): Promise<CommandSuccess<JsonObject>> {
    const input = objectInput(request.input, CRON_CREATE_COMMAND_NAME);
    const enabled = optionalBoolean(input.enabled, "cron.create enabled");
    const disabled = optionalBoolean(input.disabled, "cron.create disabled");
    if (enabled !== undefined && disabled !== undefined) {
      throw new Error("cron.create accepts enabled or disabled, not both.");
    }
    const record = await service.create(actor(request), {
      title: requireNonEmptyString(input.title, "cron.create title must not be empty."),
      command: requireNonEmptyString(input.command, "cron.create command must not be empty."),
      cwd: optionalNonEmptyString(input.cwd, "cron.create cwd must not be empty."),
      cron: requireNonEmptyString(input.cron, "cron.create cron must not be empty."),
      timezone: requireNonEmptyString(input.timezone, "cron.create timezone must not be empty."),
      credentialNames: credentials(input.credentials ?? input.credentialNames, "cron.create credentials"),
      timeoutMs: optionalPositiveInteger(input.timeoutMs, "cron.create timeoutMs"),
      enabled: enabled ?? !(disabled ?? false),
    });
    return {ok: true, command: CRON_CREATE_COMMAND_NAME, output: {commandId: record.commandId, version: record.version, enabled: record.enabled, storageNotice: SCHEDULED_COMMAND_STORAGE_NOTICE}, summary: `Created mechanical scheduled command ${record.commandId}.`};
  }};
}

export function createCronUpdateCommand(service: ScheduledCommandService): RegisteredCommand {
  return {descriptor: cronUpdateCommandDescriptor, async execute(request): Promise<CommandSuccess<JsonObject>> {
    const input = objectInput(request.input, CRON_UPDATE_COMMAND_NAME);
    const record = await service.update(actor(request), requireNonEmptyString(input.commandId, "cron.update commandId must not be empty."), {
      expectedVersion: requiredPositiveInteger(input.expectedVersion, "cron.update expectedVersion"),
      title: optionalNonEmptyString(input.title, "cron.update title must not be empty."),
      command: optionalNonEmptyString(input.command, "cron.update command must not be empty."),
      cwd: input.cwd === null ? null : optionalNonEmptyString(input.cwd, "cron.update cwd must not be empty."),
      cron: optionalNonEmptyString(input.cron, "cron.update cron must not be empty."),
      timezone: optionalNonEmptyString(input.timezone, "cron.update timezone must not be empty."),
      credentialNames: credentials(input.credentials ?? input.credentialNames, "cron.update credentials"),
      timeoutMs: optionalPositiveInteger(input.timeoutMs, "cron.update timeoutMs"),
    });
    return {ok: true, command: CRON_UPDATE_COMMAND_NAME, output: {commandId: record.commandId, version: record.version, updated: true, storageNotice: SCHEDULED_COMMAND_STORAGE_NOTICE}, summary: `Updated mechanical scheduled command ${record.commandId} to version ${record.version}.`};
  }};
}

function createStateCommand(service: ScheduledCommandService, enabled: boolean): RegisteredCommand {
  const name = enabled ? CRON_ENABLE_COMMAND_NAME : CRON_DISABLE_COMMAND_NAME;
  const commandDescriptor = enabled ? cronEnableCommandDescriptor : cronDisableCommandDescriptor;
  return {descriptor: commandDescriptor, async execute(request): Promise<CommandSuccess<JsonObject>> {
    const input = objectInput(request.input, name);
    const record = await service.setEnabled(actor(request), requireNonEmptyString(input.commandId, `${name} commandId must not be empty.`), enabled,
      requiredPositiveInteger(input.expectedVersion, `${name} expectedVersion`));
    return {ok: true, command: name, output: {commandId: record.commandId, version: record.version, enabled, ...(enabled ? {storageNotice: SCHEDULED_COMMAND_STORAGE_NOTICE} : {})}, summary: `${enabled ? "Enabled" : "Disabled"} mechanical scheduled command ${record.commandId}.`};
  }};
}

export const createCronEnableCommand = (service: ScheduledCommandService): RegisteredCommand => createStateCommand(service, true);
export const createCronDisableCommand = (service: ScheduledCommandService): RegisteredCommand => createStateCommand(service, false);

export function createCronDeleteCommand(service: ScheduledCommandService): RegisteredCommand {
  return {descriptor: cronDeleteCommandDescriptor, async execute(request): Promise<CommandSuccess<JsonObject>> {
    const input = objectInput(request.input, CRON_DELETE_COMMAND_NAME);
    const commandId = requireNonEmptyString(input.commandId, "cron.delete commandId must not be empty.");
    await service.delete({sessionId: request.scope.sessionId}, commandId, requiredPositiveInteger(input.expectedVersion, "cron.delete expectedVersion"));
    return {ok: true, command: CRON_DELETE_COMMAND_NAME, output: {commandId, deleted: true}, summary: `Deleted mechanical scheduled command ${commandId} and its history.`};
  }};
}

export function createCronRunCommand(service: ScheduledCommandService): RegisteredCommand {
  return {descriptor: cronRunCommandDescriptor, async execute(request): Promise<CommandSuccess<JsonObject>> {
    const input = objectInput(request.input, CRON_RUN_COMMAND_NAME);
    const commandId = requireNonEmptyString(input.commandId, "cron.run commandId must not be empty.");
    const run = await service.runNow(actor(request), commandId, requiredPositiveInteger(input.expectedVersion, "cron.run expectedVersion"));
    return {ok: true, command: CRON_RUN_COMMAND_NAME, output: {commandId, runId: run.id, queued: true}, summary: `Queued mechanical scheduled command ${commandId} as run ${run.id}.`};
  }};
}
