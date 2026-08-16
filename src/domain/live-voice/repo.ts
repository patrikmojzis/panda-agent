import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {buildRuntimeRelationNames, CREATE_RUNTIME_SCHEMA_SQL, postgresRelationExists, quoteIdentifier} from "../../lib/postgres-relations.js";
import type {PgListenClient, PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import {requireNonEmptyString, trimToUndefined} from "../../lib/strings.js";
import type {
  LiveVoiceHealthReason,
  LiveVoiceOperationalState,
  LiveVoiceSessionInput,
  LiveVoiceSessionRecord,
  LiveVoiceSessionState,
  LiveVoiceTurnInput,
  LiveVoiceTurnRecord,
  LiveVoiceTurnStatus,
} from "./types.js";

const tables = buildRuntimeRelationNames({sessions: "live_voice_sessions", turns: "live_voice_turns"});

const HEALTH_REASONS = new Set<LiveVoiceHealthReason>([
  "transport_not_ready",
  "provider_connecting",
  "provider_recovering",
  "provider_unavailable",
  "notification_listener_reconnecting",
  "postgres_pool_waiting",
  "audio_dropped",
  "playback_failed",
]);

function requiredString(value: unknown, label: string): string {
  return requireNonEmptyString(value, label);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? trimToUndefined(value) : undefined;
}

function parseJsonObject(value: unknown): JsonObject | undefined {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return isJsonObject(parsed) ? parsed : undefined;
}

function parseSessionState(value: unknown): LiveVoiceSessionState {
  if (value === "connecting" || value === "connected" || value === "disconnected" || value === "error") return value;
  throw new Error(`Unsupported live voice session state ${String(value)}.`);
}

function parseHealthState(value: unknown): LiveVoiceOperationalState | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "connecting" || value === "ready" || value === "degraded" || value === "recovering" || value === "error") return value;
  throw new Error(`Unsupported live voice health state ${String(value)}.`);
}

function parseHealthReasons(value: unknown): LiveVoiceHealthReason[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((reason): reason is LiveVoiceHealthReason => typeof reason === "string" && HEALTH_REASONS.has(reason as LiveVoiceHealthReason)).slice(0, 6);
}

function parseTurnStatus(value: unknown): LiveVoiceTurnStatus {
  if (value === "pending" || value === "queued" || value === "running" || value === "awaiting_final" || value === "final_sending" || value === "completed" || value === "failed") return value;
  throw new Error(`Unsupported live voice turn status ${String(value)}.`);
}

function parseSession(row: Record<string, unknown>): LiveVoiceSessionRecord {
  return {
    id: requiredString(row.id, "Live voice session id is missing."),
    source: requiredString(row.source, "Live voice source is missing."),
    connectorKey: requiredString(row.connector_key, "Live voice connector key is missing."),
    scopeKey: requiredString(row.scope_key, "Live voice scope key is missing."),
    roomKey: requiredString(row.room_key, "Live voice room key is missing."),
    sessionId: requiredString(row.session_id, "Live voice durable session id is missing."),
    agentKey: requiredString(row.agent_key, "Live voice agent key is missing."),
    provider: requiredString(row.provider, "Live voice provider is missing."),
    model: requiredString(row.model, "Live voice model is missing."),
    state: parseSessionState(row.state),
    transportContext: parseJsonObject(row.transport_context),
    lastError: optionalString(row.last_error),
    health: parseHealthState(row.health_state),
    healthReasons: parseHealthReasons(row.health_reasons),
    healthObservedAt: optionalTimestampMillis(row.health_observed_at, "Live voice health_observed_at is invalid."),
    diagnostics: parseJsonObject(row.diagnostics),
    startedAt: requireTimestampMillis(row.started_at, "Live voice session started_at is invalid."),
    updatedAt: requireTimestampMillis(row.updated_at, "Live voice session updated_at is invalid."),
  };
}

function parseTurn(row: Record<string, unknown>): LiveVoiceTurnRecord {
  return {
    id: requiredString(row.id, "Live voice turn id is missing."),
    liveVoiceSessionId: requiredString(row.live_voice_session_id, "Live voice parent session id is missing."),
    providerDelegationId: requiredString(row.provider_delegation_id, "Live voice provider delegation id is missing."),
    sourceUtteranceId: requiredString(row.source_utterance_id, "Live voice source utterance id is missing."),
    sessionId: requiredString(row.session_id, "Live voice durable session id is missing."),
    agentKey: requiredString(row.agent_key, "Live voice agent key is missing."),
    externalActorId: optionalString(row.external_actor_id),
    identityId: optionalString(row.identity_id),
    prompt: requiredString(row.prompt, "Live voice delegation prompt is missing."),
    status: parseTurnStatus(row.status),
    threadId: optionalString(row.thread_id),
    runId: optionalString(row.run_id),
    resultText: optionalString(row.result_text),
    finalControlId: optionalString(row.final_control_id),
    finalText: optionalString(row.final_text),
    error: optionalString(row.error),
    createdAt: requireTimestampMillis(row.created_at, "Live voice turn created_at is invalid."),
    updatedAt: requireTimestampMillis(row.updated_at, "Live voice turn updated_at is invalid."),
    completedAt: optionalTimestampMillis(row.completed_at, "Live voice turn completed_at is invalid."),
  };
}

export async function ensureLiveVoiceSchema(pool: PgQueryable): Promise<void> {
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessions} (
      id UUID PRIMARY KEY, source TEXT NOT NULL, connector_key TEXT NOT NULL,
      scope_key TEXT NOT NULL, room_key TEXT NOT NULL, session_id TEXT NOT NULL,
      agent_key TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
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

export interface LiveVoiceRepoOptions {pool: PgPoolLike<PgListenClient>}

/** Owns channel-neutral live-call ownership, health, and delegated turn state. */
export class LiveVoiceRepo {
  private readonly pool: PgPoolLike<PgListenClient>;

  constructor(options: LiveVoiceRepoOptions) { this.pool = options.pool; }

  ensureSchema(): Promise<void> { return ensureLiveVoiceSchema(this.pool); }

  /** Migrates the experimental Discord-only mailbox once, then removes its obsolete tables. */
  async hardCutLegacyDiscordTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const hasSessions = await postgresRelationExists(client, "runtime", "discord_voice_sessions");
      const hasTurns = await postgresRelationExists(client, "runtime", "discord_voice_turns");
      const hasRuntimeRequests = await postgresRelationExists(client, "runtime", "runtime_requests");
      if (hasRuntimeRequests) await client.query("DELETE FROM runtime.runtime_requests WHERE kind='discord_voice_delegation'");
      if (hasSessions) {
        await client.query(`
          INSERT INTO ${tables.sessions} (id,source,connector_key,scope_key,room_key,session_id,agent_key,provider,model,state,transport_context,last_error,started_at,updated_at)
          SELECT voice_session_id,'discord',connector_key,guild_id,channel_id,session_id,agent_key,'openai-live',model,'disconnected',
            '{}'::jsonb,COALESCE(last_error,'legacy_schema_migrated'),started_at,updated_at
          FROM runtime.discord_voice_sessions ON CONFLICT (id) DO NOTHING
        `);
      }
      if (hasTurns) {
        // The original experimental table predates utterance attribution and
        // explicit final delivery. Normalize every shipped variant before the
        // one-way copy so a skipped intermediate deploy cannot block startup.
        await client.query("ALTER TABLE runtime.discord_voice_turns ADD COLUMN IF NOT EXISTS source_utterance_id UUID");
        await client.query("ALTER TABLE runtime.discord_voice_turns ADD COLUMN IF NOT EXISTS final_control_id UUID");
        await client.query("ALTER TABLE runtime.discord_voice_turns ADD COLUMN IF NOT EXISTS final_text TEXT");
        await client.query(`
          INSERT INTO ${tables.sessions} (id,source,connector_key,scope_key,room_key,session_id,agent_key,provider,model,state,transport_context,last_error,started_at,updated_at)
          SELECT DISTINCT ON (legacy.voice_session_id) legacy.voice_session_id,'discord',legacy.connector_key,legacy.guild_id,legacy.channel_id,
            legacy.session_id,legacy.agent_key,'openai-live','gpt-live-1-codex','disconnected',
            '{}'::jsonb,'legacy_schema_migrated',legacy.created_at,legacy.updated_at
          FROM runtime.discord_voice_turns AS legacy
          ORDER BY legacy.voice_session_id,legacy.created_at
          ON CONFLICT (id) DO NOTHING
        `);
        await client.query(`
          INSERT INTO ${tables.turns} (id,live_voice_session_id,provider_delegation_id,source_utterance_id,session_id,agent_key,external_actor_id,identity_id,prompt,status,thread_id,run_id,result_text,final_control_id,final_text,error,completed_at,created_at,updated_at)
          SELECT id,voice_session_id,delegation_id || CASE WHEN source_utterance_id IS NULL THEN ':' || id::text ELSE '' END,COALESCE(source_utterance_id,id),session_id,agent_key,external_actor_id,identity_id,prompt,
            CASE WHEN status IN ('completed','failed') THEN status ELSE 'failed' END,thread_id,run_id,result_text,final_control_id,final_text,
            CASE WHEN status IN ('completed','failed') THEN error ELSE COALESCE(error,'Live voice turn interrupted by schema migration.') END,
            CASE WHEN status IN ('completed','failed') THEN completed_at ELSE NOW() END,created_at,updated_at
          FROM runtime.discord_voice_turns ON CONFLICT DO NOTHING
        `);
        await client.query("DROP TABLE runtime.discord_voice_turns");
      }
      if (hasSessions) await client.query("DROP TABLE runtime.discord_voice_sessions");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async upsertSession(input: LiveVoiceSessionInput): Promise<LiveVoiceSessionRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${tables.sessions} (id,source,connector_key,scope_key,room_key,session_id,agent_key,provider,model,state,transport_context,last_error,health_state,health_reasons,health_observed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,$15)
      ON CONFLICT (id) DO UPDATE SET room_key=EXCLUDED.room_key,session_id=EXCLUDED.session_id,agent_key=EXCLUDED.agent_key,provider=EXCLUDED.provider,model=EXCLUDED.model,state=EXCLUDED.state,transport_context=EXCLUDED.transport_context,last_error=EXCLUDED.last_error,health_state=EXCLUDED.health_state,health_reasons=EXCLUDED.health_reasons,health_observed_at=EXCLUDED.health_observed_at,updated_at=NOW()
      RETURNING *
    `, [input.id,input.source,input.connectorKey,input.scopeKey,input.roomKey,input.sessionId,input.agentKey,input.provider,input.model,input.state,input.transportContext ? JSON.stringify(input.transportContext) : null,input.lastError ?? null,input.health ?? null,JSON.stringify(input.healthReasons ?? []),input.healthObservedAt ? new Date(input.healthObservedAt) : null]);
    return parseSession(result.rows[0] as Record<string, unknown>);
  }

  async updateSessionHealth(input: {id: string; health: LiveVoiceOperationalState; reasons: readonly LiveVoiceHealthReason[]; observedAt: number; diagnostics?: unknown}): Promise<void> {
    await this.pool.query(`UPDATE ${tables.sessions} SET health_state=$2,health_reasons=$3::jsonb,health_observed_at=$4,diagnostics=$5::jsonb,updated_at=NOW() WHERE id=$1`, [input.id,input.health,JSON.stringify(input.reasons.slice(0,6)),new Date(input.observedAt),input.diagnostics ? JSON.stringify(input.diagnostics) : null]);
  }

  async getSession(id: string): Promise<LiveVoiceSessionRecord> {
    const result = await this.pool.query(`SELECT * FROM ${tables.sessions} WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new Error(`Unknown live voice session ${id}.`);
    return parseSession(result.rows[0] as Record<string, unknown>);
  }

  async listSessions(filter: {sessionId?: string; source?: string; connectorKey?: string; activeOnly?: boolean} = {}): Promise<readonly LiveVoiceSessionRecord[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    for (const [column, value] of [["session_id", filter.sessionId], ["source", filter.source], ["connector_key", filter.connectorKey]] as const) {
      if (value) { values.push(value); clauses.push(`${column}=$${String(values.length)}`); }
    }
    if (filter.activeOnly ?? false) clauses.push("state IN ('connecting','connected')");
    const result = await this.pool.query(`SELECT * FROM ${tables.sessions}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY started_at`, values);
    return result.rows.map((row) => parseSession(row as Record<string, unknown>));
  }

  async markSessionDisconnected(id: string, state: "disconnected" | "error", error?: string): Promise<void> {
    await this.pool.query(`UPDATE ${tables.sessions} SET state=$2,last_error=$3,updated_at=NOW() WHERE id=$1`, [id,state,error ?? null]);
  }

  async markConnectorSessionsDisconnected(source: string, connectorKey: string, error: string): Promise<number> {
    const result = await this.pool.query(`UPDATE ${tables.sessions} SET state='disconnected',last_error=$3,updated_at=NOW() WHERE source=$1 AND connector_key=$2 AND state IN ('connecting','connected')`, [source,connectorKey,error]);
    return result.rowCount ?? 0;
  }

  async createOrGetTurn(input: LiveVoiceTurnInput): Promise<{turn: LiveVoiceTurnRecord; created: boolean}> {
    const result = await this.pool.query(`
      INSERT INTO ${tables.turns} (id,live_voice_session_id,provider_delegation_id,source_utterance_id,session_id,agent_key,external_actor_id,identity_id,prompt,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') ON CONFLICT DO NOTHING RETURNING *
    `, [input.id,input.liveVoiceSessionId,input.providerDelegationId,input.sourceUtteranceId,input.sessionId,input.agentKey,input.externalActorId ?? null,input.identityId ?? null,input.prompt]);
    if (result.rows[0]) return {turn: parseTurn(result.rows[0] as Record<string, unknown>), created: true};
    const existing = await this.pool.query(`SELECT * FROM ${tables.turns} WHERE live_voice_session_id=$1 AND (source_utterance_id=$2 OR provider_delegation_id=$3) ORDER BY created_at LIMIT 1`, [input.liveVoiceSessionId,input.sourceUtteranceId,input.providerDelegationId]);
    if (!existing.rows[0]) throw new Error("Live voice turn conflict could not be resolved.");
    return {turn: parseTurn(existing.rows[0] as Record<string, unknown>), created: false};
  }

  async getTurn(id: string): Promise<LiveVoiceTurnRecord> {
    const result = await this.pool.query(`SELECT * FROM ${tables.turns} WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new Error(`Unknown live voice turn ${id}.`);
    return parseTurn(result.rows[0] as Record<string, unknown>);
  }

  async markTurnQueued(id: string, threadId: string): Promise<LiveVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='queued',thread_id=$2,updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id,threadId]);
    return result.rows[0] ? parseTurn(result.rows[0] as Record<string, unknown>) : this.getTurn(id);
  }

  async assignTurnsToRun(turnIds: readonly string[], runId: string): Promise<void> {
    if (turnIds.length === 0) return;
    const placeholders = turnIds.map((_, index) => `$${String(index + 2)}`).join(",");
    await this.pool.query(`UPDATE ${tables.turns} SET status='running',run_id=$1,updated_at=NOW() WHERE id IN (${placeholders}) AND status IN ('pending','queued')`, [runId,...turnIds]);
  }

  async markTurnsAwaitingFinal(runId: string): Promise<void> {
    await this.pool.query(`UPDATE ${tables.turns} SET status='awaiting_final',updated_at=NOW() WHERE run_id=$1 AND status='running'`, [runId]);
  }

  async listRunningTurns(runId: string): Promise<readonly LiveVoiceTurnRecord[]> {
    const result = await this.pool.query(`SELECT * FROM ${tables.turns} WHERE run_id=$1 AND status='running' ORDER BY created_at`, [runId]);
    return result.rows.map((row) => parseTurn(row as Record<string, unknown>));
  }

  async completeTurn(id: string, text: string): Promise<LiveVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='completed',result_text=$2,error=NULL,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('pending','queued','running','awaiting_final') RETURNING *`, [id,text]);
    return result.rows[0] ? parseTurn(result.rows[0] as Record<string, unknown>) : this.getTurn(id);
  }

  async reserveFinalDelivery(id: string, controlId: string, text: string): Promise<{turn: LiveVoiceTurnRecord; reserved: boolean}> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='final_sending',final_control_id=$2,final_text=$3,updated_at=NOW() WHERE id=$1 AND status IN ('pending','queued','running','awaiting_final') RETURNING *`, [id,controlId,text]);
    return result.rows[0] ? {turn: parseTurn(result.rows[0] as Record<string, unknown>), reserved: true} : {turn: await this.getTurn(id), reserved: false};
  }

  async releaseFinalDelivery(id: string, controlId: string): Promise<LiveVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='awaiting_final',final_control_id=NULL,final_text=NULL,updated_at=NOW() WHERE id=$1 AND status='final_sending' AND final_control_id=$2 RETURNING *`, [id,controlId]);
    return result.rows[0] ? parseTurn(result.rows[0] as Record<string, unknown>) : this.getTurn(id);
  }

  async completeReservedFinal(id: string, controlId: string): Promise<LiveVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='completed',result_text=final_text,error=NULL,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='final_sending' AND final_control_id=$2 RETURNING *`, [id,controlId]);
    return result.rows[0] ? parseTurn(result.rows[0] as Record<string, unknown>) : this.getTurn(id);
  }

  async failTurn(id: string, error: string): Promise<LiveVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='failed',error=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed') RETURNING *`, [id,error.slice(0,1000)]);
    return result.rows[0] ? parseTurn(result.rows[0] as Record<string, unknown>) : this.getTurn(id);
  }

  async failConnectorActiveTurns(source: string, connectorKey: string, error: string): Promise<number> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='failed',error=$3,completed_at=NOW(),updated_at=NOW() WHERE live_voice_session_id IN (SELECT id FROM ${tables.sessions} WHERE source=$1 AND connector_key=$2) AND status NOT IN ('completed','failed')`, [source,connectorKey,error.slice(0,1000)]);
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    // This repository owns no long-lived clients.
  }
}
