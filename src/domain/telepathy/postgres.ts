import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireBoolean} from "../../lib/booleans.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import {requireTrimmedString} from "../../lib/strings.js";
import {ensurePostgresTelepathyDeviceSchema} from "./postgres-schema.js";
import {buildTelepathyTableNames, type TelepathyTableNames} from "./postgres-shared.js";
import type {RegisterTelepathyDeviceInput, TelepathyDeviceRecord} from "./types.js";
import {normalizeTelepathyDeviceId, normalizeTelepathyLabel} from "./types.js";

interface PostgresTelepathyDeviceStoreOptions {
  pool: PgQueryable;
}

function requireTrimmed(value: unknown, field: string): string {
  return requireTrimmedString(
    value,
    `Telepathy device ${field} must be a string.`,
    `Telepathy device ${field} must not be empty.`,
  );
}

function parseDeviceRow(row: Record<string, unknown>): TelepathyDeviceRecord {
  const disabledAt = optionalTimestampMillis(row.disabled_at, "Telepathy device disabled_at must be a finite timestamp.");
  return {
    agentKey: requireTrimmed(row.agent_key, "agent key"),
    deviceId: normalizeTelepathyDeviceId(requireTrimmed(row.device_id, "device id")),
    label: normalizeTelepathyLabel(row.label === null || row.label === undefined ? undefined : requireTrimmed(row.label, "label")),
    tokenHash: requireTrimmed(row.token_hash, "token hash"),
    enabled: disabledAt === undefined,
    connected: requireBoolean(row.connected, "Telepathy device connected state must be a boolean."),
    createdAt: requireTimestampMillis(row.created_at, "Telepathy device created_at must be a finite timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Telepathy device updated_at must be a finite timestamp."),
    connectedAt: optionalTimestampMillis(row.connected_at, "Telepathy device connected_at must be a finite timestamp."),
    lastSeenAt: optionalTimestampMillis(row.last_seen_at, "Telepathy device last_seen_at must be a finite timestamp."),
    lastDisconnectedAt: optionalTimestampMillis(row.last_disconnected_at, "Telepathy device last_disconnected_at must be a finite timestamp."),
    disabledAt,
  };
}

function missingDeviceError(agentKey: string, deviceId: string): Error {
  return new Error(`Unknown telepathy device ${deviceId} for agent ${agentKey}. Register it first.`);
}

export class PostgresTelepathyDeviceStore {
  private readonly pool: PgQueryable;
  private readonly tables: TelepathyTableNames;

  constructor(options: PostgresTelepathyDeviceStoreOptions) {
    this.pool = options.pool;
    this.tables = buildTelepathyTableNames();
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresTelepathyDeviceSchema(this.pool);
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
    const agentKey = requireTrimmed(input.agentKey, "agent key");
    const deviceId = normalizeTelepathyDeviceId(input.deviceId);
    const label = normalizeTelepathyLabel(input.label);
    const tokenHash = requireTrimmed(input.tokenHash, "token hash");

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
      requireTrimmed(agentKey, "agent key"),
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
    `, [requireTrimmed(agentKey, "agent key")]);

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
      requireTrimmed(agentKey, "agent key"),
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
      requireTrimmed(agentKey, "agent key"),
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
      requireTrimmed(agentKey, "agent key"),
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
      requireTrimmed(agentKey, "agent key"),
      normalizeTelepathyDeviceId(deviceId),
    ]);
  }
}
