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
import type {
    ActionNotification,
    ActionWorkerLookup,
    ChannelActionInput,
    ChannelActionKind,
    ChannelActionRecord,
    ChannelActionStatus,
    DiscordStickerSendActionPayload,
    TelegramDeleteActionPayload,
    TelegramEditActionPayload,
    TelegramPinActionPayload,
    TelegramReactionActionPayload,
    TelegramStickerSendActionPayload,
    TelegramUnpinActionPayload,
} from "./types.js";
import {buildSessionTableNames, type SessionTableNames} from "../../sessions/postgres-shared.js";
import {buildThreadRuntimeTableNames, type ThreadRuntimeTableNames} from "../../threads/runtime/postgres-shared.js";
import {SessionArchivedError} from "../../threads/runtime/store.js";
import {withTransaction} from "../../../lib/postgres-transaction.js";

export interface PostgresChannelActionStoreOptions {
  pool: PgPoolLike<PgListenClient>;
  notificationPool?: PgPoolLike<PgListenClient>;
}

export const parseActionNotification: (payload: string) => ActionNotification | null = parseChannelNotification;

const ACTION_EXPIRED_BEFORE_DISPATCH_ERROR = "Action expired before dispatch.";
const MAX_CANDIDATES_PER_CLAIM = 100;

function parseKind(value: unknown): ChannelActionKind {
  if (
    value === "typing"
    || value === "telegram_reaction"
    || value === "telegram_edit"
    || value === "telegram_delete"
    || value === "telegram_pin"
    || value === "telegram_unpin"
    || value === "telegram_sticker_send"
    || value === "discord_sticker_send"
  ) {
    return value;
  }

  throw new Error(`Unsupported channel action kind ${String(value)}.`);
}

function parseStatus(value: unknown): ChannelActionStatus {
  if (
    value === "pending"
    || value === "sending"
    || value === "sent"
    || value === "failed"
    || value === "expired"
    || value === "unknown"
  ) {
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

function readOptionalPayloadTimestamp(
  kind: ChannelActionKind,
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Channel action ${kind} payload ${field} must be a finite timestamp.`);
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
  const expiresAt = readOptionalPayloadTimestamp(kind, payload.expiresAt, "expiry");
  return {
    ...(typeof payload.threadId === "string" ? {threadId: payload.threadId} : {}),
    channel: readRequiredPayloadString(kind, payload.channel, "channel"),
    phase,
    ...(expiresAt !== undefined ? {expiresAt} : {}),
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

function parseTelegramEditPayload(value: unknown): TelegramEditActionPayload {
  const kind = "telegram_edit";
  const payload = readPayloadRecord(kind, value);
  return {
    conversationId: readRequiredPayloadString(kind, payload.conversationId, "conversation id"),
    messageId: readRequiredPayloadString(kind, payload.messageId, "message id"),
    text: readRequiredPayloadString(kind, payload.text, "text"),
  };
}

function parseTelegramDeletePayload(value: unknown): TelegramDeleteActionPayload {
  const kind = "telegram_delete";
  const payload = readPayloadRecord(kind, value);
  return {
    conversationId: readRequiredPayloadString(kind, payload.conversationId, "conversation id"),
    messageId: readRequiredPayloadString(kind, payload.messageId, "message id"),
  };
}

function parseTelegramPinPayload(value: unknown): TelegramPinActionPayload {
  const kind = "telegram_pin";
  const payload = readPayloadRecord(kind, value);
  const silent = readOptionalPayloadBoolean(kind, payload.silent, "silent");
  return {
    conversationId: readRequiredPayloadString(kind, payload.conversationId, "conversation id"),
    messageId: readRequiredPayloadString(kind, payload.messageId, "message id"),
    ...(silent !== undefined ? {silent} : {}),
  };
}

function parseTelegramUnpinPayload(value: unknown): TelegramUnpinActionPayload {
  const kind = "telegram_unpin";
  const payload = readPayloadRecord(kind, value);
  return {
    conversationId: readRequiredPayloadString(kind, payload.conversationId, "conversation id"),
    messageId: readRequiredPayloadString(kind, payload.messageId, "message id"),
  };
}

function parseTelegramStickerSendPayload(value: unknown): TelegramStickerSendActionPayload {
  const kind = "telegram_sticker_send";
  const payload = readPayloadRecord(kind, value);
  const sticker = payload.sticker;
  if (!isRecord(sticker)) {
    throw new Error("Channel action telegram_sticker_send payload sticker must be a JSON object.");
  }

  if (sticker.type === "file") {
    return {
      conversationId: readRequiredPayloadString(kind, payload.conversationId, "conversation id"),
      sticker: {
        type: "file",
        path: readRequiredPayloadString(kind, sticker.path, "sticker path"),
      },
    };
  }

  if (sticker.type === "file_id") {
    return {
      conversationId: readRequiredPayloadString(kind, payload.conversationId, "conversation id"),
      sticker: {
        type: "file_id",
        fileId: readRequiredPayloadString(kind, sticker.fileId, "sticker file id"),
      },
    };
  }

  throw new Error(`Channel action telegram_sticker_send payload sticker type is invalid: ${String(sticker.type)}.`);
}

function parseDiscordStickerSendPayload(value: unknown): DiscordStickerSendActionPayload {
  const kind = "discord_sticker_send";
  const payload = readPayloadRecord(kind, value);
  if (!Array.isArray(payload.stickerIds) || payload.stickerIds.length < 1 || payload.stickerIds.length > 3) {
    throw new Error("Channel action discord_sticker_send payload sticker ids must contain 1-3 entries.");
  }
  const threadId = readOptionalPayloadString(kind, payload.threadId, "thread id");
  const guildId = readOptionalPayloadString(kind, payload.guildId, "guild id");
  const replyToMessageId = readOptionalPayloadString(kind, payload.replyToMessageId, "reply message id");
  return {
    parentChannelId: readRequiredPayloadString(kind, payload.parentChannelId, "parent channel id"),
    ...(threadId ? {threadId} : {}),
    ...(guildId ? {guildId} : {}),
    ...(replyToMessageId ? {replyToMessageId} : {}),
    stickerIds: payload.stickerIds.map((id) => readRequiredPayloadString(kind, id, "sticker id")),
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
    sessionId: readOptionalRowString(row.session_id, "session id"),
    threadId: readOptionalRowString(row.thread_id, "thread id"),
    channel: requireNonEmptyString(row.channel, "Channel action channel must not be empty."),
    connectorKey: requireNonEmptyString(row.connector_key, "Channel action connector key must not be empty."),
    status: parseStatus(row.status),
    attemptCount: requireNonNegativeInteger(row.attempt_count, "Channel action attempt count"),
    lastError: readOptionalRowString(row.last_error, "last error"),
    claimToken: readOptionalRowString(row.claim_token, "claim token"),
    claimedAt: optionalTimestampMillis(row.claimed_at, "Channel action claimed_at must be a finite timestamp."),
    completedAt: optionalTimestampMillis(row.completed_at, "Channel action completed_at must be a finite timestamp."),
    expiresAt: optionalTimestampMillis(row.expires_at, "Channel action expires_at must be a finite timestamp."),
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

  if (kind === "telegram_edit") {
    return {
      ...common,
      kind,
      payload: parseTelegramEditPayload(row.payload),
    };
  }

  if (kind === "telegram_delete") {
    return {
      ...common,
      kind,
      payload: parseTelegramDeletePayload(row.payload),
    };
  }

  if (kind === "telegram_pin") {
    return {
      ...common,
      kind,
      payload: parseTelegramPinPayload(row.payload),
    };
  }

  if (kind === "telegram_unpin") {
    return {
      ...common,
      kind,
      payload: parseTelegramUnpinPayload(row.payload),
    };
  }

  if (kind === "telegram_sticker_send") {
    return {
      ...common,
      kind,
      payload: parseTelegramStickerSendPayload(row.payload),
    };
  }

  if (kind === "discord_sticker_send") {
    return {
      ...common,
      kind,
      payload: parseDiscordStickerSendPayload(row.payload),
    };
  }

  return {
    ...common,
    kind,
    payload: parseTelegramReactionPayload(row.payload),
  };
}

function buildLockPendingActionQuery(tableName: string, useSkipLocked: boolean): string {
  return `
    SELECT *
    FROM ${tableName}
    WHERE id = $1
      AND status = 'pending'
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
  private readonly sessionTables: SessionTableNames;
  private readonly threadTables: ThreadRuntimeTableNames;
  private readonly notificationChannel: string;

  constructor(options: PostgresChannelActionStoreOptions) {
    this.pool = options.pool;
    this.notificationPool = options.notificationPool ?? options.pool;
    this.tables = buildChannelActionTableNames();
    this.sessionTables = buildSessionTableNames();
    this.threadTables = buildThreadRuntimeTableNames();
    this.notificationChannel = buildActionNotificationChannel();
  }

  private async notify(input: ActionNotification): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [
      this.notificationChannel,
      JSON.stringify(input),
    ]);
  }

  private normalizeExpiration(expiresAt: number | undefined): string | null {
    if (expiresAt === undefined) return null;
    if (!Number.isFinite(expiresAt)) {
      throw new Error("Channel action expiresAt must be a finite timestamp.");
    }
    return new Date(expiresAt).toISOString();
  }

  async enqueueAction<K extends ChannelActionKind>(input: ChannelActionInput<K>): Promise<ChannelActionRecord<K>> {
    const channel = requireNonEmptyString(input.channel, "Channel action channel must not be empty.");
    const connectorKey = requireNonEmptyString(input.connectorKey, "Channel action connector key must not be empty.");
    const expiration = this.normalizeExpiration(input.expiresAt);
    if (!input.sessionId && !input.threadId) {
      const global = await this.pool.query(`
        INSERT INTO ${this.tables.channelActions} (
          id, channel, connector_key, kind, payload, expires_at,
          status, last_error, completed_at
        ) VALUES (
          $1, $2, $3, $4, $5::jsonb, $6::timestamptz,
          CASE WHEN $6::timestamptz <= NOW() THEN 'expired' ELSE 'pending' END,
          CASE WHEN $6::timestamptz <= NOW() THEN '${ACTION_EXPIRED_BEFORE_DISPATCH_ERROR}' END,
          CASE WHEN $6::timestamptz <= NOW() THEN NOW() END
        )
        RETURNING *
      `, [
        randomUUID(),
        channel,
        connectorKey,
        input.kind,
        JSON.stringify(input.payload),
        expiration,
      ]);
      const record = requireRecordKind(parseRecord(global.rows[0] as Record<string, unknown>), input.kind);
      if (record.status === "pending") {
        await this.notify({channel: record.channel, connectorKey: record.connectorKey});
      }
      return record;
    }
    const record = await withTransaction(this.pool, async (client) => {
      const owner = await client.query(`
        SELECT COALESCE($1::text, thread.session_id) AS session_id,
               thread.session_id AS thread_session_id
        FROM (SELECT 1) AS singleton
        LEFT JOIN ${this.threadTables.threads} AS thread ON thread.id = $2
      `, [input.sessionId ?? null, input.threadId ?? null]);
      const ownerRow = owner.rows[0] as {session_id?: unknown; thread_session_id?: unknown} | undefined;
      if (typeof ownerRow?.session_id !== "string") throw new Error("Channel action session/thread ownership is invalid.");
      if (input.threadId && ownerRow.thread_session_id !== ownerRow.session_id) {
        throw new Error("Channel action thread belongs to another session.");
      }
      const lifecycle = await client.query(`
        SELECT archived_at FROM ${this.sessionTables.sessions} WHERE id = $1 FOR UPDATE
      `, [ownerRow.session_id]);
      const lifecycleRow = lifecycle.rows[0] as {archived_at?: unknown} | undefined;
      if (!lifecycleRow) throw new Error(`Unknown session ${ownerRow.session_id}`);
      if (lifecycleRow.archived_at !== null) throw new SessionArchivedError(ownerRow.session_id);
      const result = await client.query(`
        INSERT INTO ${this.tables.channelActions} (
          id, session_id, thread_id, channel, connector_key, kind, payload,
          expires_at, status, last_error, completed_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz,
          CASE WHEN $8::timestamptz <= NOW() THEN 'expired' ELSE 'pending' END,
          CASE WHEN $8::timestamptz <= NOW() THEN '${ACTION_EXPIRED_BEFORE_DISPATCH_ERROR}' END,
          CASE WHEN $8::timestamptz <= NOW() THEN NOW() END
        )
        RETURNING *
      `, [
        randomUUID(),
        ownerRow.session_id,
        input.threadId ?? null,
        channel,
        connectorKey,
        input.kind,
        JSON.stringify(input.payload),
        expiration,
      ]);
      return requireRecordKind(parseRecord(result.rows[0] as Record<string, unknown>), input.kind);
    });
    if (record.status === "pending") {
      await this.notify({
        channel: record.channel,
        connectorKey: record.connectorKey,
      });
    }
    return record;
  }

  async claimNextPendingAction(lookup: ActionWorkerLookup): Promise<ChannelActionRecord | null> {
    const normalized = normalizeChannelWorkerLookup(lookup, "Channel action");
    // Idle reconciliation is the common path; avoid a three-statement
    // transaction and pool checkout when the indexed queue is empty.
    const pending = await this.pool.query(`
      SELECT 1
      FROM ${this.tables.channelActions}
      WHERE channel = $1
        AND connector_key = $2
        AND status = 'pending'
      LIMIT 1
    `, [normalized.channel, normalized.connectorKey]);
    if (!pending.rows[0]) return null;

    const client = await this.pool.connect();

    try {
      let useSkipLocked = true;
      let candidatesProcessed = 0;
      while (candidatesProcessed < MAX_CANDIDATES_PER_CLAIM) {
        let retryCandidate = true;
        while (retryCandidate) {
          retryCandidate = false;
          let inTransaction = false;
          try {
            await client.query("BEGIN");
            inTransaction = true;

            // Session lifecycle owns the session -> action lock order. Choose the
            // candidate first, then preserve that order before locking the row.
            const candidateResult = await client.query(`
              SELECT id, session_id,
                     expires_at IS NOT NULL AND expires_at <= NOW() AS deadline_expired
              FROM ${this.tables.channelActions}
              WHERE channel = $1
                AND connector_key = $2
                AND status = 'pending'
              ORDER BY created_at ASC, id ASC
              LIMIT 1
            `, [normalized.channel, normalized.connectorKey]);
            const candidate = candidateResult.rows[0] as Record<string, unknown> | undefined;
            if (!candidate || typeof candidate.id !== "string") {
              await client.query("COMMIT");
              return null;
            }
            candidatesProcessed += 1;
            if (candidate.deadline_expired === true) {
              await client.query(`
                UPDATE ${this.tables.channelActions}
                SET status = 'expired',
                    last_error = '${ACTION_EXPIRED_BEFORE_DISPATCH_ERROR}',
                    completed_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                  AND status = 'pending'
                  AND expires_at IS NOT NULL
                  AND expires_at <= NOW()
              `, [candidate.id]);
              await client.query("COMMIT");
              continue;
            }
            if (typeof candidate.session_id === "string") {
              const active = await client.query(`
                SELECT id FROM ${this.sessionTables.sessions}
                WHERE id = $1 AND archived_at IS NULL
                FOR UPDATE
              `, [candidate.session_id]);
              if (!active.rows[0]) {
                await client.query(`
                  UPDATE ${this.tables.channelActions}
                  SET status = 'failed', last_error = 'Session archived.', completed_at = NOW(), updated_at = NOW()
                  WHERE id = $1 AND status = 'pending'
                `, [candidate.id]);
                await client.query("COMMIT");
                continue;
              }
            }
            const locked = await client.query(
              buildLockPendingActionQuery(this.tables.channelActions, useSkipLocked),
              [candidate.id],
            );
            const lockedRow = locked.rows[0];
            if (!lockedRow) {
              await client.query("COMMIT");
              return null;
            }
            const selected = parseRecord(lockedRow as Record<string, unknown>);

            const updateResult = await client.query(`
              UPDATE ${this.tables.channelActions}
              SET status = 'sending',
                  claim_token = $2,
                  attempt_count = attempt_count + 1,
                  claimed_at = NOW(),
                  updated_at = NOW()
              WHERE id = $1
                AND status = 'pending'
                AND (expires_at IS NULL OR expires_at > NOW())
              RETURNING *
            `, [selected.id, randomUUID()]);
            const updatedRow = updateResult.rows[0];
            if (!updatedRow) {
              await client.query("COMMIT");
              continue;
            }

            await client.query("COMMIT");
            return parseRecord(updatedRow as Record<string, unknown>);
          } catch (error) {
            if (inTransaction) {
              await client.query("ROLLBACK");
            }

            if (useSkipLocked && isSkipLockedSyntaxUnsupported(error)) {
              useSkipLocked = false;
              retryCandidate = true;
              continue;
            }

            throw error;
          }
        }
      }

      return null;
    } finally {
      client.release();
    }
  }

  async getAction(id: string): Promise<ChannelActionRecord> {
    const result = await this.pool.query(`
      SELECT * FROM ${this.tables.channelActions} WHERE id = $1
    `, [requireNonEmptyString(id, "Channel action id must not be empty.")]);
    if (!result.rows[0]) throw new Error(`Unknown channel action ${id}.`);
    return parseRecord(result.rows[0] as Record<string, unknown>);
  }

  async markActionSent(id: string, claimToken: string): Promise<ChannelActionRecord> {
    return this.settleAction(id, claimToken, "sent", null);
  }

  async markActionFailed(id: string, claimToken: string, error: string): Promise<ChannelActionRecord> {
    return this.settleAction(id, claimToken, "failed", error);
  }

  private async settleAction(
    id: string,
    claimToken: string,
    status: "sent" | "failed",
    error: string | null,
  ): Promise<ChannelActionRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.channelActions}
      SET status = $3, completed_at = NOW(), updated_at = NOW(), last_error = $4
      WHERE id = $1 AND claim_token = $2 AND status IN ('sending', 'unknown')
      RETURNING *
    `, [
      requireNonEmptyString(id, "Channel action id must not be empty."),
      requireNonEmptyString(claimToken, "Channel action claim token must not be empty."),
      status,
      error,
    ]);
    const action = result.rows[0]
      ? parseRecord(result.rows[0] as Record<string, unknown>)
      : await this.getAction(id);
    if (action.claimToken !== claimToken || action.status !== status) {
      throw new Error(`Channel action ${id} no longer owns the ${status} receipt.`);
    }
    return action;
  }

  async markActionUnknown(id: string, claimToken: string, error: string): Promise<ChannelActionRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.channelActions}
      SET status = 'unknown', completed_at = NOW(), updated_at = NOW(), last_error = $3
      WHERE id = $1 AND claim_token = $2 AND status = 'sending'
      RETURNING *
    `, [
      requireNonEmptyString(id, "Channel action id must not be empty."),
      requireNonEmptyString(claimToken, "Channel action claim token must not be empty."),
      error,
    ]);
    return result.rows[0]
      ? parseRecord(result.rows[0] as Record<string, unknown>)
      : this.getAction(id);
  }

  async expireActionIfDue(id: string, claimToken: string): Promise<ChannelActionRecord | null> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.channelActions}
      SET status = 'expired',
          attempt_count = GREATEST(attempt_count - 1, 0),
          claimed_at = NULL, claim_token = NULL,
          completed_at = NOW(), updated_at = NOW(),
          last_error = '${ACTION_EXPIRED_BEFORE_DISPATCH_ERROR}'
      WHERE id = $1 AND claim_token = $2 AND status = 'sending'
        AND expires_at IS NOT NULL AND expires_at <= NOW()
      RETURNING *
    `, [
      requireNonEmptyString(id, "Channel action id must not be empty."),
      requireNonEmptyString(claimToken, "Channel action claim token must not be empty."),
    ]);
    return result.rows[0] ? parseRecord(result.rows[0] as Record<string, unknown>) : null;
  }

  async markSendingActionsUnknown(lookup: ActionWorkerLookup, error: string): Promise<number> {
    const normalized = normalizeChannelWorkerLookup(lookup, "Channel action");
    const result = await this.pool.query(`
      UPDATE ${this.tables.channelActions}
      SET status = 'unknown', completed_at = NOW(), updated_at = NOW(), last_error = $3
      WHERE channel = $1 AND connector_key = $2 AND status = 'sending'
    `, [normalized.channel, normalized.connectorKey, error]);
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
