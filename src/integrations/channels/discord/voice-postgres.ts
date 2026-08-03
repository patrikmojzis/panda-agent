import {randomUUID} from "node:crypto";

import {isJsonObject, type JsonObject} from "../../../lib/json.js";
import {listenPostgresChannel} from "../../../lib/postgres-listen.js";
import {buildRuntimeRelationNames, CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier} from "../../../lib/postgres-relations.js";
import type {PgListenClient, PgPoolLike, PgQueryable} from "../../../lib/postgres-query.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../../lib/postgres-values.js";
import {requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {
  DISCORD_VOICE_MODEL,
  type DiscordVoiceControlInput,
  type DiscordVoiceControlNotification,
  type DiscordVoiceControlRecord,
  type DiscordVoiceControlStatus,
  type DiscordVoiceNotification,
  type DiscordVoiceSessionRecord,
  type DiscordVoiceSessionState,
  type DiscordVoiceTurnInput,
  type DiscordVoiceTurnNotification,
  type DiscordVoiceTurnRecord,
  type DiscordVoiceTurnStatus,
} from "./voice-types.js";

const VOICE_NOTIFICATION_CHANNEL = "runtime_discord_voice_events";

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

function parseTurnStatus(value: unknown): DiscordVoiceTurnStatus {
  if (value === "pending" || value === "queued" || value === "running" || value === "completed" || value === "failed") return value;
  throw new Error(`Unsupported Discord voice turn status ${String(value)}.`);
}

function parseControl(row: Record<string, unknown>): DiscordVoiceControlRecord {
  return {
    id: requiredString(row.id, "Discord voice control id is missing."),
    connectorKey: requiredString(row.connector_key, "Discord voice connector key is missing."),
    operation: row.operation === "join" || row.operation === "leave" ? row.operation : (() => { throw new Error("Invalid Discord voice operation."); })(),
    sessionId: requiredString(row.session_id, "Discord voice session id is missing."),
    agentKey: requiredString(row.agent_key, "Discord voice agent key is missing."),
    channelId: optionalString(row.channel_id),
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
    prompt: requiredString(row.prompt, "Discord voice delegation prompt is missing."),
    status: parseTurnStatus(row.status),
    threadId: optionalString(row.thread_id),
    runId: optionalString(row.run_id),
    resultText: optionalString(row.result_text),
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
      status TEXT NOT NULL, result JSONB, error TEXT, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_controls_pending_idx`)} ON ${tables.controls} (connector_key, status, created_at, id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.sessions} (
      connector_key TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      session_id TEXT NOT NULL, agent_key TEXT NOT NULL, voice_session_id UUID NOT NULL,
      state TEXT NOT NULL, model TEXT NOT NULL, last_error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (connector_key, guild_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_sessions_owner_idx`)} ON ${tables.sessions} (session_id, connector_key, state)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.turns} (
      id UUID PRIMARY KEY, voice_session_id UUID NOT NULL, delegation_id TEXT NOT NULL,
      connector_key TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      session_id TEXT NOT NULL, agent_key TEXT NOT NULL, external_actor_id TEXT, identity_id TEXT,
      prompt TEXT NOT NULL, status TEXT NOT NULL, thread_id UUID, run_id UUID,
      result_text TEXT, error TEXT, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_turns_run_idx`)} ON ${tables.turns} (run_id, status)`);
}

export interface DiscordVoiceStoreOptions {
  pool: PgPoolLike<PgListenClient>;
  notificationPool?: PgPoolLike<PgListenClient>;
}

export class DiscordVoiceStore {
  private readonly pool: PgPoolLike<PgListenClient>;
  private readonly notificationPool: PgPoolLike<PgListenClient>;
  private controlWaitListener?: Promise<() => Promise<void>>;
  private readonly controlWaiters = new Map<string, Set<(record: DiscordVoiceControlRecord) => void>>();

  constructor(options: DiscordVoiceStoreOptions) {
    this.pool = options.pool;
    this.notificationPool = options.notificationPool ?? options.pool;
  }

  ensureSchema(): Promise<void> {
    return ensureDiscordVoiceSchema(this.pool);
  }

  private async notify(notification: DiscordVoiceNotification): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [VOICE_NOTIFICATION_CHANNEL, JSON.stringify(notification)]);
  }

  async enqueueControl(input: DiscordVoiceControlInput): Promise<DiscordVoiceControlRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${tables.controls} (id, connector_key, operation, session_id, agent_key, channel_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *
    `, [randomUUID(), input.connectorKey, input.operation, input.sessionId, input.agentKey, input.channelId ?? null]);
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

  async waitForControl(id: string, timeoutMs = 35_000): Promise<DiscordVoiceControlRecord> {
    const existing = await this.getControl(id);
    if (existing.status === "completed" || existing.status === "failed") return existing;
    await this.ensureControlWaitListener();
    return new Promise<DiscordVoiceControlRecord>((resolve, reject) => {
      let settled = false;
      const finish = (record: DiscordVoiceControlRecord) => {
        if (settled || (record.status !== "completed" && record.status !== "failed")) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.controlWaiters.get(id);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.controlWaiters.delete(id);
        resolve(record);
      };
      const waiters = this.controlWaiters.get(id) ?? new Set();
      waiters.add(finish);
      this.controlWaiters.set(id, waiters);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        if (waiters.size === 0) this.controlWaiters.delete(id);
        reject(new Error(`Timed out waiting for Discord voice control ${id}.`));
      }, timeoutMs);
      timer.unref?.();
      void this.getControl(id).then(finish, reject);
    });
  }

  private async ensureControlWaitListener(): Promise<void> {
    this.controlWaitListener ??= this.listen(async (notification) => {
      if (notification.kind !== "control" || !this.controlWaiters.has(notification.controlId)) return;
      const record = await this.getControl(notification.controlId);
      for (const waiter of this.controlWaiters.get(notification.controlId) ?? []) waiter(record);
    }).catch((error: unknown) => {
      this.controlWaitListener = undefined;
      throw error;
    });
    await this.controlWaitListener;
  }

  async close(): Promise<void> {
    const listener = this.controlWaitListener;
    this.controlWaitListener = undefined;
    if (listener) await (await listener)();
    this.controlWaiters.clear();
  }

  async upsertSession(input: Omit<DiscordVoiceSessionRecord, "startedAt" | "updatedAt">): Promise<DiscordVoiceSessionRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${tables.sessions} (connector_key,guild_id,channel_id,session_id,agent_key,voice_session_id,state,model,last_error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (connector_key,guild_id) DO UPDATE SET channel_id=EXCLUDED.channel_id,session_id=EXCLUDED.session_id,agent_key=EXCLUDED.agent_key,voice_session_id=EXCLUDED.voice_session_id,state=EXCLUDED.state,model=EXCLUDED.model,last_error=EXCLUDED.last_error,started_at=CASE WHEN ${tables.sessions}.voice_session_id=EXCLUDED.voice_session_id THEN ${tables.sessions}.started_at ELSE NOW() END,updated_at=NOW()
      RETURNING *
    `, [input.connectorKey,input.guildId,input.channelId,input.sessionId,input.agentKey,input.voiceSessionId,input.state,input.model,input.lastError ?? null]);
    return parseSession(result.rows[0] as Record<string, unknown>);
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

  async createTurn(input: DiscordVoiceTurnInput): Promise<DiscordVoiceTurnRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${tables.turns} (id,voice_session_id,delegation_id,connector_key,guild_id,channel_id,session_id,agent_key,external_actor_id,identity_id,prompt,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') RETURNING *
    `, [input.id,input.voiceSessionId,input.delegationId,input.connectorKey,input.guildId,input.channelId,input.sessionId,input.agentKey,input.externalActorId ?? null,input.identityId ?? null,input.prompt]);
    const record = parseTurn(result.rows[0] as Record<string, unknown>);
    await this.notify({kind: "turn", connectorKey: record.connectorKey, turnId: record.id});
    return record;
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

  async listRunningTurns(runId: string): Promise<readonly DiscordVoiceTurnRecord[]> {
    const result = await this.pool.query(`SELECT * FROM ${tables.turns} WHERE run_id=$1 AND status='running' ORDER BY created_at`, [runId]);
    return result.rows.map((row) => parseTurn(row as Record<string, unknown>));
  }

  async completeTurn(id: string, text: string): Promise<DiscordVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='completed',result_text=$2,error=NULL,completed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`, [id,text]);
    const record = parseTurn(result.rows[0] as Record<string, unknown>);
    await this.notify({kind: "turn", connectorKey: record.connectorKey, turnId: record.id});
    return record;
  }

  async failTurn(id: string, error: string): Promise<DiscordVoiceTurnRecord> {
    const result = await this.pool.query(`UPDATE ${tables.turns} SET status='failed',error=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`, [id,error.slice(0,1000)]);
    const record = parseTurn(result.rows[0] as Record<string, unknown>);
    await this.notify({kind: "turn", connectorKey: record.connectorKey, turnId: record.id});
    return record;
  }

  listen(listener: (notification: DiscordVoiceNotification) => Promise<void> | void): Promise<() => Promise<void>> {
    return listenPostgresChannel({
      pool: this.notificationPool,
      channel: VOICE_NOTIFICATION_CHANNEL,
      label: "Discord voice notification",
      parse: (payload): DiscordVoiceNotification | null => {
        if (!payload) return null;
        const parsed = JSON.parse(payload) as unknown;
        if (!isJsonObject(parsed)) return null;
        if (parsed.kind === "control" && typeof parsed.connectorKey === "string" && typeof parsed.controlId === "string") return parsed as unknown as DiscordVoiceControlNotification;
        if (parsed.kind === "turn" && typeof parsed.connectorKey === "string" && typeof parsed.turnId === "string") return parsed as unknown as DiscordVoiceTurnNotification;
        return null;
      },
      listener,
    });
  }
}
