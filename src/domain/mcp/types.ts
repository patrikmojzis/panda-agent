import type {JsonObject} from "../../lib/json.js";

export const MCP_DEFAULT_TIMEOUT_MS = 30_000;
export const MCP_MIN_TIMEOUT_MS = 1_000;
export const MCP_MAX_TIMEOUT_MS = 120_000;
export const MCP_MAX_SERVERS = 100;
export const MCP_MAX_TOOL_PAGES = 100;
export const MCP_MAX_TOOLS = 10_000;
export const MCP_STDERR_MAX_BYTES = 64 * 1024;
export const MCP_HTTP_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const MCP_STDIO_LINE_MAX_BYTES = 8 * 1024 * 1024;
export const MCP_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

export type McpTransportKind = "stdio" | "streamable-http" | "sse";

export type McpValueSource =
  | {value: string}
  | {credentialEnvKey: string};

export interface McpStdioServerConfig {
  transport: "stdio";
  enabled: boolean;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, McpValueSource>;
  timeoutMs: number;
}

export interface McpHttpHeaderValue {
  name: string;
  value?: string;
  credentialEnvKey?: string;
}

export interface McpHttpBearerAuth {
  type: "bearer";
  credentialEnvKey: string;
}

export type McpOAuthRegistration =
  | {mode: "dynamic"}
  | {mode: "manual"};

export type McpOAuthScope =
  | {mode: "explicit"; values: string[]}
  | {mode: "server-default"};

export interface McpHttpOAuthAuth {
  type: "oauth";
  registration: McpOAuthRegistration;
  scope: McpOAuthScope;
  trustedOrigins?: string[];
}

export type McpHttpAuth = McpHttpBearerAuth | McpHttpOAuthAuth;

export interface McpHttpServerConfig {
  transport: "streamable-http" | "sse";
  enabled: boolean;
  url: string;
  headers?: McpHttpHeaderValue[];
  auth?: McpHttpAuth;
  timeoutMs: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpAgentConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpAgentConfigRecord {
  agentKey: string;
  config: McpAgentConfig;
  version: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface McpResolvedStdioServerConfig extends Omit<McpStdioServerConfig, "env"> {
  env?: Record<string, string>;
}

export interface McpResolvedHttpServerConfig extends Omit<McpHttpServerConfig, "headers" | "auth"> {
  headers?: Record<string, string>;
  oauth?: {
    agentKey: string;
    serverName: string;
    auth: McpHttpOAuthAuth;
  };
}

export type McpResolvedServerConfig = McpResolvedStdioServerConfig | McpResolvedHttpServerConfig;

export interface McpResolvedInvocation {
  config: McpResolvedServerConfig;
  knownSecrets: readonly string[];
}

export interface McpStdioDiagnostics {
  transport: "stdio";
  pid?: number;
  stderr: string;
  stderrTruncated: boolean;
}

export interface McpHttpDiagnostics {
  transport: "streamable-http" | "sse";
}

export type McpOperationDiagnostics = McpStdioDiagnostics | McpHttpDiagnostics;

export interface McpRunnerResult<T> {
  value: T;
  diagnostics: McpOperationDiagnostics;
  serverInfo?: JsonObject;
  serverCapabilities?: JsonObject;
}

export interface McpRunner {
  listTools(invocation: McpResolvedInvocation): Promise<McpRunnerResult<JsonObject>>;
  callTool(invocation: McpResolvedInvocation, input: {name: string; arguments: JsonObject}): Promise<McpRunnerResult<JsonObject>>;
}

export type McpCompatibilityWarning = JsonObject;
export type McpToolsOutput = JsonObject;
export type McpCallOutput = JsonObject;
