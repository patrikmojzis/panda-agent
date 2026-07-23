import type {CredentialResolver} from "../credentials/resolver.js";
import {commandScopeDenied} from "../commands/errors.js";
import type {ExecutionCredentialPolicy} from "../execution-environments/types.js";
import {mcpOAuthGrantRef} from "./oauth-types.js";
import {referencedMcpCredentialEnvKeys} from "./config.js";
import type {McpConfigReader} from "./store.js";
import type {McpResolvedInvocation, McpValueSource} from "./types.js";

export class McpInvocationError extends Error {
  readonly pandaCommandErrorDetails: Record<string, unknown>;

  constructor(message: string, exitCode: number, kind: string) {
    super(message);
    this.name = "McpInvocationError";
    this.pandaCommandErrorDetails = {exitCode, kind};
  }
}

export function assertMcpCredentialPolicy(
  policy: ExecutionCredentialPolicy | undefined,
  envKeys: readonly string[],
  credentialRefs: readonly string[] = [],
): void {
  if (envKeys.length === 0 && credentialRefs.length === 0) return;
  if (policy?.mode === "all_agent") return;
  const allowedKeys = policy?.mode === "allowlist" ? new Set(policy.envKeys) : new Set<string>();
  if (envKeys.some((key) => !allowedKeys.has(key))) {
    throw commandScopeDenied(
      "An MCP credential required by this server is not allowed in the current execution scope.",
      "command_scope_denied",
      "Use an MCP server whose credential requirements are allowed by the current execution scope.",
    );
  }
  const allowedRefs = policy?.mode === "allowlist" ? new Set(policy.credentialRefs ?? []) : new Set<string>();
  if (credentialRefs.some((ref) => !allowedRefs.has(ref))) {
    throw commandScopeDenied(
      "An MCP OAuth grant required by this server is not allowed in the current execution scope.",
      "command_scope_denied",
      "Use an MCP server whose OAuth grant is allowed by the current execution scope.",
    );
  }
}

async function resolveCredentialValues(
  credentials: Pick<CredentialResolver, "resolveCredential">,
  agentKey: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  for (const key of keys) {
    let resolved;
    try {
      resolved = await credentials.resolveCredential(key, {agentKey});
    } catch {
      throw new McpInvocationError(`MCP credential ${key} could not be decrypted.`, 3, "authentication");
    }
    if (!resolved) throw new McpInvocationError(`MCP credential ${key} is not configured.`, 3, "authentication");
    values.set(key, resolved.value);
  }
  return values;
}

function resolveValue(source: McpValueSource, credentials: ReadonlyMap<string, string>): string {
  if ("value" in source) return source.value;
  const value = credentials.get(source.credentialEnvKey);
  if (value === undefined) throw new McpInvocationError("MCP credential resolution failed closed.", 3, "authentication");
  return value;
}

export async function resolveMcpInvocation(input: {
  configs: McpConfigReader;
  credentials: Pick<CredentialResolver, "resolveCredential">;
  agentKey: string;
  serverName: string;
  credentialPolicy?: ExecutionCredentialPolicy;
  timeoutMs?: number;
  allowDisabled?: boolean;
}): Promise<McpResolvedInvocation> {
  let record;
  try {
    record = await input.configs.getAgentConfig(input.agentKey);
  } catch {
    throw new McpInvocationError("Stored MCP config is invalid.", 2, "config_input");
  }
  const config = record.config.servers[input.serverName];
  if (!config) throw new McpInvocationError(`MCP server ${input.serverName} is not configured.`, 2, "config_input");
  if (!config.enabled && input.allowDisabled !== true) {
    throw new McpInvocationError(`MCP server ${input.serverName} is disabled.`, 2, "config_input");
  }
  const keys = referencedMcpCredentialEnvKeys(config);
  const oauthRefs = config.transport === "streamable-http" && config.auth?.type === "oauth"
    ? [mcpOAuthGrantRef(input.serverName)]
    : [];
  assertMcpCredentialPolicy(input.credentialPolicy, keys, oauthRefs);
  const credentials = await resolveCredentialValues(input.credentials, input.agentKey, keys);
  const timeoutMs = input.timeoutMs ?? config.timeoutMs;
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
        timeoutMs,
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
      timeoutMs,
      ...(Object.keys(headers).length > 0 ? {headers} : {}),
      ...(config.auth?.type === "oauth" ? {oauth: {
        agentKey: input.agentKey,
        serverName: input.serverName,
        auth: config.auth,
      }} : {}),
    },
    knownSecrets: [...credentials.values()],
  };
}
