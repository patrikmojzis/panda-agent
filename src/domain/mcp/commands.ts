import {CompatibilityCallToolResultSchema} from "@modelcontextprotocol/sdk/types.js";

import {
  isJsonObject,
  normalizeToJsonValue,
  type JsonObject,
} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import {readAgentMcpServerConfig} from "./config.js";
import {McpClientRunError, runWithMcpClient, type McpClientRunResult} from "./client.js";
import {
  MCP_MAX_TIMEOUT_MS,
  MCP_MIN_TIMEOUT_MS,
  type McpCallOutput,
  type McpCompatibilityWarning,
  type McpOperationDiagnostics,
  type McpServerConfig,
  type McpToolsOutput,
} from "./types.js";

export const MCP_TOOLS_COMMAND_NAME = "mcp.tools";
export const MCP_CALL_COMMAND_NAME = "mcp.call";
export const MCP_COMMAND_CAPABILITY = "mcp.*";

interface McpCommandOptions {
  env?: NodeJS.ProcessEnv;
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
  return new McpCommandError(message, {
    exitCode,
    kind,
    ...extra,
  });
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw commandError(`${label} must be a non-empty string.`, 2, "config_input");
  }

  return value.trim();
}

function readOptionalTimeoutMs(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw commandError(`${label} must be an integer number of milliseconds.`, 2, "config_input");
  }
  if (value < MCP_MIN_TIMEOUT_MS || value > MCP_MAX_TIMEOUT_MS) {
    throw commandError(`${label} must be between ${MCP_MIN_TIMEOUT_MS} and ${MCP_MAX_TIMEOUT_MS}.`, 2, "config_input");
  }

  return value;
}

function parseToolsInput(input: unknown): McpToolsCommandInput {
  if (!isRecord(input)) {
    throw commandError("mcp.tools input must be a JSON object.", 2, "config_input");
  }

  const timeoutMs = readOptionalTimeoutMs(input.timeoutMs, "mcp.tools timeoutMs");
  return {
    server: readRequiredString(input.server, "mcp.tools server"),
    ...(timeoutMs === undefined ? {} : {timeoutMs}),
  };
}

function parseCallInput(input: unknown): McpCallCommandInput {
  if (!isRecord(input)) {
    throw commandError("mcp.call input must be a JSON object.", 2, "config_input");
  }
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

function withInputTimeout(config: McpServerConfig, timeoutMs: number | undefined): McpServerConfig {
  return timeoutMs === undefined ? config : {...config, timeoutMs};
}

function toJsonObject(value: unknown, label: string): JsonObject {
  const normalized = normalizeToJsonValue(value);
  if (!isJsonObject(normalized)) {
    throw commandError(`${label} must be a JSON object.`, 3, "protocol");
  }

  return normalized;
}

function toJsonObjectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw commandError(`${label} must be an array.`, 3, "protocol");
  }

  return value.map((entry, index) => toJsonObject(entry, `${label}[${index}]`));
}

function diagnosticsJson(
  diagnostics: McpOperationDiagnostics,
  configSource: string,
): JsonObject {
  return {
    ...toJsonObject(diagnostics, "MCP diagnostics"),
    configSource,
  };
}

function schemaDialect(schema: JsonObject | undefined): string | undefined {
  const dialect = schema?.$schema;
  return typeof dialect === "string" ? dialect : undefined;
}

function compatibilityWarningsForTools(tools: readonly JsonObject[]): McpCompatibilityWarning[] {
  return tools.flatMap((tool) => {
    const outputSchema = isJsonObject(tool.outputSchema) ? tool.outputSchema : undefined;
    const dialect = schemaDialect(outputSchema);
    if (!dialect || /2020-12/.test(dialect)) {
      return [];
    }

    return [{
      code: "mcp_output_schema_dialect_not_validated",
      ...(typeof tool.name === "string" ? {tool: tool.name} : {}),
      message: `Tool outputSchema declares ${dialect}; Panda preserves the schema and skips client-side output validation so direct calls are not blocked by schema dialect differences.`,
    }];
  });
}

function addRunMetadata<T extends JsonObject>(
  output: T,
  run: McpClientRunResult<unknown>,
): T {
  return {
    ...output,
    ...(run.serverInfo ? {serverInfo: run.serverInfo} : {}),
    ...(run.serverCapabilities ? {serverCapabilities: run.serverCapabilities} : {}),
  } as T;
}

function normalizeMcpError(error: unknown): McpCommandError {
  if (error instanceof McpCommandError) {
    return error;
  }
  if (error instanceof McpClientRunError) {
    return commandError(error.message, error.exitCode, error.phase, {
      diagnostics: toJsonObject(error.diagnostics, "MCP diagnostics"),
    });
  }

  return commandError(error instanceof Error ? error.message : String(error), 2, "config_input");
}

async function resolveConfiguredServer(
  agentKey: string,
  server: string,
  env: NodeJS.ProcessEnv,
): Promise<{config: McpServerConfig; source: string}> {
  try {
    return await readAgentMcpServerConfig(agentKey, server, env);
  } catch (error) {
    throw commandError(error instanceof Error ? error.message : String(error), 2, "config_input");
  }
}

export const mcpToolsCommandDescriptor: CommandDescriptor = {
  name: MCP_TOOLS_COMMAND_NAME,
  summary: "List tools from a configured MCP server.",
  description: "Connects to one agent-scoped stdio MCP server and returns its full tool list without filtering destructive/write tools.",
  usage: "panda mcp tools <server> [--timeout-ms <ms>]",
  inputModes: ["flags", "json"],
  outputModes: ["json"],
  arguments: [
    {
      name: "server",
      description: "Configured MCP server key from the agent mcp.json config.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "server",
    },
    {
      name: "timeout-ms",
      description: "Optional per-call timeout override in milliseconds (1000-300000).",
      valueType: "number",
      valueName: "ms",
    },
    {
      name: "json",
      description: "JSON object containing server and optional timeoutMs.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List tools exposed by a server",
      command: "panda mcp tools filesystem",
    },
    {
      description: "Use JSON input",
      command: "panda mcp tools --json '{\"server\":\"filesystem\"}'",
    },
  ],
  requiredCapabilities: [MCP_COMMAND_CAPABILITY],
  resultShape: {
    server: "string",
    tools: "array",
    toolCount: "number",
    diagnostics: "object",
    compatibilityWarnings: "array",
  },
};

export const mcpCallCommandDescriptor: CommandDescriptor = {
  name: MCP_CALL_COMMAND_NAME,
  summary: "Call a tool on a configured MCP server.",
  description: "Calls one tool on an agent-scoped stdio MCP server and preserves the MCP result envelope, including non-text content, structuredContent, _meta, isError, and stderr diagnostics.",
  usage: "panda mcp call <server> <tool> --input <json|@file|@-> [--timeout-ms <ms>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json"],
  arguments: [
    {
      name: "server",
      description: "Configured MCP server key from the agent mcp.json config.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "server",
    },
    {
      name: "tool",
      description: "MCP tool name to call. Panda does not filter by tool annotations; mcp group access is the safety boundary.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "tool",
    },
    {
      name: "input",
      description: "Tool arguments as a JSON object. Accepts inline JSON, @file, or @-.",
      required: true,
      valueType: "json",
      valueName: "json|@file|@-",
      valueSources: ["literal", "file", "stdin"],
    },
    {
      name: "timeout-ms",
      description: "Optional per-call timeout override in milliseconds (1000-300000).",
      valueType: "number",
      valueName: "ms",
    },
    {
      name: "json",
      description: "JSON object containing server, tool, input, and optional timeoutMs.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Call a tool with inline JSON input",
      command: "panda mcp call filesystem read_file --input '{\"path\":\"README.md\"}'",
    },
    {
      description: "Read tool input from a file",
      command: "panda mcp call filesystem write_file --input @payload.json",
    },
  ],
  requiredCapabilities: [MCP_COMMAND_CAPABILITY],
  resultShape: {
    server: "string",
    tool: "string",
    content: "array",
    structuredContent: "object|undefined",
    _meta: "object|undefined",
    isError: "boolean|undefined",
    diagnostics: "object",
    compatibilityWarnings: "array",
    exitCode: "number",
  },
};

export function createMcpToolsCommand(options: McpCommandOptions = {}): RegisteredCommand {
  const env = options.env ?? process.env;
  return {
    descriptor: mcpToolsCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<McpToolsOutput>> {
      try {
        const input = parseToolsInput(request.input);
        const {config, source} = await resolveConfiguredServer(request.scope.agentKey, input.server, env);
        const run = await runWithMcpClient(withInputTimeout(config, input.timeoutMs), (client, requestOptions) => (
          client.listTools(undefined, requestOptions)
        ));
        const result = toJsonObject(run.value, "MCP tools result");
        const tools = toJsonObjectArray(result.tools, "MCP tools result.tools");
        const warnings = compatibilityWarningsForTools(tools);
        const output = addRunMetadata<McpToolsOutput>({
          ...result,
          server: input.server,
          tools,
          toolCount: tools.length,
          diagnostics: diagnosticsJson(run.diagnostics, source),
          compatibilityWarnings: warnings,
        }, run);

        return {
          ok: true,
          command: MCP_TOOLS_COMMAND_NAME,
          output,
          summary: `Listed ${tools.length} MCP tool${tools.length === 1 ? "" : "s"} from ${input.server}.`,
        };
      } catch (error) {
        throw normalizeMcpError(error);
      }
    },
  };
}

export function createMcpCallCommand(options: McpCommandOptions = {}): RegisteredCommand {
  const env = options.env ?? process.env;
  return {
    descriptor: mcpCallCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<McpCallOutput>> {
      try {
        const input = parseCallInput(request.input);
        const {config, source} = await resolveConfiguredServer(request.scope.agentKey, input.server, env);
        const run = await runWithMcpClient(withInputTimeout(config, input.timeoutMs), (client, requestOptions) => (
          client.callTool({
            name: input.tool,
            arguments: input.input,
          }, CompatibilityCallToolResultSchema, requestOptions)
        ));
        const result = toJsonObject(run.value, "MCP call result");
        const isError = result.isError === true;
        const output = addRunMetadata<McpCallOutput>({
          ...result,
          server: input.server,
          tool: input.tool,
          diagnostics: diagnosticsJson(run.diagnostics, source),
          compatibilityWarnings: [],
          exitCode: isError ? 4 : 0,
        }, run);

        return {
          ok: true,
          command: MCP_CALL_COMMAND_NAME,
          output,
          summary: isError
            ? `MCP tool ${input.server}/${input.tool} returned isError.`
            : `Called MCP tool ${input.server}/${input.tool}.`,
        };
      } catch (error) {
        throw normalizeMcpError(error);
      }
    },
  };
}
