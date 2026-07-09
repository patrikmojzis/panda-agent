import type {JsonObject} from "../../lib/json.js";

export const MCP_CONFIG_ENV_KEY = "PANDA_MCP_CONFIG";
export const MCP_DEFAULT_CONFIG_FILE = "mcp.json";
export const MCP_DEFAULT_TIMEOUT_MS = 30_000;
export const MCP_MIN_TIMEOUT_MS = 1_000;
export const MCP_MAX_TIMEOUT_MS = 300_000;
export const MCP_STDERR_MAX_CHARS = 16_000;

export type McpTransportKind = "stdio";

export interface McpStdioServerConfig {
  transport: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

export type McpServerConfig = McpStdioServerConfig;

export interface McpAgentConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpResolvedAgentConfig {
  config: McpAgentConfig;
  source: string;
}

export interface McpStderrDiagnostics {
  stderr: string;
  stderrTruncated: boolean;
}

export interface McpOperationDiagnostics extends McpStderrDiagnostics {
  transport: McpTransportKind;
  pid?: number;
}

export type McpCompatibilityWarning = JsonObject;
export type McpToolsOutput = JsonObject;
export type McpCallOutput = JsonObject;
