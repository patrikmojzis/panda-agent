import {buildRuntimeRelationNames, CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier} from "../../../../lib/postgres-relations.js";
import type {PgQueryable} from "../../../../lib/postgres-query.js";

const tables = buildRuntimeRelationNames({controls: "discord_voice_controls"});

/** Frozen Discord voice-control DDL absorbed by the pre-ledger baseline. */
export async function installPreLedgerDiscordVoiceControlSchema(pool: PgQueryable): Promise<void> {
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.controls} (
      id UUID PRIMARY KEY, connector_key TEXT NOT NULL, operation TEXT NOT NULL,
      session_id TEXT NOT NULL, agent_key TEXT NOT NULL, channel_id TEXT,
      text TEXT, mode TEXT, voice_turn_id UUID, idempotency_key TEXT,
      status TEXT NOT NULL, result JSONB, error TEXT, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ${tables.controls} ADD COLUMN IF NOT EXISTS text TEXT`);
  await pool.query(`ALTER TABLE ${tables.controls} ADD COLUMN IF NOT EXISTS mode TEXT`);
  await pool.query(`ALTER TABLE ${tables.controls} ADD COLUMN IF NOT EXISTS voice_turn_id UUID`);
  await pool.query(`ALTER TABLE ${tables.controls} ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_controls_pending_idx`)} ON ${tables.controls} (connector_key,status,created_at,id)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_controls_idempotency_idx`)} ON ${tables.controls} (idempotency_key)`);
}
