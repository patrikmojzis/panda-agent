import {randomUUID} from "node:crypto";

import {isJsonObject, type JsonObject} from "../../../lib/json.js";
import {buildRuntimeRelationNames, CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier} from "../../../lib/postgres-relations.js";
import type {PgListenClient, PgPoolLike, PgQueryable} from "../../../lib/postgres-query.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../../lib/postgres-values.js";
import {requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {
  DISCORD_VOICE_MODEL,
  type DiscordVoiceControlInput,
  type DiscordVoiceControlNotification,
  type DiscordVoiceControlRecord,
  type DiscordVoiceSendMode,
  type DiscordVoiceControlStatus,
  type DiscordVoiceNotification,
  type DiscordVoiceSessionRecord,
  type DiscordVoiceSessionState,
  type DiscordVoiceTurnInput,
  type DiscordVoiceTurnRecord,
  type DiscordVoiceTurnStatus,
} from "./voice-types.js";
import type {DiscordVoiceHealthReason, DiscordVoiceOperationalState} from "./voice-health.js";

export const DISCORD_VOICE_NOTIFICATION_CHANNEL = "runtime_discord_voice_events";

const tables = buildRuntimeRelationNames({
  controls: "discord_voice_controls",
  sessions: "discord_voice_sessions",
  turns: "discord_voice_turns",
});

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? trimToUndefined(value) : undefined;
}

function requiredString(value: unknown, label: string): string {
  return requireNonEmptyString(value, label);
}

function parseJsonObject(value: unknown): JsonObject | undefined {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return isJsonObject(parsed) ? parsed : undefined;
}

function parseControlStatus(value: unknown): DiscordVoiceControlStatus {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed") return value;
  throw new Error(`Unsupported Discord voice control status ${String(value)}.`);
}

function parseSessionState(value: unknown): DiscordVoiceSessionState {
  if (value === "connecting" || value === "connected" || value === "disconnected" || value === "error") return value;
  throw new Error(`Unsupported Discord voice session state ${String(value)}.`);
}

function parseHealthState(value: unknown): DiscordVoiceOperationalState | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "connecting" || value === "ready" || value === "degraded" || value === "recovering" || value === "error") return value;
  throw new Error(`Unsupported Discord voice health state ${String(value)}.`);
}

const HEALTH_REASONS = new Set<DiscordVoiceHealthReason>([
  "gateway_not_ready", "gateway_heartbeat_stale", "discord_voice_not_ready", "provider_connecting",
  "provider_recovering", "provider_unavailable", "notification_listener_reconnecting",
  "postgres_pool_waiting", "audio_dropped", "playback_failed",
]);

function parseHealthReasons(value: unknown): DiscordVoiceHealthReason[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((reason): reason is DiscordVoiceHealthReason => typeof reason === "string" && HEALTH_REASONS.has(reason as DiscordVoiceHealthReason)).slice(0, 6);
}

function parseSendMode(value: unknown): DiscordVoiceSendMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "progress" || value === "final") return value;
  throw new Error(`Unsupported Discord voice send mode ${String(value)}.`);
}

function parseTurnStatus(value: unknown): DiscordVoiceTurnStatus {
  if (value === "pending" || value === "queued" || value === "running" || value === "awaiting_final" || value === "final_sending" || value === "completed" || value === "failed") return value;
  throw new Error(`Unsupported Discord voice turn status ${String(value)}.`);
}

function parseControl(row: Record<string, unknown>): DiscordVoiceControlRecord {
  return {
    id: requiredString(row.id, "Discord voice control id is missing."),
    connectorKey: requiredString(row.connector_key, "Discord voice connector key is missing."),
    operation: row.operation === "join" || row.operation === "leave" || row.operation === "send" ? row.operation : (() => { throw new Error("Invalid Discord voice operation."); })(),
    sessionId: requiredString(row.session_id, "Discord voice session id is missing."),
    agentKey: requiredString(row.agent_key, "Discord voice agent key is missing."),
    channelId: optionalString(row.channel_id),
    text: optionalString(row.text),
    mode: parseSendMode(row.mode),
    voiceTurnId: optionalString(row.voice_turn_id),
    idempotencyKey: optionalString(row.idempotency_key),
    status: parseControlStatus(row.status),
    result: parseJsonObject(row.result),
    error: optionalString(row.error),
    createdAt: requireTimestampMillis(row.created_at, "Discord voice control created_at is invalid."),
    updatedAt: requireTimestampMillis(row.updated_at, "Discord voice control updated_at is invalid."),
    completedAt: optionalTimestampMillis(row.completed_at, "Discord voice control completed_at is invalid."),
  };
}

function parseSession(row: Record<string, unknown>): DiscordVoiceSessionRecord {
  const model = requiredString(row.model, "Discord voice model is missing.");
  if (model !== DISCORD_VOICE_MODEL) throw new Error(`Unsupported Discord voice model ${model}.`);
  return {
    connectorKey: requiredString(row.connector_key, "Discord voice connector key is missing."),
    guildId: requiredString(row.guild_id, "Discord voice guild id is missing."),
    channelId: requiredString(row.channel_id, "Discord voice channel id is missing."),
    sessionId: requiredString(row.session_id, "Discord voice durable session id is missing."),
    agentKey: requiredString(row.agent_key, "Discord voice agent key is missing."),
    voiceSessionId: requiredString(row.voice_session_id, "Discord voice session id is missing."),
    state: parseSessionState(row.state),
    model,
    lastError: optionalString(row.last_error),
    health: parseHealthState(row.health_state),
    healthReasons: parseHealthReasons(row.health_reasons),
    healthObservedAt: optionalTimestampMillis(row.health_observed_at, "Discord voice health_observed_at is invalid."),
    startedAt: requireTimestampMillis(row.started_at, "Discord voice session started_at is invalid."),
    updatedAt: requireTimestampMillis(row.updated_at, "Discord voice session updated_at is invalid."),
  };
}

function parseTurn(row: Record<string, unknown>): DiscordVoiceTurnRecord {
  return {
    id: requiredString(row.id, "Discord voice turn id is missing."),
    voiceSessionId: requiredString(row.voice_session_id, "Discord voice session id is missing."),
    delegationId: requiredString(row.delegation_id, "Discord voice delegation id is missing."),
    connectorKey: requiredString(row.connector_key, "Discord voice connector key is missing."),
    guildId: requiredString(row.guild_id, "Discord voice guild id is missing."),
    channelId: requiredString(row.channel_id, "Discord voice channel id is missing."),
    sessionId: requiredString(row.session_id, "Discord voice durable session id is missing."),
    agentKey: requiredString(row.agent_key, "Discord voice agent key is missing."),
    externalActorId: optionalString(row.external_actor_id),
    identityId: optionalString(row.identity_id),
    // Rows created before utterance attribution shipped use the turn UUID as a
    // stable fallback. New rows always persist the actual source utterance UUID.
    sourceUtteranceId: optionalString(row.source_utterance_id) ?? requiredString(row.id, "Discord voice source utterance id is missing."),
    prompt: requiredString(row.prompt, "Discord voice delegation prompt is missing."),
    status: parseTurnStatus(row.status),
    threadId: optionalString(row.thread_id),
    runId: optionalString(row.run_id),
    resultText: optionalString(row.result_text),
    finalControlId: optionalString(row.final_control_id),
    finalText: optionalString(row.final_text),
    error: optionalString(row.error),
    createdAt: requireTimestampMillis(row.created_at, "Discord voice turn created_at is invalid."),
    updatedAt: requireTimestampMillis(row.updated_at, "Discord voice turn updated_at is invalid."),
    completedAt: optionalTimestampMillis(row.completed_at, "Discord voice turn completed_at is invalid."),
  };
}

export async function ensureDiscordVoiceSchema(pool: PgQueryable): Promise<void> {
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
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_controls_pending_idx`)} ON ${tables.controls} (connector_key, status, created_at, id)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_controls_idempotency_idx`)} ON ${tables.controls} (idempotency_key)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessions} (
      connector_key TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      session_id TEXT NOT NULL, agent_key TEXT NOT NULL, voice_session_id UUID NOT NULL,
      state TEXT NOT NULL, model TEXT NOT NULL, last_error TEXT,
      health_state TEXT, health_reasons JSONB NOT NULL DEFAULT '[]'::jsonb, health_observed_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (connector_key, guild_id)
    )
  `);
  await pool.query(`ALTER TABLE ${tables.sessions} ADD COLUMN IF NOT EXISTS health_state TEXT`);
  await pool.query(`ALTER TABLE ${tables.sessions} ADD COLUMN IF NOT EXISTS health_reasons JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE ${tables.sessions} ADD COLUMN IF NOT EXISTS health_observed_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_sessions_owner_idx`)} ON ${tables.sessions} (session_id, connector_key, state)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.turns} (
      id UUID PRIMARY KEY, voice_session_id UUID NOT NULL, delegation_id TEXT NOT NULL,
      connector_key TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      session_id TEXT NOT NULL, agent_key TEXT NOT NULL, external_actor_id TEXT, identity_id TEXT, source_utterance_id UUID,
      prompt TEXT NOT NULL, status TEXT NOT NULL, thread_id UUID, run_id UUID,
      result_text TEXT, final_control_id UUID, final_text TEXT, error TEXT, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ${tables.turns} ADD COLUMN IF NOT EXISTS source_utterance_id UUID`);
  await pool.query(`ALTER TABLE ${tables.turns} ADD COLUMN IF NOT EXISTS final_control_id UUID`);
  await pool.query(`ALTER TABLE ${tables.turns} ADD COLUMN IF NOT EXISTS final_text TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_turns_run_idx`)} ON ${tables.turns} (run_id, status)`);
  // Legacy turns have no source utterance. Partial indexes establish the new
  // invariant without making historical duplicate rows a startup blocker.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_turns_delegation_idx`)} ON ${tables.turns} (voice_session_id, delegation_id) WHERE source_utterance_id IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_turns_utterance_idx`)} ON ${tables.turns} (voice_session_id, source_utterance_id) WHERE source_utterance_id IS NOT NULL`);
}

export interface DiscordVoiceStoreOptions {
  pool: PgPoolLike<PgListenClient>;
}

export class DiscordVoiceStore {
  private readonly pool: PgPoolLike<PgListenClient>;

  constructor(options: DiscordVoiceStoreOptions) {
    this.pool = options.pool;
  }

  ensureSchema(): Promise<void> {
    return ensureDiscordVoiceSchema(this.pool);
  }

  private async notify(notification: DiscordVoiceNotification): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [DISCORD_VOICE_NOTIFICATION_CHANNEL, JSON.stringify(notification)]);
  }

  async enqueueControl(input: DiscordVoiceControlInput): Promise<DiscordVoiceControlRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${tables.controls} (id, connector_key, operation, session_id, agent_key, channel_id, text, mode, voice_turn_id, idempotency_key, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
      ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
      RETURNING *
    `, [randomUUID(), input.connectorKey, input.operation, input.sessionId, input.agentKey, input.channelId ?? null, input.text ?? null, input.mode ?? null, input.voiceTurnId ?? null, input.idempotencyKey ?? null]);
    const record = parseControl(result.rows[0] as Record<string, unknown>);
    await this.notify({kind: "control", connectorKey: record.connectorKey, controlId: record.id});
    return record;
  }

  async getControl(id: string): Promise<DiscordVoiceControlRecord> {
    const result = await this.pool.query(`SELECT * FROM ${tables.controls} WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new Error(`Unknown Discord voice control ${id}.`);
    return parseControl(result.rows[0] as Record<string, unknown>);
  }

  async claimNextControl(connectorKey: string): Promise<DiscordVoiceControlRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(`SELECT * FROM ${tables.controls} WHERE connector_key=$1 AND status='pending' ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [connectorKey]);
      if (!selected.rows[0]) { await client.query("COMMIT"); return null; }
      const record = parseControl(selected.rows[0] as Record<string, unknown>);
      const updated = await client.query(`UPDATE ${tables.controls} SET status='running',updated_at=NOW() WHERE id=$1 RETURNING *`, [record.id]);
      await client.query("COMMIT");
      return parseControl(updated.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async completeControl(id: string, resultValue: JsonObject): Promise<DiscordVoiceControlRecord> {
    const result = await this.pool.query(`UPDATE ${tables.controls} SET status='completed',result=$2::jsonb,error=NULL,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running' RETURNING *`, [id, JSON.stringify(resultValue)]);
    const record = result.rows[0]
      ? parseControl(result.rows[0] as Record<string, unknown>)
      : await this.getControl(id);
    if (result.rows[0]) await this.notify({kind: "control", connectorKey: record.connectorKey, controlId: record.id});
    return record;
  }

  async failControl(id: string, error: string): Promise<DiscordVoiceControlRecord> {
    const result = await this.pool.query(`UPDATE ${tables.controls} SET status='failed',error=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('pending','running') RETURNING *`, [id, error.slice(0, 1000)]);
    const record = result.rows[0]
      ? parseControl(result.rows[0] as Record<string, unknown>)
      : await this.getControl(id);
    if (result.rows[0]) await this.notify({kind: "control", connectorKey: record.connectorKey, controlId: record.id});
    return record;
  }

  async failRunningControls(connectorKey: string, error: string): Promise<number> {
    const result = await this.pool.query(`UPDATE ${tables.controls} SET status='failed',error=$2,completed_at=NOW(),updated_at=NOW() WHERE connector_key=$1 AND status='running'`, [connectorKey, error.slice(0, 1000)]);
    return result.rowCount ?? 0;
  }

  async waitForControl(id: string, options: number | {timeoutMs?: number; signal?: AbortSignal} = 35_000): Promise<DiscordVoiceControlRecord> {
    const timeoutMs = typeof options === "number" ? options : options.timeoutMs ?? 35_000;
    const signal = typeof options === "number" ? undefined : options.signal;
    const deadline = Date.now() + timeoutMs;
    let delayMs = 250;
    while (true) {
      signal?.throwIfAborted();
      const record = await this.getControl(id);
      if (record.status === "completed" || record.status === "failed") return record;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await abortableDelay(Math.min(delayMs, remainingMs), signal);
      delayMs = Math.min(1_000, delayMs * 2);
    }
    const finalRecord = await this.getControl(id);
    if (finalRecord.status === "completed" || finalRecord.status === "failed") return finalRecord;
    throw new Error(`Timed out waiting for Discord voice control ${id}.`);
  }

  async close(): Promise<void> {
    // This store owns no long-lived clients; retained for daemon cleanup symmetry.
  }

  async upsertSession(input: Omit<DiscordVoiceSessionRecord, "startedAt" | "updatedAt" | "healthReasons"> & {healthReasons?: readonly DiscordVoiceHealthReason[]}): Promise<DiscordVoiceSessionRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${tables.sessions} (connector_key,guild_id,channel_id,session_id,agent_key,voice_session_id,state,model,last_error,health_state,health_reasons,health_observed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
      ON CONFLICT (connector_key,guild_id) DO UPDATE SET channel_id=EXCLUDED.channel_id,session_id=EXCLUDED.session_id,agent_key=EXCLUDED.agent_key,voice_session_id=EXCLUDED.voice_session_id,state=EXCLUDED.state,model=EXCLUDED.model,last_error=EXCLUDED.last_error,health_state=EXCLUDED.health_state,health_reasons=EXCLUDED.health_reasons,health_observed_at=EXCLUDED.health_observed_at,started_at=CASE WHEN ${tables.sessions}.voice_session_id=EXCLUDED.voice_session_id THEN ${tables.sessions}.started_at ELSE NOW() END,updated_at=NOW()
      RETURNING *
    `, [input.connectorKey,input.guildId,input.channelId,input.sessionId,input.agentKey,input.voiceSessionId,input.state,input.model,input.lastError ?? null,input.health ?? null,JSON.stringify(input.healthReasons ?? []),input.healthObservedAt ? new Date(input.healthObservedAt) : null]);
    return parseSession(result.rows[0] as Record<string, unknown>);
  }

  async updateSessionHealth(input: {connectorKey: string; guildId: string; voiceSessionId: string; health: DiscordVoiceOperationalState; reasons: readonly DiscordVoiceHealthReason[]; observedAt: number}): Promise<void> {
    await this.pool.query(`UPDATE ${tables.sessions} SET health_state=$4,health_reasons=$5::jsonb,health_observed_at=$6,updated_at=NOW() WHERE connector_key=$1 AND guild_id=$2 AND voice_session_id=$3`, [input.connectorKey,input.guildId,input.voiceSessionId,input.health,JSON.stringify(input.reasons.slice(0,6)),new Date(input.observedAt)]);
  }

  async listSessions(filter: {sessionId?: string; connectorKey?: string; activeOnly?: boolean} = {}): Promise<readonly DiscordVoiceSessionRecord[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (filter.sessionId) { values.push(filter.sessionId); clauses.push(`session_id=$${values.length}`); }
    if (filter.connectorKey) { values.push(filter.connectorKey); clauses.push(`connector_key=$${values.length}`); }
    if (filter.activeOnly ?? false) clauses.push("state IN ('connecting','connected')");
    const result = await this.pool.query(`SELECT * FROM ${tables.sessions}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY started_at`, values);
    return result.rows.map((row) => parseSession(row as Record<string, unknown>));
  }

  async markSessionDisconnected(connectorKey: string, guildId: string, state: "disconnected" | "error", error?: string): Promise<void> {
    await this.pool.query(`UPDATE ${tables.sessions} SET state=$3,last_error=$4,updated_at=NOW() WHERE connector_key=$1 AND guild_id=$2`, [connectorKey,guildId,state,error ?? null]);
  }

  async markConnectorSessionsDisconnected(connectorKey: string, error: string): Promise<number> {
    const result = await this.pool.query(`UPDATE ${tables.sessions} SET state='disconnected',last_error=$2,updated_at=NOW() WHERE connector_key=$1 AND state IN ('connecting','connected')`, [connectorKey,error]);
    return result.rowCount ?? 0;
  }

  async createOrGetTurn(input: DiscordVoiceTurnInput): Promise<{turn: DiscordVoiceTurnRecord; created: boolean}> {
    const result = await this.pool.query(`
      INSERT INTO ${tables.turns} (id,voice_session_id,delegation_id,connector_key,guild_id,channel_id,session_id,agent_key,external_actor_id,identity_id,source_utterance_id,prompt,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
      ON CONFLICT DO NOTHING RETURNING *
    `, [input.id,input.voiceSessionId,input.delegationId,input.connectorKey,input.guildId,input.channelId,input.sessionId,input.agentKey,input.externalActorId ?? null,input.identityId ?? null,input.sourceUtteranceId,input.prompt]);
    if (result.rows[0]) return {turn: parseTurn(result.rows[0] as Record<string, unknown>), created: true};
    const existing = await this.pool.query(`SELECT * FROM ${tables.turns} WHERE voice_session_id=$1 AND (source_utterance_id=$2 OR delegation_id=$3) ORDER BY created_at LIMIT 1`, [input.voiceSessionId,input.sourceUtteranceId,input.delegationId]);
    if (!existing.rows[0]) throw new Error("Discord voice turn conflict could not be resolved.");
    return {turn: parseTurn(existing.rows[0] as Record<string, unknown>), created: false};
  }

  async getTurn(id: string): Promise<DiscordVoiceTurnRecord> {
    const result = await this.pool.query(`SELECT * FROM ${tables.turns} WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new Error(`Unknown Discord voice turn ${id}.`);
    return parseTurn(result.rows[0] as Record<string, unknown>);
  }

  async markTurnQueued(id: string, threadId: string): Promise<DiscordVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='queued',thread_id=$2,updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id,threadId]);
    return result.rows[0] ? parseTurn(result.rows[0] as Record<string, unknown>) : this.getTurn(id);
  }

  async assignTurnsToRun(turnIds: readonly string[], runId: string): Promise<void> {
    if (turnIds.length === 0) return;
    const placeholders = turnIds.map((_, index) => `$${String(index + 2)}`).join(",");
    await this.pool.query(`UPDATE ${tables.turns} SET status='running',run_id=$1,updated_at=NOW() WHERE id IN (${placeholders}) AND status IN ('pending','queued')`, [runId, ...turnIds]);
  }

  async markTurnsAwaitingFinal(runId: string): Promise<void> {
    await this.pool.query(`UPDATE ${tables.turns} SET status='awaiting_final',updated_at=NOW() WHERE run_id=$1 AND status='running'`, [runId]);
  }

  async listRunningTurns(runId: string): Promise<readonly DiscordVoiceTurnRecord[]> {
    const result = await this.pool.query(`SELECT * FROM ${tables.turns} WHERE run_id=$1 AND status='running' ORDER BY created_at`, [runId]);
    return result.rows.map((row) => parseTurn(row as Record<string, unknown>));
  }

  async completeTurn(id: string, text: string): Promise<DiscordVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='completed',result_text=$2,error=NULL,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('pending','queued','running','awaiting_final') RETURNING *`, [id,text]);
    return result.rows[0] ? parseTurn(result.rows[0] as Record<string, unknown>) : this.getTurn(id);
  }

  async reserveFinalDelivery(id: string, controlId: string, text: string): Promise<{turn: DiscordVoiceTurnRecord; reserved: boolean}> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='final_sending',final_control_id=$2,final_text=$3,updated_at=NOW() WHERE id=$1 AND status IN ('pending','queued','running','awaiting_final') RETURNING *`, [id,controlId,text]);
    return result.rows[0]
      ? {turn: parseTurn(result.rows[0] as Record<string, unknown>), reserved: true}
      : {turn: await this.getTurn(id), reserved: false};
  }

  async releaseFinalDelivery(id: string, controlId: string): Promise<DiscordVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='awaiting_final',final_control_id=NULL,final_text=NULL,updated_at=NOW() WHERE id=$1 AND status='final_sending' AND final_control_id=$2 RETURNING *`, [id,controlId]);
    return result.rows[0] ? parseTurn(result.rows[0] as Record<string, unknown>) : this.getTurn(id);
  }

  async completeReservedFinal(id: string, controlId: string): Promise<DiscordVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='completed',result_text=final_text,error=NULL,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='final_sending' AND final_control_id=$2 RETURNING *`, [id,controlId]);
    return result.rows[0] ? parseTurn(result.rows[0] as Record<string, unknown>) : this.getTurn(id);
  }

  async failTurn(id: string, error: string): Promise<DiscordVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='failed',error=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed') RETURNING *`, [id,error.slice(0,1000)]);
    return result.rows[0] ? parseTurn(result.rows[0] as Record<string, unknown>) : this.getTurn(id);
  }

  async failConnectorActiveTurns(connectorKey: string, error: string): Promise<number> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='failed',error=$2,completed_at=NOW(),updated_at=NOW() WHERE connector_key=$1 AND status NOT IN ('completed','failed')`, [connectorKey,error.slice(0,1000)]);
    return result.rowCount ?? 0;
  }

}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("Discord voice control wait was aborted."));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, {once: true});
    if (signal?.aborted) onAbort();
  });
}

export function parseDiscordVoiceNotification(payload: string | undefined): DiscordVoiceNotification | null {
  if (!payload) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(payload) as unknown; } catch { return null; }
  if (!isJsonObject(parsed)) return null;
  if (parsed.kind === "control" && typeof parsed.connectorKey === "string" && typeof parsed.controlId === "string") return parsed as unknown as DiscordVoiceControlNotification;
  return null;
}
