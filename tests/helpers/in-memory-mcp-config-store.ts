import {normalizeMcpConfig, normalizeMcpServerConfig} from "../../src/domain/mcp/config.js";
import {McpRegistryVersionConflictError, type McpConfigStore, type McpServerMutationOptions, type McpServerMutationResult, type McpServerDeleteResult} from "../../src/domain/mcp/store.js";
import type {McpAgentConfig, McpAgentConfigRecord, McpServerConfig} from "../../src/domain/mcp/types.js";

export class InMemoryMcpConfigStore implements McpConfigStore {
  private readonly configs = new Map<string, McpAgentConfigRecord>();

  constructor(seed: Record<string, unknown> = {}) {
    for (const [agentKey, config] of Object.entries(seed)) {
      this.configs.set(agentKey, {agentKey, config: normalizeMcpConfig(config), version: 1});
    }
  }

  async getAgentConfig(agentKey: string): Promise<McpAgentConfigRecord> {
    const existing = this.configs.get(agentKey);
    return existing
      ? structuredClone(existing)
      : {agentKey, config: {servers: {}}, version: 0};
  }

  async putServer(agentKey: string, serverName: string, input: unknown, options: McpServerMutationOptions = {}): Promise<McpServerMutationResult> {
    const existing = await this.getAgentConfig(agentKey);
    if (options.expectedVersion !== undefined && options.expectedVersion !== existing.version) {
      throw new McpRegistryVersionConflictError(existing.version);
    }
    const previous = existing.config.servers[serverName];
    if (options.mode === "create" && previous) throw new Error(`MCP server ${serverName} already exists.`);
    if (options.mode === "update" && !previous) throw new Error(`MCP server ${serverName} is not configured.`);
    const server = normalizeMcpServerConfig(serverName, input);
    const changed = JSON.stringify(previous) !== JSON.stringify(server);
    if (!changed) return {record: existing, ...(previous ? {previous} : {}), server, changed: false};
    const config: McpAgentConfig = normalizeMcpConfig({
      servers: {...existing.config.servers, [serverName]: server},
    });
    const now = Date.now();
    const record = {
      agentKey,
      config,
      version: existing.version + 1,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(agentKey, structuredClone(record));
    return {record, ...(previous ? {previous} : {}), server, changed: true};
  }

  async setServerEnabled(agentKey: string, serverName: string, enabled: boolean, options: Pick<McpServerMutationOptions, "expectedVersion"> = {}): Promise<McpServerMutationResult> {
    const existing = await this.getAgentConfig(agentKey);
    if (options.expectedVersion !== undefined && options.expectedVersion !== existing.version) {
      throw new McpRegistryVersionConflictError(existing.version);
    }
    const previous = existing.config.servers[serverName];
    if (!previous) throw new Error(`MCP server ${serverName} is not configured.`);
    if (previous.enabled === enabled) return {record: existing, previous, server: previous, changed: false};
    return this.putServer(agentKey, serverName, {...previous, enabled}, {expectedVersion: existing.version, mode: "update"});
  }

  async deleteServer(agentKey: string, serverName: string, options: Pick<McpServerMutationOptions, "expectedVersion"> = {}): Promise<McpServerDeleteResult> {
    const existing = await this.getAgentConfig(agentKey);
    if (options.expectedVersion !== undefined && options.expectedVersion !== existing.version) {
      throw new McpRegistryVersionConflictError(existing.version);
    }
    const previous = existing.config.servers[serverName];
    const deleted = Object.hasOwn(existing.config.servers, serverName);
    if (!deleted) return {record: existing, deleted: false};
    const servers: Record<string, McpServerConfig> = {...existing.config.servers};
    delete servers[serverName];
    const now = Date.now();
    const record = {
      agentKey,
      config: normalizeMcpConfig({servers}),
      version: existing.version + 1,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(agentKey, structuredClone(record));
    return {record, ...(previous ? {previous} : {}), deleted};
  }
}
