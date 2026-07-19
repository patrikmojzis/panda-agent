import {constants as fsConstants} from "node:fs";
import {access, stat} from "node:fs/promises";

import type {JsonObject} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {commandScopeDenied} from "../commands/errors.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import type {CommandFileResolver} from "../commands/files.js";
import type {ExecutionEnvironmentStore} from "./store.js";
import type {DisposableEnvironmentLogsResult, ExecutionEnvironmentRecord, ExecutionEnvironmentState} from "./types.js";
import {readExecutionEnvironmentFilesystemMetadata} from "./filesystem.js";
import {
  readExecutionEnvironmentSetupMetadata,
  SETUP_SCRIPT_INSPECTION_NOTE,
  type ExecutionEnvironmentSetupScriptInput,
} from "./setup.js";

export const ENVIRONMENT_CREATE_COMMAND_NAME = "environment.create";
export const ENVIRONMENT_LIST_COMMAND_NAME = "environment.list";
export const ENVIRONMENT_SHOW_COMMAND_NAME = "environment.show";
export const ENVIRONMENT_STOP_COMMAND_NAME = "environment.stop";
export const ENVIRONMENT_LOGS_COMMAND_NAME = "environment.logs";

const DEFAULT_ENVIRONMENT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_ENVIRONMENT_TTL_HOURS = 24 * 30;
const DEFAULT_ENVIRONMENT_LOG_TAIL = 200;
const MAX_ENVIRONMENT_LOG_TAIL = 1_000;

const ENVIRONMENT_ID_POSITIONAL_ARGUMENT = {
  name: "environment-id",
  description: "Disposable execution environment id.",
  required: true,
  kind: "positional" as const,
  valueType: "string" as const,
  valueName: "environment-id",
};

const ENVIRONMENT_JSON_ARGUMENT = {
  name: "json",
  description: "Structured JSON object for this command.",
  valueType: "json" as const,
};

export interface EnvironmentCreateCommandInput {
  label?: string;
  ttlHours?: number;
  setupScript?: string;
}

export interface EnvironmentStopCommandInput {
  environmentId: string;
}

export interface EnvironmentListCommandInput {
  state?: ExecutionEnvironmentState;
}

export interface EnvironmentShowCommandInput {
  environmentId: string;
}

export interface EnvironmentLogsCommandInput {
  environmentId: string;
  role?: "control" | "workspace" | "all";
  tail?: number;
}

export interface EnvironmentCommandLifecycle {
  createStandaloneDisposableEnvironment(input: {
    agentKey: string;
    createdBySessionId: string;
    ttlMs?: number;
    metadata?: JsonObject;
    setupScript?: ExecutionEnvironmentSetupScriptInput;
  }): Promise<ExecutionEnvironmentRecord>;
  stopEnvironment(environmentId: string): Promise<ExecutionEnvironmentRecord>;
  readEnvironmentLogs(input: {
    environmentId: string;
    role?: "control" | "workspace" | "all";
    tail?: number;
  }): Promise<DisposableEnvironmentLogsResult>;
}

export interface EnvironmentCommandServices {
  environments: Pick<ExecutionEnvironmentStore, "getEnvironment" | "listDisposableEnvironmentsByOwner">;
  lifecycle: Pick<EnvironmentCommandLifecycle, "stopEnvironment">;
}

export interface EnvironmentCreateCommandServices {
  lifecycle: Pick<EnvironmentCommandLifecycle, "createStandaloneDisposableEnvironment">;
}

export interface EnvironmentReadCommandServices {
  environments: Pick<ExecutionEnvironmentStore, "getEnvironment" | "listDisposableEnvironmentsByOwner">;
}

export interface EnvironmentLogsCommandServices {
  environments: Pick<ExecutionEnvironmentStore, "getEnvironment">;
  lifecycle: Pick<EnvironmentCommandLifecycle, "readEnvironmentLogs">;
}

function compactObject<T extends Record<string, unknown>>(value: T): JsonObject {
  const compacted = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
  if (isJsonObject(compacted)) {
    return compacted;
  }

  throw new Error("Environment command payload must be a JSON object.");
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

function readOptionalTtlHours(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_ENVIRONMENT_TTL_HOURS) {
    throw new Error(`environment.create ttlHours must be a positive number up to ${MAX_ENVIRONMENT_TTL_HOURS}.`);
  }

  return value;
}

function readOptionalEnvironmentState(value: unknown): ExecutionEnvironmentState | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    value === "provisioning"
    || value === "ready"
    || value === "failed"
    || value === "stopping"
    || value === "stopped"
  ) {
    return value;
  }

  throw new Error("environment.list state must be one of provisioning, ready, failed, stopping, or stopped.");
}

function readOptionalLogRole(value: unknown): EnvironmentLogsCommandInput["role"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "control" || value === "workspace" || value === "all") {
    return value;
  }

  throw new Error("environment.logs role must be control, workspace, or all.");
}

function readOptionalLogTail(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_ENVIRONMENT_LOG_TAIL) {
    throw new Error(`environment.logs tail must be an integer between 1 and ${MAX_ENVIRONMENT_LOG_TAIL}.`);
  }

  return value;
}

function requireInputObject(input: unknown, label: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(`${label} input must be a JSON object.`);
  }

  return input;
}

function parseEnvironmentCreateInput(input: unknown): EnvironmentCreateCommandInput {
  const object = requireInputObject(input, ENVIRONMENT_CREATE_COMMAND_NAME);
  const label = readOptionalString(object.label, "environment.create label");
  const setupScript = readOptionalString(object.setupScript, "environment.create setupScript");
  const ttlHours = readOptionalTtlHours(object.ttlHours);

  return {
    ...(label ? {label} : {}),
    ...(ttlHours === undefined ? {} : {ttlHours}),
    ...(setupScript ? {setupScript} : {}),
  };
}

function parseEnvironmentListInput(input: unknown): EnvironmentListCommandInput {
  const object = requireInputObject(input, ENVIRONMENT_LIST_COMMAND_NAME);
  const state = readOptionalEnvironmentState(object.state);
  return {
    ...(state ? {state} : {}),
  };
}

function parseEnvironmentShowInput(input: unknown): EnvironmentShowCommandInput {
  const object = requireInputObject(input, ENVIRONMENT_SHOW_COMMAND_NAME);

  return {
    environmentId: readRequiredString(object.environmentId, "environment.show environmentId"),
  };
}

function parseEnvironmentStopInput(input: unknown): EnvironmentStopCommandInput {
  const object = requireInputObject(input, ENVIRONMENT_STOP_COMMAND_NAME);

  return {
    environmentId: readRequiredString(object.environmentId, "environment.stop environmentId"),
  };
}

function parseEnvironmentLogsInput(input: unknown): EnvironmentLogsCommandInput {
  const object = requireInputObject(input, ENVIRONMENT_LOGS_COMMAND_NAME);
  const role = readOptionalLogRole(object.role);
  const tail = readOptionalLogTail(object.tail);

  return {
    environmentId: readRequiredString(object.environmentId, "environment.logs environmentId"),
    ...(role ? {role} : {}),
    ...(tail === undefined ? {} : {tail}),
  };
}

function readParentVisiblePaths(environment: ExecutionEnvironmentRecord): JsonObject | undefined {
  const filesystem = readExecutionEnvironmentFilesystemMetadata(environment.metadata);
  if (!filesystem) {
    return undefined;
  }

  return compactObject({
    root: filesystem.root.parentRunnerPath,
    workspace: filesystem.workspace.parentRunnerPath,
    inbox: filesystem.inbox.parentRunnerPath,
    artifacts: filesystem.artifacts.parentRunnerPath,
  });
}

export function serializeExecutionEnvironment(environment: ExecutionEnvironmentRecord): JsonObject {
  return compactObject({
    environmentId: environment.id,
    environmentState: environment.state,
    runnerCwd: environment.runnerCwd,
    rootPath: environment.rootPath,
    expiresAt: environment.expiresAt,
    paths: readParentVisiblePaths(environment),
    setup: readExecutionEnvironmentSetupMetadata(environment.metadata) ?? undefined,
  });
}

function validateOwnedDisposableEnvironment(input: {
  environment: ExecutionEnvironmentRecord;
  scope: {agentKey: string; sessionId: string};
}): void {
  if (input.environment.kind !== "disposable_container") {
    throw new Error(`Execution environment ${input.environment.id} is not disposable.`);
  }
  if (input.environment.agentKey !== input.scope.agentKey) {
    throw commandScopeDenied(
      "The execution environment is not visible to the current agent.",
      "resource_scope_denied",
      "Use an execution environment owned by the current agent and session.",
    );
  }
  if (input.environment.createdBySessionId !== input.scope.sessionId) {
    throw commandScopeDenied(
      "The execution environment is not owned by this session.",
      "resource_scope_denied",
      "Use an execution environment owned by the current agent and session.",
    );
  }
}

async function resolveSetupScriptInput(
  rawPath: string | undefined,
  request: CommandRequest,
  fileResolver: CommandFileResolver,
): Promise<ExecutionEnvironmentSetupScriptInput | undefined> {
  if (rawPath === undefined) {
    return undefined;
  }

  const requestedPath = rawPath.trim();
  const resolved = await fileResolver.resolveReadablePath({
    request,
    file: {
      path: requestedPath,
    },
  });
  const file = await stat(resolved.path).catch(() => null);
  if (!file) {
    throw new Error(`No readable setup script found at ${resolved.displayPath}.`);
  }

  if (!file.isFile()) {
    throw new Error(`setupScript must point to a regular .sh file: ${resolved.displayPath}.`);
  }
  if (!requestedPath.endsWith(".sh") || !resolved.path.endsWith(".sh")) {
    throw new Error(`setupScript must point to a .sh file: ${resolved.displayPath}.`);
  }
  if ((file.mode & 0o444) === 0) {
    throw new Error(`Setup script is not readable: ${resolved.displayPath}.`);
  }
  try {
    await access(resolved.path, fsConstants.R_OK);
  } catch {
    throw new Error(`Setup script is not readable: ${resolved.displayPath}.`);
  }

  return {
    requestedPath,
    resolvedPath: resolved.path,
  };
}

export async function executeEnvironmentCreateCommand(
  input: EnvironmentCreateCommandInput,
  request: CommandRequest,
  services: EnvironmentCreateCommandServices,
  fileResolver: CommandFileResolver,
): Promise<JsonObject> {
  const setupScript = await resolveSetupScriptInput(input.setupScript, request, fileResolver);
  const environment = await services.lifecycle.createStandaloneDisposableEnvironment({
    agentKey: request.scope.agentKey,
    createdBySessionId: request.scope.sessionId,
    ttlMs: input.ttlHours === undefined
      ? DEFAULT_ENVIRONMENT_TTL_MS
      : Math.round(input.ttlHours * 60 * 60 * 1_000),
    metadata: compactObject({
      ...(input.label ? {label: input.label} : {}),
      createdByTool: "environment.create",
    }),
    ...(setupScript ? {setupScript} : {}),
  });

  return {
    status: "created",
    ...serializeExecutionEnvironment(environment),
  };
}

export async function executeEnvironmentListCommand(
  input: EnvironmentListCommandInput,
  request: CommandRequest,
  services: EnvironmentReadCommandServices,
): Promise<JsonObject> {
  const environments = (await services.environments.listDisposableEnvironmentsByOwner({
    agentKey: request.scope.agentKey,
    createdBySessionId: request.scope.sessionId,
  })).filter((environment) => input.state === undefined || environment.state === input.state);

  return compactObject({
    operation: "list",
    count: environments.length,
    environments: environments.map(serializeExecutionEnvironment),
  });
}

export async function executeEnvironmentShowCommand(
  input: EnvironmentShowCommandInput,
  request: CommandRequest,
  services: EnvironmentReadCommandServices,
): Promise<JsonObject> {
  const environment = await services.environments.getEnvironment(input.environmentId);
  validateOwnedDisposableEnvironment({environment, scope: request.scope});

  return compactObject({
    operation: "show",
    ...serializeExecutionEnvironment(environment),
  });
}

export async function executeEnvironmentStopCommand(
  input: EnvironmentStopCommandInput,
  request: CommandRequest,
  services: EnvironmentCommandServices,
): Promise<JsonObject> {
  const current = await services.environments.getEnvironment(input.environmentId);
  validateOwnedDisposableEnvironment({environment: current, scope: request.scope});
  const alreadyTerminal = current.state === "stopped" || current.state === "failed";
  const environment = alreadyTerminal || current.state === "stopping"
    ? current
    : await services.lifecycle.stopEnvironment(current.id);

  return {
    status: current.state === "failed"
      ? "failed"
      : alreadyTerminal
        ? "already_stopped"
        : environment.state,
    ...serializeExecutionEnvironment(environment),
  };
}

export async function executeEnvironmentLogsCommand(
  input: EnvironmentLogsCommandInput,
  request: CommandRequest,
  services: EnvironmentLogsCommandServices,
): Promise<JsonObject> {
  const current = await services.environments.getEnvironment(input.environmentId);
  validateOwnedDisposableEnvironment({environment: current, scope: request.scope});
  const role = input.role ?? "all";
  const tail = input.tail ?? DEFAULT_ENVIRONMENT_LOG_TAIL;
  const result = await services.lifecycle.readEnvironmentLogs({
    environmentId: current.id,
    role,
    tail,
  });

  return compactObject({
    operation: "logs",
    ...serializeExecutionEnvironment(current),
    role,
    tail,
    entries: result.entries.map((entry) => compactObject({
      role: entry.role,
      stdout: entry.stdout,
      stderr: entry.stderr,
    })),
  });
}

export const environmentCreateCommandDescriptor: CommandDescriptor = {
  name: ENVIRONMENT_CREATE_COMMAND_NAME,
  summary: "Create a disposable execution environment.",
  description: `Creates a session-owned disposable execution environment. Optional setupScript must be a readable .sh file. ${SETUP_SCRIPT_INSPECTION_NOTE}`,
  usage: "panda environment create [--label <text|@file|@->] [--ttl <hours|Nh>] [--setup-script <path>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "label",
      description: "Optional human label for this environment. Accepts literal text, @file, or @-.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "ttl",
      description: `Optional lifetime in hours or Nh. Max is ${MAX_ENVIRONMENT_TTL_HOURS} hours.`,
      valueType: "number",
      valueName: "hours|Nh",
    },
    {
      name: "setup-script",
      description: "Optional readable .sh file to copy and run during setup. Do not put secrets in setup scripts.",
      valueType: "string",
      valueName: "path",
    },
    {
      name: "json",
      description: "JSON object containing optional label, ttlHours, and setupScript.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Create a review environment for one day",
      command: "panda environment create --label review --ttl 24h",
    },
    {
      description: "Create an environment with a setup script",
      command: "panda environment create --setup-script ./setup.sh",
    },
    {
      description: "Use JSON input",
      command: "panda environment create --json '{\"label\":\"review\",\"setupScript\":\"setup.sh\"}'",
    },
  ],
  requiredCapabilities: ["environment.create"],
  resultShape: {
    status: "created",
    environmentId: "string",
    environmentState: "string",
    runnerCwd: "string",
  },
};

export const environmentListCommandDescriptor: CommandDescriptor = {
  name: ENVIRONMENT_LIST_COMMAND_NAME,
  summary: "List session-owned disposable execution environments.",
  description: "Lists disposable execution environments owned by the current session. Use --state to narrow the output before stopping or inspecting an environment.",
  usage: "panda environment list [--state <state>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "state",
      description: "Optional state filter: provisioning, ready, failed, stopping, or stopped.",
      valueType: "string",
      valueName: "state",
    },
    ENVIRONMENT_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "List current session environments",
      command: "panda environment list",
    },
    {
      description: "List only ready environments",
      command: "panda environment list --state ready",
    },
  ],
  requiredCapabilities: [ENVIRONMENT_LIST_COMMAND_NAME],
  resultShape: {
    operation: "list",
    count: "number",
    environments: [{
      environmentId: "string",
      environmentState: "string",
      runnerCwd: "string",
    }],
  },
};

export const environmentShowCommandDescriptor: CommandDescriptor = {
  name: ENVIRONMENT_SHOW_COMMAND_NAME,
  summary: "Show a session-owned disposable execution environment.",
  description: "Shows state, paths, expiry, and setup metadata for one disposable execution environment owned by the current session.",
  usage: "panda environment show <environment-id>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    ENVIRONMENT_ID_POSITIONAL_ARGUMENT,
    ENVIRONMENT_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Show environment details",
      command: "panda environment show environment:session:abc",
    },
    {
      description: "Use JSON input",
      command: "panda environment show --json '{\"environmentId\":\"environment:session:abc\"}'",
    },
  ],
  requiredCapabilities: [ENVIRONMENT_SHOW_COMMAND_NAME],
  resultShape: {
    operation: "show",
    environmentId: "string",
    environmentState: "string",
    runnerCwd: "string",
  },
};

export const environmentStopCommandDescriptor: CommandDescriptor = {
  name: ENVIRONMENT_STOP_COMMAND_NAME,
  summary: "Stop a disposable execution environment.",
  description: "Stops a session-owned disposable execution environment. Files and DB records are preserved.",
  usage: "panda environment stop <environment-id>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    ENVIRONMENT_ID_POSITIONAL_ARGUMENT,
    ENVIRONMENT_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Stop an environment",
      command: "panda environment stop environment:session:abc",
    },
    {
      description: "Use JSON input",
      command: "panda environment stop --json '{\"environmentId\":\"environment:session:abc\"}'",
    },
  ],
  requiredCapabilities: ["environment.stop"],
  resultShape: {
    status: "stopped|already_stopped|failed|stopping",
    environmentId: "string",
    environmentState: "string",
  },
};

export const environmentLogsCommandDescriptor: CommandDescriptor = {
  name: ENVIRONMENT_LOGS_COMMAND_NAME,
  summary: "Show recent disposable execution environment logs.",
  description: "Reads recent Docker logs for the session-owned disposable environment control and/or workspace containers. Output is tail-limited so agents can inspect runner health without dumping huge logs into context.",
  usage: "panda environment logs <environment-id> [--role control|workspace|all] [--tail <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    ENVIRONMENT_ID_POSITIONAL_ARGUMENT,
    {
      name: "role",
      description: "Container role to read. Defaults to all.",
      valueType: "string",
      valueName: "control|workspace|all",
      enumValues: ["control", "workspace", "all"],
      defaultValue: "all",
    },
    {
      name: "tail",
      description: `Number of recent log lines to read per container. Defaults to ${DEFAULT_ENVIRONMENT_LOG_TAIL}. Max is ${MAX_ENVIRONMENT_LOG_TAIL}.`,
      valueType: "number",
      valueName: "n",
      defaultValue: DEFAULT_ENVIRONMENT_LOG_TAIL,
    },
    ENVIRONMENT_JSON_ARGUMENT,
  ],
  examples: [
    {
      description: "Show recent logs for both containers",
      command: "panda environment logs environment:session:abc",
    },
    {
      description: "Show recent workspace logs",
      command: "panda environment logs environment:session:abc --role workspace --tail 50",
    },
    {
      description: "Use JSON input",
      command: "panda environment logs --json '{\"environmentId\":\"environment:session:abc\",\"role\":\"control\",\"tail\":100}'",
    },
  ],
  requiredCapabilities: [ENVIRONMENT_LOGS_COMMAND_NAME],
  resultShape: {
    operation: "logs",
    environmentId: "string",
    role: "control|workspace|all",
    tail: "number",
    entries: [{
      role: "control|workspace",
      stdout: "string",
      stderr: "string",
    }],
  },
};

export function createEnvironmentCreateCommand(
  services: EnvironmentCreateCommandServices,
  fileResolver: CommandFileResolver,
): RegisteredCommand {
  return {
    descriptor: environmentCreateCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeEnvironmentCreateCommand(
        parseEnvironmentCreateInput(request.input),
        request,
        services,
        fileResolver,
      );

      return {
        ok: true,
        command: ENVIRONMENT_CREATE_COMMAND_NAME,
        output,
        summary: `Created execution environment ${String(output.environmentId)}.`,
      };
    },
  };
}

export function createEnvironmentListCommand(services: EnvironmentReadCommandServices): RegisteredCommand {
  return {
    descriptor: environmentListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeEnvironmentListCommand(
        parseEnvironmentListInput(request.input),
        request,
        services,
      );

      return {
        ok: true,
        command: ENVIRONMENT_LIST_COMMAND_NAME,
        output,
        summary: `Listed ${String(output.count)} execution environment${output.count === 1 ? "" : "s"}.`,
      };
    },
  };
}

export function createEnvironmentShowCommand(services: EnvironmentReadCommandServices): RegisteredCommand {
  return {
    descriptor: environmentShowCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeEnvironmentShowCommand(
        parseEnvironmentShowInput(request.input),
        request,
        services,
      );

      return {
        ok: true,
        command: ENVIRONMENT_SHOW_COMMAND_NAME,
        output,
        summary: `Showed execution environment ${String(output.environmentId)}.`,
      };
    },
  };
}

export function createEnvironmentStopCommand(services: EnvironmentCommandServices): RegisteredCommand {
  return {
    descriptor: environmentStopCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeEnvironmentStopCommand(
        parseEnvironmentStopInput(request.input),
        request,
        services,
      );

      return {
        ok: true,
        command: ENVIRONMENT_STOP_COMMAND_NAME,
        output,
        summary: `Stopped execution environment ${String(output.environmentId)}.`,
      };
    },
  };
}

export function createEnvironmentLogsCommand(services: EnvironmentLogsCommandServices): RegisteredCommand {
  return {
    descriptor: environmentLogsCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeEnvironmentLogsCommand(
        parseEnvironmentLogsInput(request.input),
        request,
        services,
      );

      return {
        ok: true,
        command: ENVIRONMENT_LOGS_COMMAND_NAME,
        output,
        summary: `Read execution environment logs for ${String(output.environmentId)}.`,
      };
    },
  };
}
