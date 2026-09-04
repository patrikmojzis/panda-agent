import {randomUUID} from "node:crypto";

import {isJsonObject, type JsonObject} from "../../../../lib/json.js";
import {buildRuntimeRelationNames} from "../../../../lib/postgres-relations.js";
import type {PgListenClient, PgPoolLike} from "../../../../lib/postgres-query.js";
import {withTransaction} from "../../../../lib/postgres-transaction.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../../../lib/postgres-values.js";
import {requireNonEmptyString, trimToUndefined} from "../../../../lib/strings.js";
import {buildSessionTableNames} from "../../../../domain/sessions/postgres-shared.js";
import {SessionArchivedError} from "../../../../domain/threads/runtime/store.js";
import {VoiceControlWaitTimeoutError} from "../../../voice/control-errors.js";
import type {WhatsAppCallControlInput, WhatsAppCallControlRecord, WhatsAppCallControlStatus, WhatsAppCallNotification, WhatsAppCallSendMode} from "./types.js";

export const WHATSAPP_CALL_NOTIFICATION_CHANNEL = "runtime_whatsapp_call_events";
const tables = buildRuntimeRelationNames({controls: "whatsapp_call_controls"});
const sessionTable = buildSessionTableNames().sessions;

function optionalString(value: unknown): string | undefined { return typeof value === "string" ? trimToUndefined(value) : undefined; }
function parseStatus(value: unknown): WhatsAppCallControlStatus { if (value === "pending" || value === "running" || value === "completed" || value === "failed") return value; throw new Error("Invalid WhatsApp call control status."); }
function parseMode(value: unknown): WhatsAppCallSendMode | undefined { if (value === null || value === undefined) return undefined; if (value === "progress" || value === "final") return value; throw new Error("Invalid WhatsApp call send mode."); }
function parseResult(value: unknown): JsonObject | undefined { const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value; return isJsonObject(parsed) ? parsed : undefined; }
function parseControl(row: Record<string, unknown>): WhatsAppCallControlRecord {
  return {
    id: requireNonEmptyString(row.id, "WhatsApp call control id is missing."),
    connectorKey: requireNonEmptyString(row.connector_key, "WhatsApp call connector key is missing."),
    operation: row.operation === "send" || row.operation === "hangup" ? row.operation : (() => { throw new Error("Invalid WhatsApp call control operation."); })(),
    sessionId: requireNonEmptyString(row.session_id, "WhatsApp call session id is missing."),
    agentKey: requireNonEmptyString(row.agent_key, "WhatsApp call agent key is missing."),
    callId: requireNonEmptyString(row.call_id, "WhatsApp call id is missing."),
    text: optionalString(row.text), mode: parseMode(row.mode), voiceTurnId: optionalString(row.voice_turn_id), idempotencyKey: optionalString(row.idempotency_key),
    status: parseStatus(row.status), result: parseResult(row.result), error: optionalString(row.error),
    createdAt: requireTimestampMillis(row.created_at, "WhatsApp call control created_at is invalid."),
    updatedAt: requireTimestampMillis(row.updated_at, "WhatsApp call control updated_at is invalid."),
    completedAt: optionalTimestampMillis(row.completed_at, "WhatsApp call control completed_at is invalid."),
  };
}

export class WhatsAppCallControlRepo {
  constructor(private readonly pool: PgPoolLike<PgListenClient>) {}

  private async notify(record: WhatsAppCallControlRecord): Promise<void> {
    const payload: WhatsAppCallNotification = {kind: "control", connectorKey: record.connectorKey, controlId: record.id};
    await this.pool.query("SELECT pg_notify($1, $2)", [WHATSAPP_CALL_NOTIFICATION_CHANNEL, JSON.stringify(payload)]);
  }

  async enqueueControl(input: WhatsAppCallControlInput): Promise<WhatsAppCallControlRecord> {
    const record = await withTransaction(this.pool, async (client) => {
      const lifecycle = await client.query(`SELECT id,archived_at FROM ${sessionTable} WHERE id=$1 FOR UPDATE`, [input.sessionId]);
      const row = lifecycle.rows[0] as {archived_at?: unknown} | undefined;
      if (!row) throw new Error(`Unknown session ${input.sessionId}.`);
      if (row.archived_at !== null) throw new SessionArchivedError(input.sessionId);
      const result = await client.query(`
        INSERT INTO ${tables.controls} (id,connector_key,operation,session_id,agent_key,call_id,text,mode,voice_turn_id,idempotency_key,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
        ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *
      `, [randomUUID(),input.connectorKey,input.operation,input.sessionId,input.agentKey,input.callId,input.text ?? null,input.mode ?? null,input.voiceTurnId ?? null,input.idempotencyKey ?? null]);
      return parseControl(result.rows[0] as Record<string, unknown>);
    });
    await this.notify(record); return record;
  }

  async getControl(id: string): Promise<WhatsAppCallControlRecord> {
    const result = await this.pool.query(`SELECT * FROM ${tables.controls} WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new Error(`Unknown WhatsApp call control ${id}.`);
    return parseControl(result.rows[0] as Record<string, unknown>);
  }

  async claimNextControl(connectorKey: string): Promise<WhatsAppCallControlRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(`SELECT * FROM ${tables.controls} WHERE connector_key=$1 AND status='pending' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [connectorKey]);
      if (!result.rows[0]) return null;
      const control = parseControl(result.rows[0] as Record<string, unknown>);
      const session = await client.query(`SELECT id FROM ${sessionTable} WHERE id=$1 AND archived_at IS NULL FOR UPDATE`, [control.sessionId]);
      if (!session.rows[0]) { await client.query(`UPDATE ${tables.controls} SET status='failed',error='session_archived',completed_at=NOW(),updated_at=NOW() WHERE id=$1`, [control.id]); return null; }
      const updated = await client.query(`UPDATE ${tables.controls} SET status='running',updated_at=NOW() WHERE id=$1 RETURNING *`, [control.id]);
      return parseControl(updated.rows[0] as Record<string, unknown>);
    });
  }

  async completeControl(id: string, value: JsonObject): Promise<WhatsAppCallControlRecord> {
    const result = await this.pool.query(`UPDATE ${tables.controls} SET status='completed',result=$2::jsonb,error=NULL,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running' RETURNING *`, [id, JSON.stringify(value)]);
    const record = result.rows[0] ? parseControl(result.rows[0] as Record<string, unknown>) : await this.getControl(id);
    if (result.rows[0]) await this.notify(record); return record;
  }

  async failControl(id: string, error: string): Promise<WhatsAppCallControlRecord> {
    const result = await this.pool.query(`UPDATE ${tables.controls} SET status='failed',error=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('pending','running') RETURNING *`, [id,error.slice(0,1000)]);
    const record = result.rows[0] ? parseControl(result.rows[0] as Record<string, unknown>) : await this.getControl(id);
    if (result.rows[0]) await this.notify(record); return record;
  }

  async failRunningControls(connectorKey: string, error: string): Promise<number> {
    const result = await this.pool.query(`UPDATE ${tables.controls} SET status='failed',error=$2,completed_at=NOW(),updated_at=NOW() WHERE connector_key=$1 AND status='running'`, [connectorKey,error.slice(0,1000)]);
    return result.rowCount ?? 0;
  }

  async waitForControl(id: string, options: {timeoutMs?: number; signal?: AbortSignal} = {}): Promise<WhatsAppCallControlRecord> {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    while (true) {
      options.signal?.throwIfAborted();
      const record = await this.getControl(id);
      if (record.status === "completed" || record.status === "failed") return record;
      if (Date.now() >= deadline) throw new VoiceControlWaitTimeoutError(`Timed out waiting for WhatsApp call control ${id}.`);
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 250); timer.unref?.(); });
    }
  }
}

export function parseWhatsAppCallNotification(payload: string | undefined): WhatsAppCallNotification | null {
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as unknown;
    return isJsonObject(value) && value.kind === "control" && typeof value.connectorKey === "string" && typeof value.controlId === "string" ? value as unknown as WhatsAppCallNotification : null;
  } catch { return null; }
}
