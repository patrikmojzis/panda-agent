import type {Pool} from "pg";

import {
  CREATE_RUNTIME_SCHEMA_SQL,
  quoteIdentifier,
  toMillis,
} from "../threads/runtime/postgres-shared.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildTelepathyTableNames, type TelepathyTableNames} from "./postgres-shared.js";
import type {TelepathyDeviceStore} from "./store.js";
import type {RegisterTelepathyDeviceInput, TelepathyDeviceRecord} from "./types.js";
import {normalizeTelepathyDeviceId, normalizeTelepathyLabel} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

export interface PostgresTelepathyDeviceStoreOptions {
  pool: PgQueryable;
}

function parseDeviceRow(row: Record<string, unknown>): TelepathyDeviceRecord {
  return {
    agentKey: String(row.agent_key),
    deviceId: String(row.device_id),
    label: row.label === null || row.label === undefined ? undefined : String(row.label),
    tokenHash: String(row.token_hash),
    enabled: row.disabled_at === null,
    connected: Boolean(row.connected),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
    connectedAt: row.connected_at === null || row.connected_at === undefined ? undefined : toMillis(row.connected_at),
    lastSeenAt: row.last_seen_at === null || row.last_seen_at === undefined ? undefined : toMillis(row.last_seen_at),
    lastDisconnectedAt: row.last_disconnected_at === null || row.last_disconnected_at === undefined
      ? undefined
      : toMillis(row.last_disconnected_at),
    disabledAt: row.disabled_at === null || row.disabled_at === undefined ? undefined : toMillis(row.disabled_at),
  };
}

function missingDeviceError(agentKey: string, deviceId: string): Error {
  return new Error(`Unknown telepathy device ${deviceId} for agent ${agentKey}. Register it first.`);
}

export class PostgresTelepathyDeviceStore implements TelepathyDeviceStore {
  private readonly pool: PgQueryable;
  private readonly tables: TelepathyTableNames;
  private readonly agentTables = buildAgentTableNames();

  constructor(options: PostgresTelepathyDeviceStoreOptions) {
    this.pool = options.pool;
    this.tables = buildTelepathyTableNames();
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.devices} (
        agent_key TEXT NOT NULL REFERENCES ${this.agentTables.agents}(agent_key) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        label TEXT,
        token_hash TEXT NOT NULL,
        connected BOOLEAN NOT NULL DEFAULT FALSE,
        connected_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        last_disconnected_at TIMESTAMPTZ,
        disabled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_key, device_id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_telepathy_devices_agent_idx`)}
      ON ${this.tables.devices} (agent_key, updated_at DESC)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_telepathy_devices_connected_idx`)}
      ON ${this.tables.devices} (connected, agent_key)
    `);
  }

  async clearConnectedStates(): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.tables.devices}
      SET
        connected = FALSE,
        last_disconnected_at = COALESCE(last_disconnected_at, NOW()),
        updated_at = NOW()
      WHERE connected = TRUE
    `);
  }

  async registerDevice(input: RegisterTelepathyDeviceInput): Promise<TelepathyDeviceRecord> {
    const agentKey = input.agentKey.trim();
    const deviceId = normalizeTelepathyDeviceId(input.deviceId);
    const label = normalizeTelepathyLabel(input.label);
    const tokenHash = input.tokenHash.trim();
    if (!agentKey) {
      throw new Error("Agent key must not be empty.");
    }
    if (!tokenHash) {
      throw new Error("Telepathy token hash must not be empty.");
    }

    const result = await this.pool.query(`
      INSERT INTO ${this.tables.devices} (
        agent_key,
        device_id,
        label,
        token_hash,
        connected,
        disabled_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        FALSE,
        NULL
      )
      ON CONFLICT (agent_key, device_id) DO UPDATE
      SET
        label = COALESCE(EXCLUDED.label, ${this.tables.devices}.label),
        token_hash = EXCLUDED.token_hash,
        disabled_at = NULL,
        updated_at = NOW()
      RETURNING *
    `, [
      agentKey,
      deviceId,
      label ?? null,
      tokenHash,
    ]);

    return parseDeviceRow(result.rows[0] as Record<string, unknown>);
  }

  async getDevice(agentKey: string, deviceId: string): Promise<TelepathyDeviceRecord> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.devices}
      WHERE agent_key = $1
        AND device_id = $2
      LIMIT 1
    `, [
      agentKey.trim(),
      normalizeTelepathyDeviceId(deviceId),
    ]);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw missingDeviceError(agentKey, deviceId);
    }

    return parseDeviceRow(row);
  }

  async listDevices(agentKey: string): Promise<readonly TelepathyDeviceRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.devices}
      WHERE agent_key = $1
      ORDER BY device_id ASC
    `, [agentKey.trim()]);

    return result.rows.map((row) => parseDeviceRow(row as Record<string, unknown>));
  }

  async setDeviceEnabled(agentKey: string, deviceId: string, enabled: boolean): Promise<TelepathyDeviceRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.devices}
      SET
        disabled_at = CASE WHEN $3::boolean THEN NULL ELSE NOW() END,
        connected = CASE WHEN $3::boolean THEN connected ELSE FALSE END,
        last_disconnected_at = CASE WHEN $3::boolean THEN last_disconnected_at ELSE NOW() END,
        updated_at = NOW()
      WHERE agent_key = $1
        AND device_id = $2
      RETURNING *
    `, [
      agentKey.trim(),
      normalizeTelepathyDeviceId(deviceId),
      enabled,
    ]);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw missingDeviceError(agentKey, deviceId);
    }

    return parseDeviceRow(row);
  }

  async markConnected(agentKey: string, deviceId: string, label?: string): Promise<TelepathyDeviceRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.devices}
      SET
        connected = TRUE,
        connected_at = NOW(),
        last_seen_at = NOW(),
        last_disconnected_at = NULL,
        label = COALESCE($3, label),
        updated_at = NOW()
      WHERE agent_key = $1
        AND device_id = $2
      RETURNING *
    `, [
      agentKey.trim(),
      normalizeTelepathyDeviceId(deviceId),
      normalizeTelepathyLabel(label) ?? null,
    ]);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw missingDeviceError(agentKey, deviceId);
    }

    return parseDeviceRow(row);
  }

  async touchLastSeen(agentKey: string, deviceId: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.tables.devices}
      SET
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE agent_key = $1
        AND device_id = $2
    `, [
      agentKey.trim(),
      normalizeTelepathyDeviceId(deviceId),
    ]);
  }

  async markDisconnected(agentKey: string, deviceId: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.tables.devices}
      SET
        connected = FALSE,
        last_disconnected_at = NOW(),
        updated_at = NOW()
      WHERE agent_key = $1
        AND device_id = $2
    `, [
      agentKey.trim(),
      normalizeTelepathyDeviceId(deviceId),
    ]);
  }
}
