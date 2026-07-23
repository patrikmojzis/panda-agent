import type {PgClientLike, PgPoolLike} from "../../lib/postgres-query.js";
import {requireTimestampMillis, toJson} from "../../lib/postgres-values.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {normalizeMcpConfig, normalizeMcpServerConfig} from "./config.js";
import {ensurePostgresMcpSchema} from "./postgres-schema.js";
import {buildMcpTableNames} from "./postgres-shared.js";
import type {McpConfigStore} from "./store.js";
import {McpRegistryVersionConflictError, type McpServerMutationOptions, type McpServerMutationResult, type McpServerDeleteResult} from "./store.js";
import type {McpAgentConfig, McpAgentConfigRecord, McpServerConfig} from "./types.js";

function parseRecord(row: Record<string, unknown>): McpAgentConfigRecord {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("MCP config version must be a positive integer.");
  return {
    agentKey: requireNonEmptyString(row.agent_key, "MCP config row is missing agent_key."),
    config: normalizeMcpConfig(row.config),
    version,
    createdAt: requireTimestampMillis(row.created_at, "MCP config created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "MCP config updated_at must be a valid timestamp."),
  };
}

export class PostgresMcpConfigStore implements McpConfigStore {
  private readonly tables = buildMcpTableNames();
  private readonly agents = buildAgentTableNames();

  constructor(private readonly pool: PgPoolLike) {}

  async ensureSchema(): Promise<void> {
    await ensurePostgresMcpSchema(this.pool);
  }

  async getAgentConfig(agentKey: string): Promise<McpAgentConfigRecord> {
    const normalizedAgentKey = requireNonEmptyString(agentKey, "MCP config agent key is required.");
    const result = await this.pool.query(`
      SELECT agent_key, config, version, created_at, updated_at
      FROM ${this.tables.configs}
      WHERE agent_key = $1
    `, [normalizedAgentKey]);
    const row = result.rows[0];
    return row
      ? parseRecord(row as Record<string, unknown>)
      : {agentKey: normalizedAgentKey, config: {servers: {}}, version: 0};
  }

  private async mutate(
    agentKey: string,
    expectedVersion: number | undefined,
    update: (config: McpAgentConfig) => {
      config: McpAgentConfig;
      changed: boolean;
      previous?: McpServerConfig;
      server?: McpServerConfig;
      deleted?: boolean;
    },
  ): Promise<{
    record: McpAgentConfigRecord;
    changed: boolean;
    previous?: McpServerConfig;
    server?: McpServerConfig;
    deleted?: boolean;
  }> {
    const normalizedAgentKey = requireNonEmptyString(agentKey, "MCP config agent key is required.");
    return withTransaction(this.pool, async (client) => {
      await this.lockAgent(client, normalizedAgentKey);
      const current = await client.query(`
        SELECT agent_key, config, version, created_at, updated_at
        FROM ${this.tables.configs}
        WHERE agent_key = $1
        FOR UPDATE
      `, [normalizedAgentKey]);
      const currentRecord = current.rows[0]
        ? parseRecord(current.rows[0] as Record<string, unknown>)
        : {agentKey: normalizedAgentKey, config: {servers: {}}, version: 0};
      if (expectedVersion !== undefined && expectedVersion !== currentRecord.version) {
        throw new McpRegistryVersionConflictError(currentRecord.version);
      }
      const next = update(currentRecord.config);
      if (!next.changed) return {record: currentRecord, ...next};
      const persisted = current.rows[0]
        ? await client.query(`
          UPDATE ${this.tables.configs}
          SET config = $2::jsonb, version = version + 1, updated_at = NOW()
          WHERE agent_key = $1
          RETURNING agent_key, config, version, created_at, updated_at
        `, [normalizedAgentKey, toJson(normalizeMcpConfig(next.config))])
        : await client.query(`
          INSERT INTO ${this.tables.configs} (agent_key, config, version)
          VALUES ($1, $2::jsonb, 1)
          RETURNING agent_key, config, version, created_at, updated_at
        `, [normalizedAgentKey, toJson(normalizeMcpConfig(next.config))]);
      return {
        record: parseRecord(persisted.rows[0] as Record<string, unknown>),
        ...next,
      };
    });
  }

  private async lockAgent(client: PgClientLike, agentKey: string): Promise<void> {
    const result = await client.query(`
      SELECT agent_key
      FROM ${this.agents.agents}
      WHERE agent_key = $1
      FOR UPDATE
    `, [agentKey]);
    if (result.rows.length === 0) throw new Error(`Unknown agent ${agentKey}.`);
  }

  async putServer(agentKey: string, serverName: string, input: unknown, options: McpServerMutationOptions = {}): Promise<McpServerMutationResult> {
    const server = normalizeMcpServerConfig(serverName, input);
    return this.mutate(agentKey, options.expectedVersion, (current) => {
      const previous = current.servers[serverName];
      if (options.mode === "create" && previous) throw new Error(`MCP server ${serverName} already exists.`);
      if (options.mode === "update" && !previous) throw new Error(`MCP server ${serverName} is not configured.`);
      const changed = JSON.stringify(previous) !== JSON.stringify(server);
      return {
        config: changed ? normalizeMcpConfig({servers: {...current.servers, [serverName]: server}}) : current,
        changed,
        ...(previous ? {previous} : {}),
        server,
      };
    });
  }

  async setServerEnabled(agentKey: string, serverName: string, enabled: boolean, options: Pick<McpServerMutationOptions, "expectedVersion"> = {}): Promise<McpServerMutationResult> {
    return this.mutate(agentKey, options.expectedVersion, (current) => {
      const previous = current.servers[serverName];
      if (!previous) throw new Error(`MCP server ${serverName} is not configured.`);
      const changed = previous.enabled !== enabled;
      const server = changed ? normalizeMcpServerConfig(serverName, {...previous, enabled}) : previous;
      return {
        config: changed ? normalizeMcpConfig({servers: {...current.servers, [serverName]: server}}) : current,
        changed,
        previous,
        server,
      };
    });
  }

  async deleteServer(agentKey: string, serverName: string, options: Pick<McpServerMutationOptions, "expectedVersion"> = {}): Promise<McpServerDeleteResult> {
    const result = await this.mutate(agentKey, options.expectedVersion, (current) => {
      const previous = current.servers[serverName];
      const deleted = previous !== undefined;
      if (!deleted) return {config: current, changed: false, deleted: false};
      const servers: Record<string, McpServerConfig> = {...current.servers};
      delete servers[serverName];
      return {config: normalizeMcpConfig({servers}), changed: true, previous, deleted: true};
    });
    return {
      record: result.record,
      ...(result.previous ? {previous: result.previous} : {}),
      deleted: result.deleted === true,
    };
  }
}
