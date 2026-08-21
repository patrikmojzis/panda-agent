import type {PgPoolLike} from "../../../lib/postgres-query.js";
import {requireTimestampMillis} from "../../../lib/postgres-values.js";
import {requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {buildWhatsAppAuthTableNames, ensurePostgresWhatsAppAuthSchema} from "./auth-schema.js";
import type {WhatsAppSocketHealthState} from "./health.js";

export type WhatsAppRuntimeSocketState = WhatsAppSocketHealthState | "error";

export interface WhatsAppRuntimeStatusRecord {
  accountId: string;
  socketState: WhatsAppRuntimeSocketState;
  lastError?: string;
  heartbeatAt: number;
  updatedAt: number;
}

function parseRuntimeStatus(row: Record<string, unknown>): WhatsAppRuntimeStatusRecord {
  const socketState = requireNonEmptyString(row.socket_state, "WhatsApp runtime socket state is missing.") as WhatsAppRuntimeSocketState;
  return {
    accountId: requireNonEmptyString(row.account_id, "WhatsApp runtime account id is missing."),
    socketState,
    ...(typeof row.last_error === "string" && row.last_error.trim() ? {lastError: row.last_error.trim()} : {}),
    heartbeatAt: requireTimestampMillis(row.heartbeat_at, "WhatsApp runtime heartbeat_at must be valid."),
    updatedAt: requireTimestampMillis(row.updated_at, "WhatsApp runtime updated_at must be valid."),
  };
}

export class PostgresWhatsAppRuntimeStatusStore {
  private readonly pool: PgPoolLike;
  private readonly tables = buildWhatsAppAuthTableNames();

  constructor(options: {pool: PgPoolLike}) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresWhatsAppAuthSchema(this.pool);
  }

  async setStatus(
    accountId: string,
    socketState: WhatsAppRuntimeSocketState,
    lastError?: string,
  ): Promise<WhatsAppRuntimeStatusRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.runtimeStatus} (account_id, socket_state, last_error)
      VALUES ($1, $2, $3)
      ON CONFLICT (account_id)
      DO UPDATE SET
        socket_state = EXCLUDED.socket_state,
        last_error = EXCLUDED.last_error,
        heartbeat_at = NOW(),
        updated_at = NOW()
      RETURNING account_id::text AS account_id, socket_state, last_error, heartbeat_at, updated_at
    `, [
      requireNonEmptyString(accountId, "WhatsApp runtime account id is required."),
      socketState,
      trimToUndefined(lastError) ?? null,
    ]);
    return parseRuntimeStatus(result.rows[0] as Record<string, unknown>);
  }

  async heartbeat(accountId: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.tables.runtimeStatus}
      SET heartbeat_at = NOW(), updated_at = NOW()
      WHERE account_id = $1
    `, [requireNonEmptyString(accountId, "WhatsApp runtime account id is required.")]);
  }

  async getStatus(accountId: string): Promise<WhatsAppRuntimeStatusRecord | null> {
    const result = await this.pool.query(`
      SELECT account_id::text AS account_id, socket_state, last_error, heartbeat_at, updated_at
      FROM ${this.tables.runtimeStatus}
      WHERE account_id = $1
      LIMIT 1
    `, [requireNonEmptyString(accountId, "WhatsApp runtime account id is required.")]);
    const row = result.rows[0];
    return row ? parseRuntimeStatus(row as Record<string, unknown>) : null;
  }
}
