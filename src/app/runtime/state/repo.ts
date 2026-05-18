import type {PgQueryable} from "../../../lib/postgres-query.js";
import {requireTimestampMillis} from "../../../lib/postgres-values.js";
import {requireNonEmptyString} from "../../../lib/strings.js";
import {buildRuntimeRelationNames, CREATE_RUNTIME_SCHEMA_SQL} from "../../../lib/postgres-relations.js";

export interface DaemonStateRepoOptions {
  pool: PgQueryable;
}

export interface DaemonStateRecord {
  daemonKey: string;
  heartbeatAt: number;
  startedAt: number;
  updatedAt: number;
}

function parseRow(row: Record<string, unknown>): DaemonStateRecord {
  return {
    daemonKey: requireNonEmptyString(row.daemon_key, "Daemon key must not be empty."),
    heartbeatAt: requireTimestampMillis(row.heartbeat_at, "Daemon state heartbeat_at must be a valid timestamp."),
    startedAt: requireTimestampMillis(row.started_at, "Daemon state started_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Daemon state updated_at must be a valid timestamp."),
  };
}

function normalizeDaemonKey(value: string): string {
  return requireNonEmptyString(value, "Daemon key must not be empty.");
}

export class DaemonStateRepo {
  private readonly pool: PgQueryable;
  private readonly daemonStateTable: string;

  constructor(options: DaemonStateRepoOptions) {
    this.pool = options.pool;
    this.daemonStateTable = buildRuntimeRelationNames({
      daemonState: "daemon_state",
    }).daemonState;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.daemonStateTable} (
        daemon_key TEXT PRIMARY KEY,
        heartbeat_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async heartbeat(daemonKey: string): Promise<DaemonStateRecord> {
    const normalizedDaemonKey = normalizeDaemonKey(daemonKey);
    const result = await this.pool.query(`
      INSERT INTO ${this.daemonStateTable} (
        daemon_key,
        heartbeat_at,
        started_at
      ) VALUES (
        $1,
        NOW(),
        NOW()
      )
      ON CONFLICT (daemon_key)
      DO UPDATE SET
        heartbeat_at = NOW(),
        updated_at = NOW()
      RETURNING *
    `, [normalizedDaemonKey]);
    return parseRow(result.rows[0] as Record<string, unknown>);
  }

  async readState(daemonKey: string): Promise<DaemonStateRecord | null> {
    const normalizedDaemonKey = normalizeDaemonKey(daemonKey);
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.daemonStateTable}
      WHERE daemon_key = $1
    `, [normalizedDaemonKey]);
    const row = result.rows[0];
    return row ? parseRow(row as Record<string, unknown>) : null;
  }
}
