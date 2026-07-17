import {normalizeCredentialEnvKey} from "../credentials/types.js";
import {isRecord} from "../../lib/records.js";
import {
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_MAX_SERVERS,
  MCP_MAX_TIMEOUT_MS,
  MCP_MIN_TIMEOUT_MS,
  type McpAgentConfig,
  type McpHttpBearerAuth,
  type McpHttpHeaderValue,
  type McpServerConfig,
  type McpValueSource,
} from "./types.js";

const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COMMON_SERVER_FIELDS = new Set(["transport", "enabled", "timeoutMs"]);
const STDIO_SERVER_FIELDS = new Set([...COMMON_SERVER_FIELDS, "command", "args", "cwd", "env"]);
const HTTP_SERVER_FIELDS = new Set([...COMMON_SERVER_FIELDS, "url", "headers", "auth"]);
const VALUE_SOURCE_FIELDS = new Set(["value", "credentialEnvKey"]);
const HEADER_FIELDS = new Set(["name", "value", "credentialEnvKey"]);
const AUTH_FIELDS = new Set(["type", "credentialEnvKey"]);
const CONFIG_FIELDS = new Set(["servers"]);
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

export function isSafeMcpServerName(value: string): boolean {
  return SERVER_NAME_PATTERN.test(value);
}

function assertKnownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field ${unknown[0]}.`);
  }
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (/\r|\n/.test(value)) {
    throw new Error(`${label} must not contain CR or LF characters.`);
  }
  return value.trim();
}

function readLiteralString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (/\r|\n/.test(value)) {
    throw new Error(`${label} must not contain CR or LF characters.`);
  }
  return value;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : readRequiredString(value, label);
}

function readEnabled(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function readTimeoutMs(value: unknown, label: string): number {
  if (value === undefined || value === null) return MCP_DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer number of milliseconds.`);
  }
  if (value < MCP_MIN_TIMEOUT_MS || value > MCP_MAX_TIMEOUT_MS) {
    throw new Error(`${label} must be between ${MCP_MIN_TIMEOUT_MS} and ${MCP_MAX_TIMEOUT_MS}.`);
  }
  return value;
}

function readStringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || /\0/.test(entry))) {
    throw new Error(`${label} must be an array of strings without NUL characters.`);
  }
  return [...value];
}

function readValueSource(value: unknown, label: string): McpValueSource {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  assertKnownFields(value, VALUE_SOURCE_FIELDS, label);
  const hasValue = Object.hasOwn(value, "value");
  const hasCredential = Object.hasOwn(value, "credentialEnvKey");
  if (hasValue === hasCredential) {
    throw new Error(`${label} must include exactly one of value or credentialEnvKey.`);
  }
  if (hasValue) return {value: readLiteralString(value.value, `${label} value`)};
  return {
    credentialEnvKey: normalizeCredentialEnvKey(
      readRequiredString(value.credentialEnvKey, `${label} credentialEnvKey`),
    ),
  };
}

function readEnvironment(value: unknown, label: string): Record<string, McpValueSource> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  const entries = Object.entries(value).map(([key, source]) => {
    const envKey = normalizeCredentialEnvKey(key);
    return [envKey, readValueSource(source, `${label}.${envKey}`)] as const;
  });
  return Object.fromEntries(entries);
}

function readUrl(value: unknown, label: string): string {
  const raw = readRequiredString(value, label);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http: or https:.`);
  }
  if (url.username || url.password) throw new Error(`${label} must not include userinfo.`);
  if (url.hash) throw new Error(`${label} must not include a fragment.`);
  return url.toString();
}

function normalizeHeaderName(value: unknown, label: string): string {
  const name = readRequiredString(value, label);
  if (!HEADER_NAME_PATTERN.test(name)) throw new Error(`${label} is not a valid HTTP header name.`);
  const lower = name.toLowerCase();
  if (RESERVED_HEADERS.has(lower) || lower.startsWith("proxy-")) {
    throw new Error(`${label} ${name} is owned by HTTP or the MCP SDK.`);
  }
  return name;
}

function readHeaders(value: unknown, label: string, hasAuth: boolean): McpHttpHeaderValue[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!isRecord(entry)) throw new Error(`${itemLabel} must be a JSON object.`);
    assertKnownFields(entry, HEADER_FIELDS, itemLabel);
    const name = normalizeHeaderName(entry.name, `${itemLabel} name`);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new Error(`${label} contains duplicate header ${name}.`);
    if (hasAuth && lower === "authorization") {
      throw new Error(`${itemLabel} Authorization conflicts with bearer auth.`);
    }
    seen.add(lower);
    const hasValue = Object.hasOwn(entry, "value");
    const hasCredential = Object.hasOwn(entry, "credentialEnvKey");
    if (hasValue === hasCredential) {
      throw new Error(`${itemLabel} must include exactly one of value or credentialEnvKey.`);
    }
    return hasValue
      ? {name, value: readLiteralString(entry.value, `${itemLabel} value`)}
      : {
        name,
        credentialEnvKey: normalizeCredentialEnvKey(
          readRequiredString(entry.credentialEnvKey, `${itemLabel} credentialEnvKey`),
        ),
      };
  });
}

function readAuth(value: unknown, label: string): McpHttpBearerAuth | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  assertKnownFields(value, AUTH_FIELDS, label);
  if (value.type !== "bearer") throw new Error(`${label} type must be "bearer".`);
  return {
    type: "bearer",
    credentialEnvKey: normalizeCredentialEnvKey(
      readRequiredString(value.credentialEnvKey, `${label} credentialEnvKey`),
    ),
  };
}

export function normalizeMcpServerConfig(name: string, value: unknown): McpServerConfig {
  if (!isSafeMcpServerName(name)) {
    throw new Error(`MCP server name ${JSON.stringify(name)} must match ${SERVER_NAME_PATTERN}.`);
  }
  if (!isRecord(value)) throw new Error(`MCP server ${name} must be a JSON object.`);
  if (value.transport === "stdio") {
    assertKnownFields(value, STDIO_SERVER_FIELDS, `MCP server ${name}`);
    const cwd = readOptionalString(value.cwd, `MCP server ${name} cwd`);
    const env = readEnvironment(value.env, `MCP server ${name} env`);
    return {
      transport: "stdio",
      enabled: readEnabled(value.enabled, `MCP server ${name} enabled`),
      command: readRequiredString(value.command, `MCP server ${name} command`),
      args: readStringArray(value.args, `MCP server ${name} args`),
      ...(cwd ? {cwd} : {}),
      ...(env ? {env} : {}),
      timeoutMs: readTimeoutMs(value.timeoutMs, `MCP server ${name} timeoutMs`),
    };
  }
  if (value.transport === "streamable-http" || value.transport === "sse") {
    assertKnownFields(value, HTTP_SERVER_FIELDS, `MCP server ${name}`);
    const auth = readAuth(value.auth, `MCP server ${name} auth`);
    const headers = readHeaders(value.headers, `MCP server ${name} headers`, Boolean(auth));
    return {
      transport: value.transport,
      enabled: readEnabled(value.enabled, `MCP server ${name} enabled`),
      url: readUrl(value.url, `MCP server ${name} url`),
      ...(headers ? {headers} : {}),
      ...(auth ? {auth} : {}),
      timeoutMs: readTimeoutMs(value.timeoutMs, `MCP server ${name} timeoutMs`),
    };
  }
  throw new Error(`MCP server ${name} transport must be "stdio", "streamable-http", or "sse".`);
}

export function normalizeMcpConfig(value: unknown): McpAgentConfig {
  if (!isRecord(value)) throw new Error("MCP config must be a JSON object.");
  assertKnownFields(value, CONFIG_FIELDS, "MCP config");
  if (!isRecord(value.servers)) throw new Error("MCP config must include a servers object.");
  const entries = Object.entries(value.servers);
  if (entries.length > MCP_MAX_SERVERS) {
    throw new Error(`MCP config cannot contain more than ${MCP_MAX_SERVERS} servers.`);
  }
  return {
    servers: Object.fromEntries(entries.map(([name, config]) => [name, normalizeMcpServerConfig(name, config)])),
  };
}

export function referencedMcpCredentialEnvKeys(config: McpServerConfig): string[] {
  const keys = config.transport === "stdio"
    ? Object.values(config.env ?? {}).flatMap((source) => "credentialEnvKey" in source ? [source.credentialEnvKey] : [])
    : [
      ...(config.auth ? [config.auth.credentialEnvKey] : []),
      ...(config.headers ?? []).flatMap((header) => header.credentialEnvKey ? [header.credentialEnvKey] : []),
    ];
  return [...new Set(keys)];
}
