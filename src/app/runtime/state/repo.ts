import type {Pool} from "pg";

import {toMillis} from "../../../domain/threads/runtime/postgres-shared.js";
import {buildPandaDaemonStateTableNames, type PandaDaemonStateTableNames} from "./postgres-shared.js";
import type {PandaDaemonStateRecord} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

export interface PandaDaemonStateRepoOptions {
  pool: PgQueryable;
  tablePrefix?: string;
}

function parseRow(row: Record<string, unknown>): PandaDaemonStateRecord {
  return {
    daemonKey: String(row.daemon_key),
    heartbeatAt: toMillis(row.heartbeat_at),
    startedAt: toMillis(row.started_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export class PandaDaemonStateRepo {
  private readonly pool: PgQueryable;
  private readonly tables: PandaDaemonStateTableNames;

  constructor(options: PandaDaemonStateRepoOptions) {
    this.pool = options.pool;
    this.tables = buildPandaDaemonStateTableNames(options.tablePrefix ?? "thread_runtime");
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.daemonState} (
        daemon_key TEXT PRIMARY KEY,
        heartbeat_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async heartbeat(daemonKey: string): Promise<PandaDaemonStateRecord> {
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

  async readState(daemonKey: string): Promise<PandaDaemonStateRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.daemonState}
      WHERE daemon_key = $1
    `, [daemonKey.trim()]);
    const row = result.rows[0];
    return row ? parseRow(row as Record<string, unknown>) : null;
  }
}
