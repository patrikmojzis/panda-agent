import type {Pool} from "pg";

import {CREATE_RUNTIME_SCHEMA_SQL, toMillis} from "../../../domain/threads/runtime/postgres-shared.js";
import {buildDaemonStateTableNames, type DaemonStateTableNames} from "./postgres-shared.js";
import type {DaemonStateRecord} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

export interface DaemonStateRepoOptions {
  pool: PgQueryable;
}

function parseRow(row: Record<string, unknown>): DaemonStateRecord {
  return {
    daemonKey: String(row.daemon_key),
    heartbeatAt: toMillis(row.heartbeat_at),
    startedAt: toMillis(row.started_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export class DaemonStateRepo {
  private readonly pool: PgQueryable;
  private readonly tables: DaemonStateTableNames;

  constructor(options: DaemonStateRepoOptions) {
    this.pool = options.pool;
    this.tables = buildDaemonStateTableNames();
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.daemonState} (
        daemon_key TEXT PRIMARY KEY,
        heartbeat_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async heartbeat(daemonKey: string): Promise<DaemonStateRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.daemonState} (
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
    `, [daemonKey.trim()]);
    return parseRow(result.rows[0] as Record<string, unknown>);
  }

  async readState(daemonKey: string): Promise<DaemonStateRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.daemonState}
      WHERE daemon_key = $1
    `, [daemonKey.trim()]);
    const row = result.rows[0];
    return row ? parseRow(row as Record<string, unknown>) : null;
  }
}
