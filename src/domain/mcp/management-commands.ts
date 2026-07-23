import {isJsonObject, normalizeToJsonValue, type JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {COMMAND_CONFLICT_EXIT_CODE, CommandDenialError, CommandStructuredError} from "../commands/errors.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import type {McpManagementActor, McpManagementService} from "./management-service.js";
import {McpInvocationError} from "./invocation.js";
import {McpRegistryVersionConflictError} from "./store.js";
import {MCP_MAX_TIMEOUT_MS, MCP_MIN_TIMEOUT_MS} from "./types.js";

export const MCP_MANAGEMENT_CAPABILITY = "mcp.manage.*";

export const MCP_SERVER_LIST_COMMAND_NAME = "mcp.server.list";
export const MCP_SERVER_SHOW_COMMAND_NAME = "mcp.server.show";
export const MCP_SERVER_ADD_COMMAND_NAME = "mcp.server.add";
export const MCP_SERVER_UPDATE_COMMAND_NAME = "mcp.server.update";
export const MCP_SERVER_ENABLE_COMMAND_NAME = "mcp.server.enable";
export const MCP_SERVER_DISABLE_COMMAND_NAME = "mcp.server.disable";
export const MCP_SERVER_DELETE_COMMAND_NAME = "mcp.server.delete";
export const MCP_SERVER_TEST_COMMAND_NAME = "mcp.server.test";
export const MCP_OAUTH_DISCOVER_COMMAND_NAME = "mcp.oauth.discover";
export const MCP_OAUTH_START_COMMAND_NAME = "mcp.oauth.start";
export const MCP_OAUTH_STATUS_COMMAND_NAME = "mcp.oauth.status";
export const MCP_OAUTH_DISCONNECT_COMMAND_NAME = "mcp.oauth.disconnect";

function descriptor(
  name: `${string}.${string}`,
  summary: string,
  usage: string,
  args: CommandDescriptor["arguments"],
  resultShape: JsonObject,
): CommandDescriptor {
  return {
    name,
    summary,
    description: `${summary} The authenticated command scope always selects the current agent.`,
    usage,
    inputModes: ["flags", "json", "stdin", "file"],
    outputModes: ["json"],
    arguments: args,
    examples: [],
    requiredCapabilities: [MCP_MANAGEMENT_CAPABILITY],
    resultShape,
  };
}

const serverArg = {
  name: "server",
  description: "Persisted MCP server name.",
  required: true,
  kind: "positional",
  valueType: "string",
  valueName: "server",
} as const;
const expectedVersionArg = {
  name: "expected-version",
  description: "Expected registry version for optimistic concurrency.",
  required: true,
  valueType: "number",
  valueName: "n",
  minimum: 0,
} as const;
const configArg = {
  name: "config",
  description: "MCP server config.",
  required: true,
  valueType: "json",
  valueName: "json",
  valueSources: ["literal", "file", "stdin"],
} as const;

export const mcpServerListCommandDescriptor = descriptor(MCP_SERVER_LIST_COMMAND_NAME, "List this agent's MCP registry.", "panda mcp server list", [], {servers: "array", count: "number", version: "number"});
export const mcpServerShowCommandDescriptor = descriptor(MCP_SERVER_SHOW_COMMAND_NAME, "Show one MCP registration.", "panda mcp server show <server>", [serverArg], {server: "object", version: "number"});
export const mcpServerAddCommandDescriptor = descriptor(MCP_SERVER_ADD_COMMAND_NAME, "Add an MCP registration.", "panda mcp server add <server> --config <json|@file|@-> --expected-version <n>", [serverArg, configArg, expectedVersionArg], {server: "object", version: "number"});
export const mcpServerUpdateCommandDescriptor = descriptor(MCP_SERVER_UPDATE_COMMAND_NAME, "Update an MCP registration.", "panda mcp server update <server> --config <json|@file|@-> --expected-version <n>", mcpServerAddCommandDescriptor.arguments, {server: "object", version: "number"});
export const mcpServerEnableCommandDescriptor = descriptor(MCP_SERVER_ENABLE_COMMAND_NAME, "Enable an MCP registration.", "panda mcp server enable <server> --expected-version <n>", [serverArg, expectedVersionArg], {server: "object", version: "number"});
export const mcpServerDisableCommandDescriptor = descriptor(MCP_SERVER_DISABLE_COMMAND_NAME, "Disable an MCP registration.", "panda mcp server disable <server> --expected-version <n>", [serverArg, expectedVersionArg], {server: "object", version: "number"});
export const mcpServerDeleteCommandDescriptor = descriptor(MCP_SERVER_DELETE_COMMAND_NAME, "Delete an MCP registration.", "panda mcp server delete <server> --expected-version <n>", [serverArg, expectedVersionArg], {deleted: "boolean", version: "number"});
export const mcpServerTestCommandDescriptor = descriptor(MCP_SERVER_TEST_COMMAND_NAME, "Initialize a persisted MCP server and list its tools without calling any tool.", "panda mcp server test <server> [--timeout-ms <ms>]", [serverArg, {name: "timeout-ms", description: "Optional test deadline.", valueType: "number", valueName: "ms", minimum: MCP_MIN_TIMEOUT_MS, maximum: MCP_MAX_TIMEOUT_MS}], {server: "string", tools: "array", toolCount: "number", diagnostics: "object"});
export const mcpOauthDiscoverCommandDescriptor = descriptor(MCP_OAUTH_DISCOVER_COMMAND_NAME, "Discover OAuth metadata for an MCP registration.", "panda mcp oauth discover <server>", [serverArg], {discovery: "object"});
export const mcpOauthStartCommandDescriptor = descriptor(MCP_OAUTH_START_COMMAND_NAME, "Start OAuth Authorization Code with PKCE and return the user authorization link.", "panda mcp oauth start <server> [--manual-client <json|@file|@->]", [serverArg, {name: "manual-client", description: "Optional manual client using a credential reference for its secret.", valueType: "json", valueName: "json", valueSources: ["literal", "file", "stdin"]}], {authorizationUrl: "string", expiresAt: "string"});
export const mcpOauthStatusCommandDescriptor = descriptor(MCP_OAUTH_STATUS_COMMAND_NAME, "Poll OAuth status for an MCP registration.", "panda mcp oauth status <server>", [serverArg], {status: "string"});
export const mcpOauthDisconnectCommandDescriptor = descriptor(MCP_OAUTH_DISCONNECT_COMMAND_NAME, "Revoke and disconnect an MCP OAuth grant.", "panda mcp oauth disconnect <server>", [serverArg], {disconnected: "boolean"});

function objectInput(input: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`${label} input must be a JSON object.`);
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} input contains unsupported field ${unknown}.`);
  return input;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function expectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("expectedVersion must be a non-negative integer.");
  return value;
}

function optionalTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MCP_MIN_TIMEOUT_MS || value > MCP_MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be between ${MCP_MIN_TIMEOUT_MS} and ${MCP_MAX_TIMEOUT_MS}.`);
  }
  return value;
}

function actor(request: CommandRequest): McpManagementActor {
  return {
    kind: "agent",
    agentKey: request.scope.agentKey,
    sessionId: request.scope.sessionId,
    ...(request.scope.identityId ? {identityId: request.scope.identityId} : {}),
    ...(request.scope.threadId ? {threadId: request.scope.threadId} : {}),
  };
}

function jsonOutput(value: unknown): JsonObject {
  const normalized = normalizeToJsonValue(value);
  if (!isJsonObject(normalized)) throw new Error("MCP management result is not a JSON object.");
  return normalized;
}

function normalizeError(error: unknown): never {
  if (error instanceof CommandDenialError) {
    throw new CommandStructuredError(error.pandaCommandErrorCode, error.message, {
      ...error.pandaCommandErrorDetails,
      failureCode: "credential_policy_denied",
    });
  }
  if (error instanceof CommandStructuredError) throw error;
  if (error instanceof McpInvocationError) {
    const exitCode = Number(error.pandaCommandErrorDetails.exitCode);
    throw new CommandStructuredError(exitCode === 2 ? "invalid_input" : "command_failed", error.message, {
      failureCode: String(error.pandaCommandErrorDetails.kind),
      exitCode,
      retryable: false,
    });
  }
  if (error instanceof McpRegistryVersionConflictError) {
    throw new CommandStructuredError("conflict", error.message, {
      failureCode: "stale_version",
      currentVersion: error.currentVersion,
      requiresRefresh: true,
      retryable: false,
      exitCode: COMMAND_CONFLICT_EXIT_CODE,
      nextAction: {kind: "refresh", command: "panda mcp server list"},
    });
  }
  if (isRecord(error) && (error.exitCode === 3 || error.exitCode === 124) && typeof error.phase === "string") {
    throw new CommandStructuredError("command_failed", error.exitCode === 124 ? "MCP server test timed out." : "MCP server test failed.", {
      failureCode: error.phase,
      exitCode: error.exitCode,
      ...(isRecord(error.diagnostics) ? {diagnostics: jsonOutput(error.diagnostics)} : {}),
      ...(typeof error.httpStatus === "number" ? {httpStatus: error.httpStatus} : {}),
    });
  }
  const message = error instanceof Error ? error.message : "MCP management command failed.";
  const authorizationRequired = /authorization|required grant/i.test(message);
  throw new CommandStructuredError(authorizationRequired ? "command_failed" : "invalid_input", message, {
    failureCode: authorizationRequired ? "authorization_required" : "config_input",
    retryable: false,
    exitCode: 2,
  });
}

function command(
  commandDescriptor: CommandDescriptor,
  execute: (request: CommandRequest, input: Record<string, unknown>) => Promise<unknown>,
  allowed: readonly string[],
): RegisteredCommand {
  return {
    descriptor: commandDescriptor,
    async execute(request): Promise<CommandSuccess<JsonObject>> {
      try {
        const input = objectInput(request.input, allowed, commandDescriptor.name);
        const output = jsonOutput(await execute(request, input));
        return {ok: true, command: commandDescriptor.name, output, summary: commandDescriptor.summary};
      } catch (error) {
        normalizeError(error);
      }
    },
  };
}

export function createMcpServerListCommand(service: McpManagementService): RegisteredCommand {
  return command(mcpServerListCommandDescriptor, (request) => service.list(actor(request), request.scope.credentialPolicy), []);
}

export function createMcpServerShowCommand(service: McpManagementService): RegisteredCommand {
  return command(mcpServerShowCommandDescriptor, (request, input) => service.show(actor(request), requiredString(input.server, "server"), request.scope.credentialPolicy), ["server"]);
}

function createPutCommand(service: McpManagementService, value: {descriptor: CommandDescriptor; mode: "create" | "update"}): RegisteredCommand {
  return command(value.descriptor, (request, input) => service.put(actor(request), requiredString(input.server, "server"), input.config, {
    mode: value.mode,
    expectedVersion: expectedVersion(input.expectedVersion),
    credentialPolicy: request.scope.credentialPolicy,
  }), ["server", "config", "expectedVersion"]);
}

export function createMcpServerAddCommand(service: McpManagementService): RegisteredCommand {
  return createPutCommand(service, {descriptor: mcpServerAddCommandDescriptor, mode: "create"});
}

export function createMcpServerUpdateCommand(service: McpManagementService): RegisteredCommand {
  return createPutCommand(service, {descriptor: mcpServerUpdateCommandDescriptor, mode: "update"});
}

function createEnabledCommand(service: McpManagementService, value: {descriptor: CommandDescriptor; enabled: boolean}): RegisteredCommand {
  return command(value.descriptor, (request, input) => service.setEnabled(actor(request), requiredString(input.server, "server"), value.enabled, expectedVersion(input.expectedVersion), request.scope.credentialPolicy), ["server", "expectedVersion"]);
}

export function createMcpServerEnableCommand(service: McpManagementService): RegisteredCommand {
  return createEnabledCommand(service, {descriptor: mcpServerEnableCommandDescriptor, enabled: true});
}

export function createMcpServerDisableCommand(service: McpManagementService): RegisteredCommand {
  return createEnabledCommand(service, {descriptor: mcpServerDisableCommandDescriptor, enabled: false});
}

export function createMcpServerDeleteCommand(service: McpManagementService): RegisteredCommand {
  return command(mcpServerDeleteCommandDescriptor, (request, input) => service.delete(actor(request), requiredString(input.server, "server"), expectedVersion(input.expectedVersion)), ["server", "expectedVersion"]);
}

export function createMcpServerTestCommand(service: McpManagementService): RegisteredCommand {
  return command(mcpServerTestCommandDescriptor, (request, input) => {
    const timeoutMs = optionalTimeout(input.timeoutMs);
    return service.test(actor(request), requiredString(input.server, "server"), {
      credentialPolicy: request.scope.credentialPolicy,
      ...(timeoutMs === undefined ? {} : {timeoutMs}),
    });
  }, ["server", "timeoutMs"]);
}

export function createMcpOauthDiscoverCommand(service: McpManagementService): RegisteredCommand {
  return command(mcpOauthDiscoverCommandDescriptor, (request, input) => service.discoverOAuth(actor(request), requiredString(input.server, "server"), request.scope.credentialPolicy), ["server"]);
}

export function createMcpOauthStartCommand(service: McpManagementService): RegisteredCommand {
  return command(mcpOauthStartCommandDescriptor, (request, input) => service.startOAuth(actor(request), requiredString(input.server, "server"), {credentialPolicy: request.scope.credentialPolicy, ...(input.manualClient === undefined ? {} : {manualClient: input.manualClient})}), ["server", "manualClient"]);
}

export function createMcpOauthStatusCommand(service: McpManagementService): RegisteredCommand {
  return command(mcpOauthStatusCommandDescriptor, (request, input) => service.oauthStatus(actor(request), requiredString(input.server, "server"), request.scope.credentialPolicy), ["server"]);
}

export function createMcpOauthDisconnectCommand(service: McpManagementService): RegisteredCommand {
  return command(mcpOauthDisconnectCommandDescriptor, (request, input) => service.disconnectOAuth(actor(request), requiredString(input.server, "server"), request.scope.credentialPolicy), ["server"]);
}
