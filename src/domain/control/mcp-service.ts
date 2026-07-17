import {normalizeToJsonValue, stableStringify} from "../../lib/json.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import type {CredentialResolver} from "../credentials/resolver.js";
import {isSafeMcpServerName, referencedMcpCredentialEnvKeys} from "../mcp/config.js";
import type {McpConfigStore} from "../mcp/store.js";
import type {McpAgentConfigRecord, McpServerConfig} from "../mcp/types.js";
import type {ControlReadService} from "./read-service.js";
import type {ControlSessionRecord} from "./types.js";

export type ControlMcpServerStatus =
  | "disabled"
  | "ready"
  | "missing_credentials"
  | "credential_store_unavailable"
  | "credential_unreadable";

export type ControlMcpServerRow = McpServerConfig & {
  serverName: string;
  credentialEnvKeys: string[];
  status: ControlMcpServerStatus;
  createdAt?: string;
  updatedAt?: string;
};

export interface ControlMcpServiceOptions {
  reads: Pick<ControlReadService, "listAgents">;
  configs: McpConfigStore;
  credentials: Pick<CredentialResolver, "resolveCredential">;
}

function iso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function changedFields(before: McpServerConfig | undefined, after: McpServerConfig): string[] {
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...fields].filter((field) => stableStringify(normalizeToJsonValue((before as unknown as Record<string, unknown> | undefined)?.[field]))
    !== stableStringify(normalizeToJsonValue((after as unknown as Record<string, unknown>)[field])));
}

export class ControlMcpService {
  private readonly reads: ControlMcpServiceOptions["reads"];
  private readonly configs: McpConfigStore;
  private readonly credentials: ControlMcpServiceOptions["credentials"];

  constructor(options: ControlMcpServiceOptions) {
    this.reads = options.reads;
    this.configs = options.configs;
    this.credentials = options.credentials;
  }

  private async assertAgentVisible(session: ControlSessionRecord, agentKey: string): Promise<string> {
    const normalized = requireNonEmptyString(agentKey, "Agent key is required.");
    if (!(await this.reads.listAgents(session)).some((agent) => agent.agentKey === normalized)) {
      throw new Error("Control target agent was not found or is not visible.");
    }
    return normalized;
  }

  private normalizeServerName(serverName: string): string {
    const normalized = requireNonEmptyString(serverName, "MCP server name is required.");
    if (!isSafeMcpServerName(normalized)) throw new Error("MCP server name is invalid.");
    return normalized;
  }

  private async status(agentKey: string, config: McpServerConfig): Promise<ControlMcpServerStatus> {
    if (!config.enabled) return "disabled";
    const keys = referencedMcpCredentialEnvKeys(config);
    for (const key of keys) {
      try {
        if (!await this.credentials.resolveCredential(key, {agentKey})) return "missing_credentials";
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return message.includes("CREDENTIALS_MASTER_KEY")
          ? "credential_store_unavailable"
          : "credential_unreadable";
      }
    }
    return "ready";
  }

  private async rows(record: McpAgentConfigRecord): Promise<ControlMcpServerRow[]> {
    return Promise.all(Object.entries(record.config.servers).map(async ([serverName, config]) => ({
      serverName,
      ...config,
      credentialEnvKeys: referencedMcpCredentialEnvKeys(config),
      status: await this.status(record.agentKey, config),
      ...(iso(record.createdAt) ? {createdAt: iso(record.createdAt)} : {}),
      ...(iso(record.updatedAt) ? {updatedAt: iso(record.updatedAt)} : {}),
    })));
  }

  async listServers(session: ControlSessionRecord, agentKey: string): Promise<{servers: ControlMcpServerRow[]; count: number}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const servers = await this.rows(await this.configs.getAgentConfig(normalizedAgentKey));
    servers.sort((left, right) => left.serverName.localeCompare(right.serverName));
    return {servers, count: servers.length};
  }

  async putServer(
    session: ControlSessionRecord,
    agentKey: string,
    serverName: string,
    input: unknown,
  ): Promise<{server: ControlMcpServerRow; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const normalizedServerName = this.normalizeServerName(serverName);
    const before = (await this.configs.getAgentConfig(normalizedAgentKey)).config.servers[normalizedServerName];
    const record = await this.configs.putServer(normalizedAgentKey, normalizedServerName, input);
    const config = record.config.servers[normalizedServerName]!;
    const server = (await this.rows({...record, config: {servers: {[normalizedServerName]: config}}}))[0]!;
    return {
      server,
      audit: {
        action: "put_mcp_server",
        agentKey: normalizedAgentKey,
        serverName: normalizedServerName,
        transport: config.transport,
        enabled: config.enabled,
        changedFields: changedFields(before, config),
        credentialEnvKeys: referencedMcpCredentialEnvKeys(config),
      },
    };
  }

  async deleteServer(
    session: ControlSessionRecord,
    agentKey: string,
    serverName: string,
  ): Promise<{deleted: boolean; audit: Record<string, unknown>}> {
    const normalizedAgentKey = await this.assertAgentVisible(session, agentKey);
    const normalizedServerName = this.normalizeServerName(serverName);
    const before = (await this.configs.getAgentConfig(normalizedAgentKey)).config.servers[normalizedServerName];
    const {deleted} = await this.configs.deleteServer(normalizedAgentKey, normalizedServerName);
    return {
      deleted,
      audit: {
        action: "delete_mcp_server",
        agentKey: normalizedAgentKey,
        serverName: normalizedServerName,
        ...(before ? {transport: before.transport, enabled: before.enabled, credentialEnvKeys: referencedMcpCredentialEnvKeys(before)} : {}),
        changedFields: deleted ? ["deleted"] : [],
      },
    };
  }
}
