import {randomUUID} from "node:crypto";

import {isJsonObject, type JsonObject} from "../../../lib/json.js";
import {buildRuntimeRelationNames} from "../../../lib/postgres-relations.js";
import type {PgListenClient, PgPoolLike} from "../../../lib/postgres-query.js";
import {withTransaction} from "../../../lib/postgres-transaction.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../../lib/postgres-values.js";
import {requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {SessionArchivedError} from "../../../domain/threads/runtime/store.js";
import type {
  DiscordVoiceControlInput,
  DiscordVoiceControlNotification,
  DiscordVoiceControlRecord,
  DiscordVoiceControlStatus,
  DiscordVoiceNotification,
  DiscordVoiceSendMode,
} from "./voice-types.js";
import {buildSessionTableNames} from "../../../domain/sessions/postgres-shared.js";

export const DISCORD_VOICE_NOTIFICATION_CHANNEL = "runtime_discord_voice_events";
const tables = buildRuntimeRelationNames({controls: "discord_voice_controls"});
const agentSessionTable = buildSessionTableNames().sessions;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? trimToUndefined(value) : undefined;
}

function parseJsonObject(value: unknown): JsonObject | undefined {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return isJsonObject(parsed) ? parsed : undefined;
}

function parseControlStatus(value: unknown): DiscordVoiceControlStatus {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed") return value;
  throw new Error(`Unsupported Discord voice control status ${String(value)}.`);
}

function parseSendMode(value: unknown): DiscordVoiceSendMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "progress" || value === "final") return value;
  throw new Error(`Unsupported Discord voice send mode ${String(value)}.`);
}

function parseControl(row: Record<string, unknown>): DiscordVoiceControlRecord {
  return {
    id: requireNonEmptyString(row.id, "Discord voice control id is missing."),
    connectorKey: requireNonEmptyString(row.connector_key, "Discord voice connector key is missing."),
    operation: row.operation === "join" || row.operation === "leave" || row.operation === "send" ? row.operation : (() => { throw new Error("Invalid Discord voice operation."); })(),
    sessionId: requireNonEmptyString(row.session_id, "Discord voice session id is missing."),
    agentKey: requireNonEmptyString(row.agent_key, "Discord voice agent key is missing."),
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

/** Owns Discord command/worker coordination; live-call state lives in LiveVoiceRepo. */
export class DiscordVoiceControlRepo {
  private readonly pool: PgPoolLike<PgListenClient>;

  constructor(options: {pool: PgPoolLike<PgListenClient>}) { this.pool = options.pool; }

  private async notify(notification: DiscordVoiceNotification): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [DISCORD_VOICE_NOTIFICATION_CHANNEL, JSON.stringify(notification)]);
  }

  async enqueueControl(input: DiscordVoiceControlInput): Promise<DiscordVoiceControlRecord> {
    const record = await withTransaction(this.pool, async (client) => {
      if (input.operation !== "leave") {
        const lifecycle = await client.query(`
          SELECT id, archived_at
          FROM ${agentSessionTable}
          WHERE id = $1
          FOR UPDATE
        `, [input.sessionId]);
        const lifecycleRow = lifecycle.rows[0] as {archived_at?: unknown} | undefined;
        if (!lifecycleRow) throw new Error(`Unknown session ${input.sessionId}.`);
        if (lifecycleRow.archived_at !== null) throw new SessionArchivedError(input.sessionId);
      }
      const result = await client.query(`
        INSERT INTO ${tables.controls} (id,connector_key,operation,session_id,agent_key,channel_id,text,mode,voice_turn_id,idempotency_key,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
        ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *
      `, [randomUUID(),input.connectorKey,input.operation,input.sessionId,input.agentKey,input.channelId ?? null,input.text ?? null,input.mode ?? null,input.voiceTurnId ?? null,input.idempotencyKey ?? null]);
      return parseControl(result.rows[0] as Record<string, unknown>);
    });
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
      const candidate = await client.query(`SELECT id,session_id,operation FROM ${tables.controls} WHERE connector_key=$1 AND status='pending' ORDER BY created_at,id LIMIT 1`, [connectorKey]);
      if (!candidate.rows[0]) { await client.query("COMMIT"); return null; }
      const hint = candidate.rows[0] as {id: string; session_id: string; operation: string};
      if (hint.operation !== "leave") {
        const active = await client.query(`SELECT id FROM ${agentSessionTable} WHERE id=$1 AND archived_at IS NULL FOR UPDATE`, [hint.session_id]);
        if (!active.rows[0]) {
          await client.query(`UPDATE ${tables.controls} SET status='failed',error='session_archived',completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='pending'`, [hint.id]);
          await client.query("COMMIT");
          return null;
        }
      }
      const selected = await client.query(`SELECT * FROM ${tables.controls} WHERE id=$1 AND status='pending' FOR UPDATE`, [hint.id]);
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
    const result = await this.pool.query(`UPDATE ${tables.controls} SET status='completed',result=$2::jsonb,error=NULL,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running' RETURNING *`, [id,JSON.stringify(resultValue)]);
    const record = result.rows[0] ? parseControl(result.rows[0] as Record<string, unknown>) : await this.getControl(id);
    if (result.rows[0]) await this.notify({kind: "control", connectorKey: record.connectorKey, controlId: record.id});
    return record;
  }

  async failControl(id: string, error: string): Promise<DiscordVoiceControlRecord> {
    const result = await this.pool.query(`UPDATE ${tables.controls} SET status='failed',error=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('pending','running') RETURNING *`, [id,error.slice(0,1000)]);
    const record = result.rows[0] ? parseControl(result.rows[0] as Record<string, unknown>) : await this.getControl(id);
    if (result.rows[0]) await this.notify({kind: "control", connectorKey: record.connectorKey, controlId: record.id});
    return record;
  }

  async failRunningControls(connectorKey: string, error: string): Promise<number> {
    const result = await this.pool.query(`UPDATE ${tables.controls} SET status='failed',error=$2,completed_at=NOW(),updated_at=NOW() WHERE connector_key=$1 AND status='running'`, [connectorKey,error.slice(0,1000)]);
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
    // This repository owns no long-lived clients.
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
