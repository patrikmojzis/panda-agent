import {normalizeMcpConfig, normalizeMcpServerConfig} from "./config.js";
import type {McpAgentConfig, McpAgentConfigRecord, McpServerConfig} from "./types.js";

export interface McpConfigReader {
  getAgentConfig(agentKey: string): Promise<McpAgentConfigRecord>;
}

export interface McpConfigStore extends McpConfigReader {
  putServer(agentKey: string, serverName: string, config: unknown): Promise<McpAgentConfigRecord>;
  deleteServer(agentKey: string, serverName: string): Promise<{record: McpAgentConfigRecord; deleted: boolean}>;
}

export class InMemoryMcpConfigStore implements McpConfigStore {
  private readonly configs = new Map<string, McpAgentConfigRecord>();

  constructor(seed: Record<string, unknown> = {}) {
    for (const [agentKey, config] of Object.entries(seed)) {
      this.configs.set(agentKey, {agentKey, config: normalizeMcpConfig(config)});
    }
  }

  async getAgentConfig(agentKey: string): Promise<McpAgentConfigRecord> {
    const existing = this.configs.get(agentKey);
    return existing
      ? structuredClone(existing)
      : {agentKey, config: {servers: {}}};
  }

  async putServer(agentKey: string, serverName: string, input: unknown): Promise<McpAgentConfigRecord> {
    const existing = await this.getAgentConfig(agentKey);
    const config: McpAgentConfig = normalizeMcpConfig({
      servers: {...existing.config.servers, [serverName]: normalizeMcpServerConfig(serverName, input)},
    });
    const now = Date.now();
    const record = {
      agentKey,
      config,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(agentKey, structuredClone(record));
    return record;
  }

  async deleteServer(agentKey: string, serverName: string): Promise<{record: McpAgentConfigRecord; deleted: boolean}> {
    const existing = await this.getAgentConfig(agentKey);
    const deleted = Object.hasOwn(existing.config.servers, serverName);
    const servers: Record<string, McpServerConfig> = {...existing.config.servers};
    delete servers[serverName];
    const now = Date.now();
    const record = {
      agentKey,
      config: normalizeMcpConfig({servers}),
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(agentKey, structuredClone(record));
    return {record, deleted};
  }
}
