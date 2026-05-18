import {optionalTimestampMillis, requireTimestampMillis, toJson} from "../../../lib/postgres-values.js";
import {randomUUID} from "node:crypto";

import {readOptionalJsonValue} from "../../../lib/json.js";
import {listenPostgresChannel} from "../../../lib/postgres-listen.js";
import {requireNonNegativeInteger} from "../../../lib/numbers.js";
import type {PgListenClient, PgPoolLike} from "../../../lib/postgres-query.js";
import {isRecord} from "../../../lib/records.js";
import {optionalTrimmedString, requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {normalizeChannelWorkerLookup, parseChannelNotification} from "../worker-shared.js";
import type {OutboundItem, OutboundSentItem, OutboundTarget} from "../types.js";
import {
    buildDeliveryNotificationChannel,
    buildOutboundDeliveryTableNames,
    type OutboundDeliveryTableNames,
} from "./postgres-shared.js";
import {ensurePostgresOutboundDeliverySchema} from "./postgres-schema.js";
import type {
    CompleteDeliveryInput,
    DeliveryNotification,
    DeliveryWorkerLookup,
    FailDeliveryInput,
    OutboundDeliveryInput,
    OutboundDeliveryRecord,
    OutboundDeliveryStatus,
} from "./types.js";

export interface PostgresOutboundDeliveryStoreOptions {
  pool: PgPoolLike<PgListenClient>;
  notificationPool?: PgPoolLike<PgListenClient>;
}

function missingDeliveryError(id: string): Error {
  return new Error(`Unknown outbound delivery ${id}`);
}

function normalizeTarget(channel: string, target: OutboundTarget): OutboundTarget {
  return {
    source: requireNonEmptyString(target.source || channel, "Outbound delivery target source must not be empty."),
    connectorKey: requireNonEmptyString(target.connectorKey, "Outbound delivery target connector key must not be empty."),
    externalConversationId: requireNonEmptyString(target.externalConversationId, "Outbound delivery target conversation id must not be empty."),
    externalActorId: trimToUndefined(target.externalActorId),
    replyToMessageId: trimToUndefined(target.replyToMessageId),
  };
}

function normalizeDeliveryInput(input: OutboundDeliveryInput): OutboundDeliveryInput {
  const channel = requireNonEmptyString(input.channel, "Outbound delivery channel must not be empty.");
  return {
    ...input,
    threadId: trimToUndefined(input.threadId),
    channel,
    target: normalizeTarget(channel, input.target),
    items: parseItems(input.items),
    metadata: readOptionalJsonValue(input.metadata, "Outbound delivery metadata"),
  };
}

function parseStatus(value: unknown): OutboundDeliveryStatus {
  if (value === "pending" || value === "sending" || value === "sent" || value === "failed") {
    return value;
  }

  throw new Error(`Unsupported outbound delivery status ${String(value)}.`);
}

function readOptionalString(value: unknown, field: string): string | undefined {
  return optionalTrimmedString(value, `Outbound delivery ${field} must be a string.`);
}

function parseSentItems(value: unknown): readonly OutboundSentItem[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error("Outbound delivery sent items must be an array.");
  }

  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Outbound delivery sent item must be a JSON object.");
    }

    const type = item.type;
    if (type !== "text" && type !== "image" && type !== "file") {
      throw new Error(`Outbound delivery sent item type is invalid: ${String(type)}.`);
    }

    return {
      type,
      externalMessageId: requireNonEmptyString(
        item.externalMessageId,
        "Outbound delivery sent item external message id must not be empty.",
      ),
    };
  });
}

function parseItems(value: unknown): readonly OutboundItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Outbound delivery items are missing or invalid.");
  }

  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Outbound delivery item must be a JSON object.");
    }

    switch (item.type) {
      case "text":
        if (typeof item.text !== "string") {
          throw new Error("Outbound delivery text item text must be a string.");
        }

        return {
          type: "text",
          text: item.text,
        };
      case "image": {
        const caption = readOptionalString(item.caption, "image item caption");
        return {
          type: "image",
          path: requireNonEmptyString(item.path, "Outbound delivery image item path must not be empty."),
          ...(caption ? {caption} : {}),
        };
      }
      case "file": {
        const filename = readOptionalString(item.filename, "file item filename");
        const caption = readOptionalString(item.caption, "file item caption");
        const mimeType = readOptionalString(item.mimeType, "file item MIME type");
        return {
          type: "file",
          path: requireNonEmptyString(item.path, "Outbound delivery file item path must not be empty."),
          ...(filename ? {filename} : {}),
          ...(caption ? {caption} : {}),
          ...(mimeType ? {mimeType} : {}),
        };
      }
      default:
        throw new Error(`Outbound delivery item type is invalid: ${String(item.type)}.`);
    }
  });
}

function parseTarget(row: Record<string, unknown>): OutboundTarget {
  return {
    source: requireNonEmptyString(row.channel, "Outbound delivery target source must not be empty."),
    connectorKey: requireNonEmptyString(row.connector_key, "Outbound delivery target connector key must not be empty."),
    externalConversationId: requireNonEmptyString(
      row.external_conversation_id,
      "Outbound delivery target conversation id must not be empty.",
    ),
    externalActorId: readOptionalString(row.external_actor_id, "target actor id"),
    replyToMessageId: readOptionalString(row.reply_to_message_id, "reply target message id"),
  };
}

function parseOutboundDeliveryRow(row: Record<string, unknown>): OutboundDeliveryRecord {
  return {
    id: requireNonEmptyString(row.id, "Outbound delivery id must not be empty."),
    threadId: readOptionalString(row.thread_id, "thread id"),
    channel: requireNonEmptyString(row.channel, "Outbound delivery channel must not be empty."),
    target: parseTarget(row),
    items: parseItems(row.items),
    metadata: readOptionalJsonValue(row.metadata, "Outbound delivery metadata"),
    status: parseStatus(row.status),
    attemptCount: requireNonNegativeInteger(row.attempt_count, "Outbound delivery attempt count"),
    lastError: readOptionalString(row.last_error, "last error"),
    sent: parseSentItems(row.sent_items),
    claimedAt: optionalTimestampMillis(row.claimed_at, "Outbound delivery claimed_at must be a finite timestamp."),
    completedAt: optionalTimestampMillis(row.completed_at, "Outbound delivery completed_at must be a finite timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "Outbound delivery created_at must be a finite timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Outbound delivery updated_at must be a finite timestamp."),
  };
}

export const parseDeliveryNotification: (payload: string) => DeliveryNotification | null = parseChannelNotification;

export class PostgresOutboundDeliveryStore {
  private readonly pool: PgPoolLike<PgListenClient>;
  private readonly notificationPool: PgPoolLike<PgListenClient>;
  private readonly tables: OutboundDeliveryTableNames;
  private readonly notificationChannel: string;

  constructor(options: PostgresOutboundDeliveryStoreOptions) {
    this.pool = options.pool;
    this.notificationPool = options.notificationPool ?? options.pool;
    this.tables = buildOutboundDeliveryTableNames();
    this.notificationChannel = buildDeliveryNotificationChannel();
  }

  private async notifyPendingDelivery(target: Pick<OutboundTarget, "connectorKey"> & { source: string }): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [
      this.notificationChannel,
      JSON.stringify({
        channel: target.source,
        connectorKey: target.connectorKey,
      } satisfies DeliveryNotification),
    ]);
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresOutboundDeliverySchema(this.pool);
  }

  async enqueueDelivery(input: OutboundDeliveryInput): Promise<OutboundDeliveryRecord> {
    const normalizedInput = normalizeDeliveryInput(input);
    const result = await this.pool.query(
      `
        INSERT INTO ${this.tables.outboundDeliveries} (
          id,
          thread_id,
          channel,
          connector_key,
          external_conversation_id,
          external_actor_id,
          reply_to_message_id,
          items,
          metadata,
          status
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8::jsonb,
          $9::jsonb,
          'pending'
        )
        RETURNING *
      `,
      [
        randomUUID(),
        normalizedInput.threadId ?? null,
        normalizedInput.channel,
        normalizedInput.target.connectorKey,
        normalizedInput.target.externalConversationId,
        normalizedInput.target.externalActorId ?? null,
        normalizedInput.target.replyToMessageId ?? null,
        JSON.stringify(normalizedInput.items),
        toJson(normalizedInput.metadata),
      ],
    );

    const delivery = parseOutboundDeliveryRow(result.rows[0] as Record<string, unknown>);
    await this.notifyPendingDelivery(delivery.target);
    return delivery;
  }

  async getDelivery(id: string): Promise<OutboundDeliveryRecord> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.outboundDeliveries}
        WHERE id = $1
      `,
      [requireNonEmptyString(id, "Outbound delivery id must not be empty.")],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingDeliveryError(id);
    }

    return parseOutboundDeliveryRow(row as Record<string, unknown>);
  }

  async claimNextPendingDelivery(lookup: DeliveryWorkerLookup): Promise<OutboundDeliveryRecord | null> {
    const normalizedLookup = normalizeChannelWorkerLookup(lookup, "Outbound delivery");
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const selectResult = await client.query(
        `
          SELECT *
          FROM ${this.tables.outboundDeliveries}
          WHERE channel = $1
            AND connector_key = $2
            AND status = 'pending'
          ORDER BY created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE
        `,
        [
          normalizedLookup.channel,
          normalizedLookup.connectorKey,
        ],
      );
      const row = selectResult.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      const selected = parseOutboundDeliveryRow(row as Record<string, unknown>);

      const updateResult = await client.query(
        `
          UPDATE ${this.tables.outboundDeliveries}
          SET status = 'sending',
              attempt_count = attempt_count + 1,
              claimed_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [selected.id],
      );

      await client.query("COMMIT");
      inTransaction = false;
      return parseOutboundDeliveryRow(updateResult.rows[0] as Record<string, unknown>);
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async markDeliverySent(input: CompleteDeliveryInput): Promise<OutboundDeliveryRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.outboundDeliveries}
        SET status = 'sent',
            sent_items = $2::jsonb,
            last_error = NULL,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        requireNonEmptyString(input.id, "Outbound delivery id must not be empty."),
        JSON.stringify(input.sent),
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw missingDeliveryError(input.id);
    }

    return parseOutboundDeliveryRow(row as Record<string, unknown>);
  }

  async markDeliveryFailed(input: FailDeliveryInput): Promise<OutboundDeliveryRecord> {
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.outboundDeliveries}
        SET status = 'failed',
            last_error = $2,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        requireNonEmptyString(input.id, "Outbound delivery id must not be empty."),
        requireNonEmptyString(input.error, "Outbound delivery error must not be empty."),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingDeliveryError(input.id);
    }

    return parseOutboundDeliveryRow(row as Record<string, unknown>);
  }

  async failSendingDeliveries(lookup: DeliveryWorkerLookup, error: string): Promise<number> {
    const normalizedLookup = normalizeChannelWorkerLookup(lookup, "Outbound delivery");
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.outboundDeliveries}
        SET status = 'failed',
            last_error = $3,
            completed_at = COALESCE(completed_at, NOW()),
            updated_at = NOW()
        WHERE channel = $1
          AND connector_key = $2
          AND status = 'sending'
      `,
      [
        normalizedLookup.channel,
        normalizedLookup.connectorKey,
        requireNonEmptyString(error, "Outbound delivery error must not be empty."),
      ],
    );

    return result.rowCount ?? 0;
  }

  async listenPendingDeliveries(
    listener: (notification: DeliveryNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    return listenPostgresChannel({
      pool: this.notificationPool,
      channel: this.notificationChannel,
      label: "Outbound delivery notification listener",
      parse: (payload) => typeof payload === "string" ? parseDeliveryNotification(payload) : null,
      listener,
    });
  }
}
