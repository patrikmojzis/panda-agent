import type {PgQueryable} from "../../../lib/postgres-query.js";
import {quoteIdentifier} from "../../../lib/postgres-relations.js";
import {buildAgentTableNames} from "../postgres-shared.js";
import {ensurePostgresAgentTableSchema} from "../postgres-schema.js";
import {buildTelegramStickerTableNames} from "./postgres-shared.js";

export async function ensurePostgresTelegramStickerSchema(pool: PgQueryable): Promise<void> {
  await ensurePostgresAgentTableSchema(pool);
  const agents = buildAgentTableNames();
  const tables = buildTelegramStickerTableNames();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.stickers} (
      id UUID PRIMARY KEY,
      agent_key TEXT NOT NULL REFERENCES ${agents.agents}(agent_key) ON DELETE CASCADE,
      connector_key TEXT NOT NULL,
      file_id TEXT NOT NULL,
      file_unique_id TEXT NOT NULL,
      set_name TEXT,
      set_title TEXT,
      emoji TEXT,
      sticker_type TEXT NOT NULL,
      sticker_format TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      size_bytes BIGINT,
      tags TEXT[] NOT NULL DEFAULT '{}',
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_key, connector_key, file_unique_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier("runtime_agent_telegram_stickers_agent_idx")}
    ON ${tables.stickers} (agent_key, updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier("runtime_agent_telegram_stickers_tags_idx")}
    ON ${tables.stickers} USING GIN (tags)
  `);
}
