import type {McpAgentConfigRecord, McpServerConfig} from "./types.js";

export type McpServerMutationMode = "upsert" | "create" | "update";

export interface McpServerMutationOptions {
  expectedVersion?: number;
  mode?: McpServerMutationMode;
}

export interface McpServerMutationResult {
  record: McpAgentConfigRecord;
  previous?: McpServerConfig;
  server?: McpServerConfig;
  changed: boolean;
}

export interface McpServerDeleteResult {
  record: McpAgentConfigRecord;
  previous?: McpServerConfig;
  deleted: boolean;
}

export class McpRegistryVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`MCP registry version is stale; current version is ${currentVersion}.`);
    this.name = "McpRegistryVersionConflictError";
  }
}

export interface McpConfigReader {
  getAgentConfig(agentKey: string): Promise<McpAgentConfigRecord>;
}

export interface McpConfigStore extends McpConfigReader {
  putServer(agentKey: string, serverName: string, config: unknown, options?: McpServerMutationOptions): Promise<McpServerMutationResult>;
  setServerEnabled(agentKey: string, serverName: string, enabled: boolean, options?: Pick<McpServerMutationOptions, "expectedVersion">): Promise<McpServerMutationResult>;
  deleteServer(agentKey: string, serverName: string, options?: Pick<McpServerMutationOptions, "expectedVersion">): Promise<McpServerDeleteResult>;
}
