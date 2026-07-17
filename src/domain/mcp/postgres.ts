import type {PgClientLike, PgPoolLike} from "../../lib/postgres-query.js";
import {requireTimestampMillis, toJson} from "../../lib/postgres-values.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {normalizeMcpConfig, normalizeMcpServerConfig} from "./config.js";
import {ensurePostgresMcpSchema} from "./postgres-schema.js";
import {buildMcpTableNames} from "./postgres-shared.js";
import type {McpConfigStore} from "./store.js";
import type {McpAgentConfig, McpAgentConfigRecord, McpServerConfig} from "./types.js";

function parseRecord(row: Record<string, unknown>): McpAgentConfigRecord {
  return {
    agentKey: requireNonEmptyString(row.agent_key, "MCP config row is missing agent_key."),
    config: normalizeMcpConfig(row.config),
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
      SELECT agent_key, config, created_at, updated_at
      FROM ${this.tables.configs}
      WHERE agent_key = $1
    `, [normalizedAgentKey]);
    const row = result.rows[0];
    return row
      ? parseRecord(row as Record<string, unknown>)
      : {agentKey: normalizedAgentKey, config: {servers: {}}};
  }

  private async mutate(
    agentKey: string,
    update: (config: McpAgentConfig) => {config: McpAgentConfig; deleted?: boolean},
  ): Promise<{record: McpAgentConfigRecord; deleted?: boolean}> {
    const normalizedAgentKey = requireNonEmptyString(agentKey, "MCP config agent key is required.");
    return withTransaction(this.pool, async (client) => {
      await this.lockAgent(client, normalizedAgentKey);
      const current = await client.query(`
        SELECT agent_key, config, created_at, updated_at
        FROM ${this.tables.configs}
        WHERE agent_key = $1
        FOR UPDATE
      `, [normalizedAgentKey]);
      const config = current.rows[0]
        ? parseRecord(current.rows[0] as Record<string, unknown>).config
        : {servers: {}};
      const next = update(config);
      const persisted = await client.query(`
        INSERT INTO ${this.tables.configs} (agent_key, config)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (agent_key) DO UPDATE
        SET config = EXCLUDED.config, updated_at = NOW()
        RETURNING agent_key, config, created_at, updated_at
      `, [normalizedAgentKey, toJson(normalizeMcpConfig(next.config))]);
      return {
        record: parseRecord(persisted.rows[0] as Record<string, unknown>),
        ...(next.deleted === undefined ? {} : {deleted: next.deleted}),
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

  async putServer(agentKey: string, serverName: string, input: unknown): Promise<McpAgentConfigRecord> {
    const server = normalizeMcpServerConfig(serverName, input);
    const result = await this.mutate(agentKey, (current) => ({
      config: normalizeMcpConfig({
        servers: {...current.servers, [serverName]: server},
      }),
    }));
    return result.record;
  }

  async deleteServer(agentKey: string, serverName: string): Promise<{record: McpAgentConfigRecord; deleted: boolean}> {
    const result = await this.mutate(agentKey, (current) => {
      const deleted = Object.hasOwn(current.servers, serverName);
      const servers: Record<string, McpServerConfig> = {...current.servers};
      delete servers[serverName];
      return {config: normalizeMcpConfig({servers}), deleted};
    });
    return {record: result.record, deleted: result.deleted === true};
  }
}
