import {readFile} from "node:fs/promises";
import path from "node:path";

import {isRecord} from "../../lib/records.js";
import {resolveAgentDir} from "../../lib/data-dir.js";
import {trimToNull} from "../../lib/strings.js";
import {
  MCP_CONFIG_ENV_KEY,
  MCP_DEFAULT_CONFIG_FILE,
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_MAX_TIMEOUT_MS,
  MCP_MIN_TIMEOUT_MS,
  type McpAgentConfig,
  type McpResolvedAgentConfig,
  type McpServerConfig,
} from "./types.js";

const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function isSafeMcpServerName(value: string): boolean {
  return SERVER_NAME_PATTERN.test(value);
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return readRequiredString(value, label);
}

function readStringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }

  return value.map((entry) => entry);
}

function readStringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object with string values.`);
  }

  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) {
      throw new Error(`${label} keys must be non-empty strings.`);
    }
    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} must be a string.`);
    }
    entries.push([key, entry]);
  }

  return Object.fromEntries(entries);
}

function readTimeoutMs(value: unknown, label: string): number {
  if (value === undefined || value === null) {
    return MCP_DEFAULT_TIMEOUT_MS;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer number of milliseconds.`);
  }
  if (value < MCP_MIN_TIMEOUT_MS || value > MCP_MAX_TIMEOUT_MS) {
    throw new Error(`${label} must be between ${MCP_MIN_TIMEOUT_MS} and ${MCP_MAX_TIMEOUT_MS}.`);
  }

  return value;
}

function normalizeServerConfig(name: string, value: unknown): McpServerConfig {
  if (!isSafeMcpServerName(name)) {
    throw new Error(`MCP server name ${JSON.stringify(name)} must match ${SERVER_NAME_PATTERN}.`);
  }
  if (!isRecord(value)) {
    throw new Error(`MCP server ${name} must be a JSON object.`);
  }
  const transport = value.transport ?? "stdio";
  if (transport !== "stdio") {
    throw new Error(`MCP server ${name} transport must be "stdio".`);
  }

  const cwd = readOptionalString(value.cwd, `MCP server ${name} cwd`);
  return {
    transport: "stdio",
    command: readRequiredString(value.command, `MCP server ${name} command`),
    args: readStringArray(value.args, `MCP server ${name} args`),
    ...(cwd ? {cwd} : {}),
    ...(value.env === undefined || value.env === null ? {} : {env: readStringMap(value.env, `MCP server ${name} env`)}),
    timeoutMs: readTimeoutMs(value.timeoutMs, `MCP server ${name} timeoutMs`),
  };
}

function normalizeMcpConfig(value: unknown): McpAgentConfig {
  if (!isRecord(value)) {
    throw new Error("MCP config must be a JSON object.");
  }
  if (!isRecord(value.servers)) {
    throw new Error("MCP config must include a servers object.");
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, serverConfig] of Object.entries(value.servers)) {
    servers[name] = normalizeServerConfig(name, serverConfig);
  }

  return {servers};
}

export function resolveAgentMcpConfigPath(agentKey: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = trimToNull(env[MCP_CONFIG_ENV_KEY]);
  if (override) {
    return path.resolve(override);
  }

  return path.join(resolveAgentDir(agentKey, env), MCP_DEFAULT_CONFIG_FILE);
}

export async function readAgentMcpConfig(
  agentKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpResolvedAgentConfig> {
  const source = resolveAgentMcpConfigPath(agentKey, env);
  let raw: string;
  try {
    raw = await readFile(source, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return {source, config: {servers: {}}};
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid MCP config JSON at ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    source,
    config: normalizeMcpConfig(parsed),
  };
}

export async function readAgentMcpServerConfig(
  agentKey: string,
  server: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{config: McpServerConfig; source: string}> {
  if (!isSafeMcpServerName(server)) {
    throw new Error(`MCP server name ${JSON.stringify(server)} must match ${SERVER_NAME_PATTERN}.`);
  }
  const resolved = await readAgentMcpConfig(agentKey, env);
  const serverConfig = resolved.config.servers[server];
  if (!serverConfig) {
    throw new Error(`MCP server ${server} is not configured in ${resolved.source}.`);
  }

  return {config: serverConfig, source: resolved.source};
}
