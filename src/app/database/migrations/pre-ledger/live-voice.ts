import {
  buildRuntimeRelationNames,
  CREATE_RUNTIME_SCHEMA_SQL,
  postgresRelationExists,
  quoteIdentifier,
} from "../../../../lib/postgres-relations.js";
import type {PgQueryable} from "../../../../lib/postgres-query.js";

const tables = buildRuntimeRelationNames({sessions: "live_voice_sessions", turns: "live_voice_turns"});

/** Frozen channel-neutral live-voice DDL absorbed by the pre-ledger baseline. */
export async function installPreLedgerLiveVoiceSchema(pool: PgQueryable): Promise<void> {
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessions} (
      id UUID PRIMARY KEY, source TEXT NOT NULL, connector_key TEXT NOT NULL,
      scope_key TEXT NOT NULL, room_key TEXT NOT NULL, session_id TEXT NOT NULL,
      agent_key TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, voice TEXT,
      state TEXT NOT NULL, transport_context JSONB, last_error TEXT,
      health_state TEXT, health_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
      health_observed_at TIMESTAMPTZ, diagnostics JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_live_voice_sessions_active_scope_idx`)} ON ${tables.sessions} (source,connector_key,scope_key) WHERE state IN ('connecting','connected')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_live_voice_sessions_owner_idx`)} ON ${tables.sessions} (session_id,source,connector_key,state)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.turns} (
      id UUID PRIMARY KEY, live_voice_session_id UUID NOT NULL REFERENCES ${tables.sessions}(id),
      provider_delegation_id TEXT NOT NULL, source_utterance_id UUID NOT NULL,
      session_id TEXT NOT NULL, agent_key TEXT NOT NULL, external_actor_id TEXT, identity_id TEXT,
      prompt TEXT NOT NULL, status TEXT NOT NULL, thread_id UUID, run_id UUID,
      result_text TEXT, final_control_id UUID, final_text TEXT, error TEXT, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (live_voice_session_id, provider_delegation_id),
      UNIQUE (live_voice_session_id, source_utterance_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_live_voice_turns_run_idx`)} ON ${tables.turns} (run_id,status)`);
}

/** Frozen one-way cutover from the removed Discord-specific live-voice tables. */
export async function migratePreLedgerDiscordVoiceSchema(queryable: PgQueryable): Promise<void> {
  const hasSessions = await postgresRelationExists(queryable, "runtime", "discord_voice_sessions");
  const hasTurns = await postgresRelationExists(queryable, "runtime", "discord_voice_turns");
  const hasRuntimeRequests = await postgresRelationExists(queryable, "runtime", "runtime_requests");
  if (hasRuntimeRequests) await queryable.query("DELETE FROM runtime.runtime_requests WHERE kind='discord_voice_delegation'");
  if (hasSessions) {
    await queryable.query(`
      INSERT INTO ${tables.sessions} (id,source,connector_key,scope_key,room_key,session_id,agent_key,provider,model,state,transport_context,last_error,started_at,updated_at)
      SELECT voice_session_id,'discord',connector_key,guild_id,channel_id,session_id,agent_key,'openai-live',model,'disconnected',
        '{}'::jsonb,COALESCE(last_error,'legacy_schema_migrated'),started_at,updated_at
      FROM runtime.discord_voice_sessions ON CONFLICT (id) DO NOTHING
    `);
  }
  if (hasTurns) {
    await queryable.query("ALTER TABLE runtime.discord_voice_turns ADD COLUMN IF NOT EXISTS source_utterance_id UUID");
    await queryable.query("ALTER TABLE runtime.discord_voice_turns ADD COLUMN IF NOT EXISTS final_control_id UUID");
    await queryable.query("ALTER TABLE runtime.discord_voice_turns ADD COLUMN IF NOT EXISTS final_text TEXT");
    await queryable.query(`
      INSERT INTO ${tables.sessions} (id,source,connector_key,scope_key,room_key,session_id,agent_key,provider,model,state,transport_context,last_error,started_at,updated_at)
      SELECT DISTINCT ON (legacy.voice_session_id) legacy.voice_session_id,'discord',legacy.connector_key,legacy.guild_id,legacy.channel_id,
        legacy.session_id,legacy.agent_key,'openai-live','gpt-live-1-codex','disconnected',
        '{}'::jsonb,'legacy_schema_migrated',legacy.created_at,legacy.updated_at
      FROM runtime.discord_voice_turns AS legacy
      ORDER BY legacy.voice_session_id,legacy.created_at
      ON CONFLICT (id) DO NOTHING
    `);
    await queryable.query(`
      INSERT INTO ${tables.turns} (id,live_voice_session_id,provider_delegation_id,source_utterance_id,session_id,agent_key,external_actor_id,identity_id,prompt,status,thread_id,run_id,result_text,final_control_id,final_text,error,completed_at,created_at,updated_at)
      SELECT id,voice_session_id,delegation_id || CASE WHEN source_utterance_id IS NULL THEN ':' || id::text ELSE '' END,COALESCE(source_utterance_id,id),session_id,agent_key,external_actor_id,identity_id,prompt,
        CASE WHEN status IN ('completed','failed') THEN status ELSE 'failed' END,thread_id,run_id,result_text,final_control_id,final_text,
        CASE WHEN status IN ('completed','failed') THEN error ELSE COALESCE(error,'Live voice turn interrupted by schema migration.') END,
        CASE WHEN status IN ('completed','failed') THEN completed_at ELSE NOW() END,created_at,updated_at
      FROM runtime.discord_voice_turns ON CONFLICT DO NOTHING
    `);
    await queryable.query("DROP TABLE runtime.discord_voice_turns");
  }
  if (hasSessions) await queryable.query("DROP TABLE runtime.discord_voice_sessions");
}
