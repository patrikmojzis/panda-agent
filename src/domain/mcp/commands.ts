import {
  isJsonObject,
  normalizeToJsonValue,
  type JsonObject,
} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {CredentialResolver} from "../credentials/resolver.js";
import {CommandDenialError, commandScopeDenied} from "../commands/errors.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import type {ExecutionCredentialPolicy} from "../execution-environments/types.js";
import {mcpOAuthGrantRef} from "./oauth-types.js";
import {referencedMcpCredentialEnvKeys} from "./config.js";
import type {McpConfigReader} from "./store.js";
import {
  MCP_MAX_TIMEOUT_MS,
  MCP_MIN_TIMEOUT_MS,
  MCP_OUTPUT_MAX_BYTES,
  type McpCallOutput,
  type McpCompatibilityWarning,
  type McpOperationDiagnostics,
  type McpResolvedInvocation,
  type McpRunner,
  type McpRunnerResult,
  type McpToolsOutput,
  type McpValueSource,
} from "./types.js";

export const MCP_TOOLS_COMMAND_NAME = "mcp.tools";
export const MCP_CALL_COMMAND_NAME = "mcp.call";
export const MCP_COMMAND_CAPABILITY = "mcp.*";

type McpCredentialResolver = Pick<CredentialResolver, "resolveCredential">;

interface McpCommandOptions {
  configs: McpConfigReader;
  runner: McpRunner;
  credentials: McpCredentialResolver;
}

interface McpToolsCommandInput {
  server: string;
  timeoutMs?: number;
}

interface McpCallCommandInput {
  server: string;
  tool: string;
  input: JsonObject;
  timeoutMs?: number;
}

class McpCommandError extends Error {
  readonly pandaCommandErrorDetails: JsonObject;

  constructor(message: string, details: JsonObject) {
    super(message);
    this.name = "McpCommandError";
    this.pandaCommandErrorDetails = details;
  }
}

function commandError(message: string, exitCode: number, kind: string, extra: JsonObject = {}): McpCommandError {
  return new McpCommandError(message, {exitCode, kind, ...extra});
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw commandError(`${label} must be a non-empty string.`, 2, "config_input");
  }
  return value.trim();
}

function readOptionalTimeoutMs(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw commandError(`${label} must be an integer number of milliseconds.`, 2, "config_input");
  }
  if (value < MCP_MIN_TIMEOUT_MS || value > MCP_MAX_TIMEOUT_MS) {
    throw commandError(`${label} must be between ${MCP_MIN_TIMEOUT_MS} and ${MCP_MAX_TIMEOUT_MS}.`, 2, "config_input");
  }
  return value;
}

function parseToolsInput(input: unknown): McpToolsCommandInput {
  if (!isRecord(input)) throw commandError("mcp.tools input must be a JSON object.", 2, "config_input");
  const timeoutMs = readOptionalTimeoutMs(input.timeoutMs, "mcp.tools timeoutMs");
  return {
    server: readRequiredString(input.server, "mcp.tools server"),
    ...(timeoutMs === undefined ? {} : {timeoutMs}),
  };
}

function parseCallInput(input: unknown): McpCallCommandInput {
  if (!isRecord(input)) throw commandError("mcp.call input must be a JSON object.", 2, "config_input");
  const rawArguments = input.input ?? input.arguments ?? {};
  if (!isJsonObject(rawArguments)) {
    throw commandError("mcp.call input must be a JSON object.", 2, "config_input");
  }
  const timeoutMs = readOptionalTimeoutMs(input.timeoutMs, "mcp.call timeoutMs");
  return {
    server: readRequiredString(input.server, "mcp.call server"),
    tool: readRequiredString(input.tool, "mcp.call tool"),
    input: rawArguments,
    ...(timeoutMs === undefined ? {} : {timeoutMs}),
  };
}

function toJsonObject(value: unknown, label: string): JsonObject {
  const normalized = normalizeToJsonValue(value);
  if (!isJsonObject(normalized)) throw commandError(`${label} must be a JSON object.`, 3, "invalid_content");
  return normalized;
}

function toJsonObjectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw commandError(`${label} must be an array.`, 3, "invalid_content");
  return value.map((entry, index) => toJsonObject(entry, `${label}[${index}]`));
}

function diagnosticsJson(diagnostics: McpOperationDiagnostics): JsonObject {
  return {...toJsonObject(diagnostics, "MCP diagnostics"), configSource: "database"};
}

function schemaDialect(schema: JsonObject | undefined): string | undefined {
  return typeof schema?.$schema === "string" ? schema.$schema : undefined;
}

function compatibilityWarningsForTools(tools: readonly JsonObject[]): McpCompatibilityWarning[] {
  return tools.flatMap((tool) => {
    const outputSchema = isJsonObject(tool.outputSchema) ? tool.outputSchema : undefined;
    const dialect = schemaDialect(outputSchema);
    if (!dialect || /2020-12/.test(dialect)) return [];
    return [{
      code: "mcp_output_schema_dialect_not_validated",
      ...(typeof tool.name === "string" ? {tool: tool.name} : {}),
      message: `Tool outputSchema declares ${dialect}; Panda preserves the schema and skips client-side output validation so direct calls are not blocked by schema dialect differences.`,
    }];
  });
}

function addRunMetadata<T extends JsonObject>(output: T, run: McpRunnerResult<unknown>): T {
  return {
    ...output,
    ...(run.serverInfo ? {serverInfo: run.serverInfo} : {}),
    ...(run.serverCapabilities ? {serverCapabilities: run.serverCapabilities} : {}),
  } as T;
}

function assertOutputSize(value: JsonObject): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MCP_OUTPUT_MAX_BYTES) {
    throw commandError("MCP normalized command output exceeded the configured limit.", 3, "output_limit");
  }
}

function runnerErrorDetails(error: unknown): {
  exitCode: 3 | 124;
  phase: string;
  diagnostics: McpOperationDiagnostics;
  httpStatus?: number;
} | null {
  if (!isRecord(error)) return null;
  if ((error.exitCode !== 3 && error.exitCode !== 124) || typeof error.phase !== "string" || !isRecord(error.diagnostics)) {
    return null;
  }
  return {
    exitCode: error.exitCode,
    phase: error.phase,
    diagnostics: error.diagnostics as unknown as McpOperationDiagnostics,
    ...(typeof error.httpStatus === "number" ? {httpStatus: error.httpStatus} : {}),
  };
}

function normalizeMcpError(error: unknown): McpCommandError {
  if (error instanceof McpCommandError) return error;
  const runner = runnerErrorDetails(error);
  if (runner) {
    return commandError(
      runner.exitCode === 124 ? "MCP command timed out." : "MCP transport/protocol command failed.",
      runner.exitCode,
      runner.phase,
      {
        diagnostics: toJsonObject(runner.diagnostics, "MCP diagnostics"),
        ...(runner.httpStatus === undefined ? {} : {httpStatus: runner.httpStatus}),
      },
    );
  }
  return commandError("MCP command failed before external execution.", 2, "config_input");
}

function assertCredentialPolicy(
  policy: ExecutionCredentialPolicy | undefined,
  keys: readonly string[],
  credentialRefs: readonly string[] = [],
): void {
  if (keys.length === 0 && credentialRefs.length === 0) return;
  if (policy?.mode === "all_agent") return;
  const allowed = policy?.mode === "allowlist" ? new Set(policy.envKeys) : new Set<string>();
  const denied = keys.find((key) => !allowed.has(key));
  if (denied) {
    throw commandScopeDenied(
      "An MCP credential required by this server is not allowed in the current execution scope.",
      "command_scope_denied",
      "Use an MCP server whose credential requirements are allowed by the current execution scope.",
    );
  }
  const allowedRefs = policy?.mode === "allowlist" ? new Set(policy.credentialRefs ?? []) : new Set<string>();
  const deniedRef = credentialRefs.find((ref) => !allowedRefs.has(ref));
  if (deniedRef) {
    throw commandScopeDenied(
      "An MCP OAuth grant required by this server is not allowed in the current execution scope.",
      "command_scope_denied",
      "Use an MCP server whose OAuth grant is allowed by the current execution scope.",
    );
  }
}

async function resolveCredentialValues(
  credentials: McpCredentialResolver,
  agentKey: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  for (const key of keys) {
    let resolved;
    try {
      resolved = await credentials.resolveCredential(key, {agentKey});
    } catch {
      throw commandError(`MCP credential ${key} could not be decrypted.`, 3, "authentication");
    }
    if (!resolved) throw commandError(`MCP credential ${key} is not configured.`, 3, "authentication");
    values.set(key, resolved.value);
  }
  return values;
}

function resolveValue(source: McpValueSource, credentials: ReadonlyMap<string, string>): string {
  if ("value" in source) return source.value;
  const value = credentials.get(source.credentialEnvKey);
  if (value === undefined) throw commandError("MCP credential resolution failed closed.", 3, "authentication");
  return value;
}

async function resolveInvocation(
  options: McpCommandOptions,
  request: CommandRequest,
  serverName: string,
  timeoutMs?: number,
): Promise<McpResolvedInvocation> {
  let record;
  try {
    record = await options.configs.getAgentConfig(request.scope.agentKey);
  } catch {
    throw commandError("Stored MCP config is invalid.", 2, "config_input");
  }
  const config = record.config.servers[serverName];
  if (!config) throw commandError(`MCP server ${serverName} is not configured.`, 2, "config_input");
  if (!config.enabled) throw commandError(`MCP server ${serverName} is disabled.`, 2, "config_input");
  const keys = referencedMcpCredentialEnvKeys(config);
  const oauthRefs = config.transport === "streamable-http" && config.auth?.type === "oauth"
    ? [mcpOAuthGrantRef(serverName)]
    : [];
  assertCredentialPolicy(request.scope.credentialPolicy, keys, oauthRefs);
  const credentials = await resolveCredentialValues(options.credentials, request.scope.agentKey, keys);
  const resolvedTimeout = timeoutMs ?? config.timeoutMs;
  if (config.transport === "stdio") {
    return {
      config: {
        transport: "stdio",
        enabled: config.enabled,
        command: config.command,
        args: config.args,
        ...(config.cwd ? {cwd: config.cwd} : {}),
        ...(config.env ? {env: Object.fromEntries(
          Object.entries(config.env).map(([key, source]) => [key, resolveValue(source, credentials)]),
        )} : {}),
        timeoutMs: resolvedTimeout,
      },
      knownSecrets: [...credentials.values()],
    };
  }
  const headers = Object.fromEntries((config.headers ?? []).map((header) => [
    header.name,
    header.credentialEnvKey ? credentials.get(header.credentialEnvKey)! : header.value!,
  ]));
  if (config.auth?.type === "bearer") headers.Authorization = `Bearer ${credentials.get(config.auth.credentialEnvKey)!}`;
  return {
    config: {
      transport: config.transport,
      enabled: config.enabled,
      url: config.url,
      timeoutMs: resolvedTimeout,
      ...(Object.keys(headers).length > 0 ? {headers} : {}),
      ...(config.auth?.type === "oauth" ? {oauth: {
        agentKey: request.scope.agentKey,
        serverName,
        auth: config.auth,
      }} : {}),
    },
    knownSecrets: [...credentials.values()],
  };
}

export const mcpToolsCommandDescriptor: CommandDescriptor = {
  name: MCP_TOOLS_COMMAND_NAME,
  summary: "List tools from a configured MCP server.",
  description: "Connects to an agent-scoped stdio, Streamable HTTP, or legacy SSE MCP server and returns its complete paginated tool list without filtering destructive/write tools.",
  usage: "panda mcp tools <server> [--timeout-ms <ms>]",
  inputModes: ["flags", "json"],
  outputModes: ["json"],
  arguments: [
    {name: "server", description: "Configured MCP server key from the agent registry.", required: true, kind: "positional", valueType: "string", valueName: "server"},
    {name: "timeout-ms", description: "Optional command deadline override in milliseconds (1000-120000).", valueType: "number", valueName: "ms"},
    {name: "json", description: "JSON object containing server and optional timeoutMs.", valueType: "json"},
  ],
  examples: [
    {description: "List tools exposed by a server", command: "panda mcp tools filesystem"},
    {description: "Use JSON input", command: "panda mcp tools --json '{\"server\":\"filesystem\"}'"},
  ],
  requiredCapabilities: [MCP_COMMAND_CAPABILITY],
  resultShape: {server: "string", tools: "array", toolCount: "number", diagnostics: "object", compatibilityWarnings: "array"},
};

export const mcpCallCommandDescriptor: CommandDescriptor = {
  name: MCP_CALL_COMMAND_NAME,
  summary: "Call a tool on a configured MCP server.",
  description: "Calls one tool on an agent-scoped MCP server and preserves the full result envelope, including non-text content, structuredContent, _meta, and isError.",
  usage: "panda mcp call <server> <tool> --input <json|@file|@-> [--timeout-ms <ms>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json"],
  arguments: [
    {name: "server", description: "Configured MCP server key from the agent registry.", required: true, kind: "positional", valueType: "string", valueName: "server"},
    {name: "tool", description: "Exact MCP tool name.", required: true, kind: "positional", valueType: "string", valueName: "tool"},
    {name: "input", description: "JSON object passed as MCP tool arguments.", required: true, valueType: "json", valueName: "json", valueSources: ["literal", "file", "stdin"]},
    {name: "timeout-ms", description: "Optional command deadline override in milliseconds (1000-120000).", valueType: "number", valueName: "ms"},
    {name: "json", description: "JSON object containing server, tool, input, and optional timeoutMs.", valueType: "json"},
  ],
  examples: [
    {description: "Call a tool with inline JSON input", command: "panda mcp call filesystem read_file --input '{\"path\":\"README.md\"}'"},
    {description: "Read tool input from a file", command: "panda mcp call filesystem write_file --input @payload.json"},
  ],
  requiredCapabilities: [MCP_COMMAND_CAPABILITY],
  resultShape: {server: "string", tool: "string", content: "array", structuredContent: "object|undefined", _meta: "object|undefined", isError: "boolean|undefined", diagnostics: "object", compatibilityWarnings: "array", exitCode: "number", phase: "tool_error|undefined"},
};

export function createMcpToolsCommand(options: McpCommandOptions): RegisteredCommand {
  return {
    descriptor: mcpToolsCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<McpToolsOutput>> {
      try {
        const input = parseToolsInput(request.input);
        const run = await options.runner.listTools(await resolveInvocation(options, request, input.server, input.timeoutMs));
        const result = toJsonObject(run.value, "MCP tools result");
        const tools = toJsonObjectArray(result.tools, "MCP tools result.tools");
        const output = addRunMetadata<McpToolsOutput>({
          ...result,
          server: input.server,
          tools,
          toolCount: tools.length,
          diagnostics: diagnosticsJson(run.diagnostics),
          compatibilityWarnings: compatibilityWarningsForTools(tools),
        }, run);
        assertOutputSize(output);
        return {ok: true, command: MCP_TOOLS_COMMAND_NAME, output, summary: `Listed ${tools.length} MCP tool${tools.length === 1 ? "" : "s"} from ${input.server}.`};
      } catch (error) {
        if (error instanceof CommandDenialError) throw error;
        throw normalizeMcpError(error);
      }
    },
  };
}

export function createMcpCallCommand(options: McpCommandOptions): RegisteredCommand {
  return {
    descriptor: mcpCallCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<McpCallOutput>> {
      try {
        const input = parseCallInput(request.input);
        const run = await options.runner.callTool(
          await resolveInvocation(options, request, input.server, input.timeoutMs),
          {name: input.tool, arguments: input.input},
        );
        const result = toJsonObject(run.value, "MCP call result");
        const isError = result.isError === true;
        const output = addRunMetadata<McpCallOutput>({
          ...result,
          server: input.server,
          tool: input.tool,
          diagnostics: diagnosticsJson(run.diagnostics),
          compatibilityWarnings: [],
          exitCode: isError ? 4 : 0,
          ...(isError ? {phase: "tool_error"} : {}),
        }, run);
        assertOutputSize(output);
        return {
          ok: true,
          command: MCP_CALL_COMMAND_NAME,
          output,
          summary: isError ? `MCP tool ${input.server}/${input.tool} returned isError.` : `Called MCP tool ${input.server}/${input.tool}.`,
        };
      } catch (error) {
        if (error instanceof CommandDenialError) throw error;
        throw normalizeMcpError(error);
      }
    },
  };
}
