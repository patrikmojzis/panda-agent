import {randomUUID} from "node:crypto";

import {optionalTimestampMillis, requireTimestampMillis} from "../../../lib/postgres-values.js";
import type {ChannelTypingRequest} from "../types.js";
import {normalizeChannelWorkerLookup, parseChannelNotification} from "../worker-shared.js";
import {listenPostgresChannel} from "../../../lib/postgres-listen.js";
import {requireNonNegativeInteger} from "../../../lib/numbers.js";
import type {PgListenClient, PgPoolLike} from "../../../lib/postgres-query.js";
import {isRecord} from "../../../lib/records.js";
import {optionalTrimmedString, requireNonEmptyString} from "../../../lib/strings.js";
import {
    buildActionNotificationChannel,
    buildChannelActionTableNames,
    type ChannelActionTableNames,
} from "./postgres-shared.js";
import {ensurePostgresChannelActionSchema} from "./postgres-schema.js";
import type {
    ActionNotification,
    ActionWorkerLookup,
    ChannelActionInput,
    ChannelActionKind,
    ChannelActionRecord,
    ChannelActionStatus,
    TelegramReactionActionPayload,
} from "./types.js";

export interface PostgresChannelActionStoreOptions {
  pool: PgPoolLike<PgListenClient>;
  notificationPool?: PgPoolLike<PgListenClient>;
}

export const parseActionNotification: (payload: string) => ActionNotification | null = parseChannelNotification;

function parseKind(value: unknown): ChannelActionKind {
  if (value === "typing" || value === "telegram_reaction") {
    return value;
  }

  throw new Error(`Unsupported channel action kind ${String(value)}.`);
}

function parseStatus(value: unknown): ChannelActionStatus {
  if (value === "pending" || value === "sending" || value === "sent" || value === "failed") {
    return value;
  }

  throw new Error(`Unsupported channel action status ${String(value)}.`);
}

function readPayloadRecord(kind: ChannelActionKind, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Channel action ${kind} payload must be a JSON object.`);
  }

  return value;
}

function readRequiredPayloadString(
  kind: ChannelActionKind,
  value: unknown,
  field: string,
): string {
  return requireNonEmptyString(value, `Channel action ${kind} payload ${field} must not be empty.`);
}

function readOptionalPayloadString(
  kind: ChannelActionKind,
  value: unknown,
  field: string,
): string | undefined {
  if (value === null) {
    throw new Error(`Channel action ${kind} payload ${field} must be a string.`);
  }

  return optionalTrimmedString(value, `Channel action ${kind} payload ${field} must be a string.`);
}

function readOptionalPayloadBoolean(
  kind: ChannelActionKind,
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Channel action ${kind} payload ${field} must be a boolean.`);
  }

  return value;
}

function readOptionalRowString(value: unknown, field: string): string | undefined {
  return optionalTrimmedString(value, `Channel action ${field} must be a string.`);
}

function parseTypingPayload(value: unknown): ChannelTypingRequest {
  const kind = "typing";
  const payload = readPayloadRecord(kind, value);
  const target = payload.target;
  if (!isRecord(target)) {
    throw new Error("Channel action typing payload target must be a JSON object.");
  }

  const phase = payload.phase;
  if (phase !== "start" && phase !== "keepalive" && phase !== "stop") {
    throw new Error(`Channel action typing payload phase is invalid: ${String(phase)}.`);
  }

  const externalActorId = readOptionalPayloadString(kind, target.externalActorId, "target external actor id");
  return {
    channel: readRequiredPayloadString(kind, payload.channel, "channel"),
    phase,
    target: {
      source: readRequiredPayloadString(kind, target.source, "target source"),
      connectorKey: readRequiredPayloadString(kind, target.connectorKey, "target connector key"),
      externalConversationId: readRequiredPayloadString(kind, target.externalConversationId, "target conversation id"),
      ...(externalActorId ? {externalActorId} : {}),
    },
  };
}

function parseTelegramReactionPayload(value: unknown): TelegramReactionActionPayload {
  const kind = "telegram_reaction";
  const payload = readPayloadRecord(kind, value);
  const remove = readOptionalPayloadBoolean(kind, payload.remove, "remove");
  const emoji = readOptionalPayloadString(kind, payload.emoji, "emoji");
  if (remove !== true && !emoji) {
    throw new Error("Channel action telegram_reaction payload emoji must not be empty unless remove is true.");
  }

  return {
    conversationId: readRequiredPayloadString(kind, payload.conversationId, "conversation id"),
    messageId: readRequiredPayloadString(kind, payload.messageId, "message id"),
    ...(emoji ? {emoji} : {}),
    ...(remove !== undefined ? {remove} : {}),
  };
}

function requireRecordKind<K extends ChannelActionKind>(
  record: ChannelActionRecord,
  kind: K,
): ChannelActionRecord<K> {
  if (record.kind !== kind) {
    throw new Error(`Expected channel action kind ${kind}, got ${record.kind}.`);
  }

  return record as ChannelActionRecord<K>;
}

function parseRecord(row: Record<string, unknown>): ChannelActionRecord {
  const kind = parseKind(row.kind);
  const common = {
    id: requireNonEmptyString(row.id, "Channel action id must not be empty."),
    channel: requireNonEmptyString(row.channel, "Channel action channel must not be empty."),
    connectorKey: requireNonEmptyString(row.connector_key, "Channel action connector key must not be empty."),
    status: parseStatus(row.status),
    attemptCount: requireNonNegativeInteger(row.attempt_count, "Channel action attempt count"),
    lastError: readOptionalRowString(row.last_error, "last error"),
    claimedAt: optionalTimestampMillis(row.claimed_at, "Channel action claimed_at must be a finite timestamp."),
    completedAt: optionalTimestampMillis(row.completed_at, "Channel action completed_at must be a finite timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "Channel action created_at must be a finite timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Channel action updated_at must be a finite timestamp."),
  };
  if (kind === "typing") {
    return {
      ...common,
      kind,
      payload: parseTypingPayload(row.payload),
    };
  }

  return {
    ...common,
    kind,
    payload: parseTelegramReactionPayload(row.payload),
  };
}

function buildClaimNextPendingActionQuery(tableName: string, useSkipLocked: boolean): string {
  return `
    SELECT *
    FROM ${tableName}
    WHERE channel = $1
      AND connector_key = $2
      AND status = 'pending'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
    FOR UPDATE${useSkipLocked ? " SKIP LOCKED" : ""}
  `;
}

function isSkipLockedSyntaxUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("skip locked")
    || message.includes("kw_skip")
    || message.includes("syntax error");
}

export class PostgresChannelActionStore {
  private readonly pool: PgPoolLike<PgListenClient>;
  private readonly notificationPool: PgPoolLike<PgListenClient>;
  private readonly tables: ChannelActionTableNames;
  private readonly notificationChannel: string;

  constructor(options: PostgresChannelActionStoreOptions) {
    this.pool = options.pool;
    this.notificationPool = options.notificationPool ?? options.pool;
    this.tables = buildChannelActionTableNames();
    this.notificationChannel = buildActionNotificationChannel();
  }

  private async notify(input: ActionNotification): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [
      this.notificationChannel,
      JSON.stringify(input),
    ]);
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresChannelActionSchema(this.pool);
  }

  async enqueueAction<K extends ChannelActionKind>(input: ChannelActionInput<K>): Promise<ChannelActionRecord<K>> {
    const channel = requireNonEmptyString(input.channel, "Channel action channel must not be empty.");
    const connectorKey = requireNonEmptyString(input.connectorKey, "Channel action connector key must not be empty.");
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.channelActions} (
        id,
        channel,
        connector_key,
        kind,
        payload,
        status
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        'pending'
      )
      RETURNING *
    `, [
      randomUUID(),
      channel,
      connectorKey,
      input.kind,
      JSON.stringify(input.payload),
    ]);
    const record = requireRecordKind(parseRecord(result.rows[0] as Record<string, unknown>), input.kind);
    await this.notify({
      channel: record.channel,
      connectorKey: record.connectorKey,
    });
    return record;
  }

  async claimNextPendingAction(lookup: ActionWorkerLookup): Promise<ChannelActionRecord | null> {
    const normalized = normalizeChannelWorkerLookup(lookup, "Channel action");
    const client = await this.pool.connect();

    try {
      // Real Postgres should skip already-locked rows so overlapping workers do not
      // stall on the same oldest pending action. pg-mem does not parse SKIP LOCKED,
      // so tests fall back to plain FOR UPDATE.
      for (const useSkipLocked of [true, false] as const) {
        let inTransaction = false;
        try {
          await client.query("BEGIN");
          inTransaction = true;

          const selectResult = await client.query(
            buildClaimNextPendingActionQuery(this.tables.channelActions, useSkipLocked),
            [
              normalized.channel,
              normalized.connectorKey,
            ],
          );
          const row = selectResult.rows[0];
          if (!row) {
            await client.query("COMMIT");
            return null;
          }
          const selected = parseRecord(row as Record<string, unknown>);

          const updateResult = await client.query(`
            UPDATE ${this.tables.channelActions}
            SET status = 'sending',
                attempt_count = attempt_count + 1,
                claimed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
          `, [selected.id]);

          await client.query("COMMIT");
          const updatedRow = updateResult.rows[0];
          return updatedRow ? parseRecord(updatedRow as Record<string, unknown>) : null;
        } catch (error) {
          if (inTransaction) {
            await client.query("ROLLBACK");
          }

          if (useSkipLocked && isSkipLockedSyntaxUnsupported(error)) {
            continue;
          }

          throw error;
        }
      }

      return null;
    } finally {
      client.release();
    }
  }

  async markActionSent(id: string): Promise<ChannelActionRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.channelActions}
      SET status = 'sent',
          completed_at = NOW(),
          updated_at = NOW(),
          last_error = NULL
      WHERE id = $1
      RETURNING *
    `, [requireNonEmptyString(id, "Channel action id must not be empty.")]);
    return parseRecord(result.rows[0] as Record<string, unknown>);
  }

  async markActionFailed(id: string, error: string): Promise<ChannelActionRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.channelActions}
      SET status = 'failed',
          completed_at = NOW(),
          updated_at = NOW(),
          last_error = $2
      WHERE id = $1
      RETURNING *
    `, [
      requireNonEmptyString(id, "Channel action id must not be empty."),
      error,
    ]);
    return parseRecord(result.rows[0] as Record<string, unknown>);
  }

  async failSendingActions(lookup: ActionWorkerLookup, error: string): Promise<number> {
    const normalized = normalizeChannelWorkerLookup(lookup, "Channel action");
    const result = await this.pool.query(`
      UPDATE ${this.tables.channelActions}
      SET status = 'failed',
          completed_at = NOW(),
          updated_at = NOW(),
          last_error = $3
      WHERE channel = $1
        AND connector_key = $2
        AND status = 'sending'
    `, [
      normalized.channel,
      normalized.connectorKey,
      error,
    ]);
    return result.rowCount ?? 0;
  }

  async listenPendingActions(
    listener: (notification: ActionNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    return listenPostgresChannel({
      pool: this.notificationPool,
      channel: this.notificationChannel,
      label: "Channel action notification listener",
      parse: (payload) => typeof payload === "string" ? parseActionNotification(payload) : null,
      listener,
    });
  }
}
