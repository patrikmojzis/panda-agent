import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../../lib/postgres-relations.js";

import {type PgQueryable} from "../../../lib/postgres-query.js";
import {buildChannelActionTableNames} from "./postgres-shared.js";

export async function ensurePostgresChannelActionSchema(pool: PgQueryable): Promise<void> {
  const tables = buildChannelActionTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.channelActions} (
      id UUID PRIMARY KEY,
      channel TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_channel_actions_pending_idx`)}
    ON ${tables.channelActions} (channel, connector_key, status, created_at, id)
  `);
}
