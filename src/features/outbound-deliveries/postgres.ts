import {randomUUID} from "node:crypto";

import type {Pool, PoolClient} from "pg";

import {quoteIdentifier, toJson, toMillis,} from "../thread-runtime/postgres-shared.js";
import type {OutboundItem, OutboundSentItem, OutboundTarget} from "../channels/core/types.js";
import type {OutboundDeliveryStore} from "./store.js";
import {
    buildOutboundDeliveryNotificationChannel,
    buildOutboundDeliveryTableNames,
    type OutboundDeliveryTableNames,
} from "./postgres-shared.js";
import type {
    CompleteOutboundDeliveryInput,
    CreateOutboundDeliveryInput,
    FailOutboundDeliveryInput,
    OutboundDeliveryNotification,
    OutboundDeliveryRecord,
    OutboundDeliveryWorkerLookup,
} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface PostgresOutboundDeliveryStoreOptions {
  pool: PgPoolLike;
  tablePrefix?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingDeliveryError(id: string): Error {
  return new Error(`Unknown outbound delivery ${id}`);
}

function requireTrimmed(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Outbound delivery ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeWorkerLookup(lookup: OutboundDeliveryWorkerLookup): OutboundDeliveryWorkerLookup {
  return {
    channel: requireTrimmed("channel", lookup.channel),
    connectorKey: requireTrimmed("connector key", lookup.connectorKey),
  };
}

function normalizeTarget(channel: string, target: OutboundTarget): OutboundTarget {
  return {
    source: requireTrimmed("target source", target.source || channel),
    connectorKey: requireTrimmed("target connector key", target.connectorKey),
    externalConversationId: requireTrimmed("target conversation id", target.externalConversationId),
    externalActorId: target.externalActorId?.trim() || undefined,
    replyToMessageId: target.replyToMessageId?.trim() || undefined,
  };
}

function normalizeCreateInput(input: CreateOutboundDeliveryInput): CreateOutboundDeliveryInput {
  const channel = requireTrimmed("channel", input.channel);
  return {
    ...input,
    threadId: requireTrimmed("thread id", input.threadId),
    channel,
    target: normalizeTarget(channel, input.target),
  };
}

function parseSentItems(value: unknown): readonly OutboundSentItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.type !== "string" || typeof item.externalMessageId !== "string") {
      return [];
    }

    return [{
      type: item.type as OutboundSentItem["type"],
      externalMessageId: item.externalMessageId,
    }];
  });
}

function parseItems(value: unknown): readonly OutboundItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Outbound delivery items are missing or invalid.");
  }

  return value as readonly OutboundItem[];
}

function parseTarget(row: Record<string, unknown>): OutboundTarget {
  return {
    source: String(row.channel),
    connectorKey: String(row.connector_key),
    externalConversationId: String(row.external_conversation_id),
    externalActorId: typeof row.external_actor_id === "string" ? row.external_actor_id : undefined,
    replyToMessageId: typeof row.reply_to_message_id === "string" ? row.reply_to_message_id : undefined,
  };
}

function parseOutboundDeliveryRow(row: Record<string, unknown>): OutboundDeliveryRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    channel: String(row.channel),
    target: parseTarget(row),
    items: parseItems(row.items),
    metadata: row.metadata === null ? undefined : (row.metadata as OutboundDeliveryRecord["metadata"]),
    status: String(row.status) as OutboundDeliveryRecord["status"],
    attemptCount: Number(row.attempt_count),
    lastError: typeof row.last_error === "string" ? row.last_error : undefined,
    sent: parseSentItems(row.sent_items),
    claimedAt: row.claimed_at === null ? undefined : toMillis(row.claimed_at),
    completedAt: row.completed_at === null ? undefined : toMillis(row.completed_at),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export function parseOutboundDeliveryNotification(payload: string): OutboundDeliveryNotification | null {
  try {
    const parsed = JSON.parse(payload) as Partial<OutboundDeliveryNotification>;
    if (!parsed || typeof parsed.channel !== "string" || typeof parsed.connectorKey !== "string") {
      return null;
    }

    return {
      channel: parsed.channel,
      connectorKey: parsed.connectorKey,
    };
  } catch {
    return null;
  }
}

export class PostgresOutboundDeliveryStore implements OutboundDeliveryStore {
  private readonly pool: PgPoolLike;
  private readonly tables: OutboundDeliveryTableNames;
  private readonly notificationChannel: string;

  constructor(options: PostgresOutboundDeliveryStoreOptions) {
    this.pool = options.pool;
    const prefix = options.tablePrefix ?? "thread_runtime";
    this.tables = buildOutboundDeliveryTableNames(prefix);
    this.notificationChannel = buildOutboundDeliveryNotificationChannel(prefix);
  }

  private async notifyPendingDelivery(target: Pick<OutboundTarget, "connectorKey"> & { source: string }): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [
      this.notificationChannel,
      JSON.stringify({
        channel: target.source,
        connectorKey: target.connectorKey,
      } satisfies OutboundDeliveryNotification),
    ]);
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.outboundDeliveries} (
        id UUID PRIMARY KEY,
        thread_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        external_actor_id TEXT,
        reply_to_message_id TEXT,
        items JSONB NOT NULL,
        metadata JSONB,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        sent_items JSONB,
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_outbound_deliveries_pending_idx`)}
      ON ${this.tables.outboundDeliveries} (channel, connector_key, status, created_at, id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_outbound_deliveries_thread_idx`)}
      ON ${this.tables.outboundDeliveries} (thread_id, created_at DESC)
    `);
  }

  async enqueueDelivery(input: CreateOutboundDeliveryInput): Promise<OutboundDeliveryRecord> {
    const normalizedInput = normalizeCreateInput(input);
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
        normalizedInput.threadId,
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
      [requireTrimmed("id", id)],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingDeliveryError(id);
    }

    return parseOutboundDeliveryRow(row as Record<string, unknown>);
  }

  async claimNextPendingDelivery(lookup: OutboundDeliveryWorkerLookup): Promise<OutboundDeliveryRecord | null> {
    const normalizedLookup = normalizeWorkerLookup(lookup);
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
        [String((row as Record<string, unknown>).id)],
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

  async markDeliverySent(input: CompleteOutboundDeliveryInput): Promise<OutboundDeliveryRecord> {
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
        requireTrimmed("id", input.id),
        JSON.stringify(input.sent),
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw missingDeliveryError(input.id);
    }

    return parseOutboundDeliveryRow(row as Record<string, unknown>);
  }

  async markDeliveryFailed(input: FailOutboundDeliveryInput): Promise<OutboundDeliveryRecord> {
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
        requireTrimmed("id", input.id),
        requireTrimmed("error", input.error),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingDeliveryError(input.id);
    }

    return parseOutboundDeliveryRow(row as Record<string, unknown>);
  }

  async failSendingDeliveries(lookup: OutboundDeliveryWorkerLookup, error: string): Promise<number> {
    const normalizedLookup = normalizeWorkerLookup(lookup);
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
        requireTrimmed("error", error),
      ],
    );

    return result.rowCount ?? 0;
  }

  async listenPendingDeliveries(
    listener: (notification: OutboundDeliveryNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    const client = await this.pool.connect();

    const handleNotification = (message: { channel: string; payload?: string }) => {
      if (message.channel !== this.notificationChannel || typeof message.payload !== "string") {
        return;
      }

      const parsed = parseOutboundDeliveryNotification(message.payload);
      if (!parsed) {
        return;
      }

      void listener(parsed);
    };

    client.on("notification", handleNotification);
    await client.query(`LISTEN ${this.notificationChannel}`);

    return async () => {
      client.off("notification", handleNotification);
      try {
        await client.query(`UNLISTEN ${this.notificationChannel}`);
      } finally {
        client.release();
      }
    };
  }
}
