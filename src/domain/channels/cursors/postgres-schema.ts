import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../../lib/postgres-relations.js";

import {type PgQueryable} from "../../../lib/postgres-query.js";
import {buildChannelCursorTableNames} from "./postgres-shared.js";

export async function ensurePostgresChannelCursorSchema(pool: PgQueryable): Promise<void> {
  const tables = buildChannelCursorTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.channelCursors} (
      source TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      cursor_key TEXT NOT NULL,
      cursor_value TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, connector_key, cursor_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_channel_cursors_updated_idx`)}
    ON ${tables.channelCursors} (updated_at DESC)
  `);
}
