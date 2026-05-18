import {requireNonNegativeInteger} from "../../lib/numbers.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildOutboundDeliveryTableNames} from "../channels/deliveries/postgres-shared.js";
import {requireTimestampMillis} from "../../lib/postgres-values.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import {ensurePostgresA2ASessionBindingSchema} from "./postgres-schema.js";
import {type A2ATableNames, buildA2ATableNames} from "./postgres-shared.js";
import {requireA2AString} from "./shared.js";
import type {
    A2ASessionBindingLookup,
    A2ASessionBindingRecord,
    BindA2ASessionInput,
    CountRecentA2AMessagesInput,
    ListA2ASessionBindingsInput,
} from "./types.js";

export interface A2ASessionBindingRepoOptions {
  pool: PgQueryable;
}

function normalizeLookup(lookup: A2ASessionBindingLookup): A2ASessionBindingLookup {
  return {
    senderSessionId: requireA2AString("sender session id", lookup.senderSessionId),
    recipientSessionId: requireA2AString("recipient session id", lookup.recipientSessionId),
  };
}

function normalizeListInput(input: ListA2ASessionBindingsInput): ListA2ASessionBindingsInput {
  return {
    senderSessionId: input.senderSessionId?.trim() || undefined,
    recipientSessionId: input.recipientSessionId?.trim() || undefined,
  };
}

function normalizeCountInput(input: CountRecentA2AMessagesInput): CountRecentA2AMessagesInput {
  return {
    ...normalizeLookup(input),
    since: input.since,
  };
}

function parseRecord(row: Record<string, unknown>): A2ASessionBindingRecord {
  return {
    senderSessionId: requireA2AString("sender session id", row.sender_session_id),
    recipientSessionId: requireA2AString("recipient session id", row.recipient_session_id),
    createdAt: requireTimestampMillis(row.created_at, "A2A binding created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "A2A binding updated_at must be a valid timestamp."),
  };
}

export class A2ASessionBindingRepo {
  private readonly pool: PgQueryable;
  private readonly tables: A2ATableNames;
  private readonly threadTableName: string;
  private readonly inputTableName: string;
  private readonly outboundDeliveriesTableName: string;

  constructor(options: A2ASessionBindingRepoOptions) {
    this.pool = options.pool;
    this.tables = buildA2ATableNames();
    const threadTables = buildThreadRuntimeTableNames();
    this.threadTableName = threadTables.threads;
    this.inputTableName = threadTables.inputs;
    this.outboundDeliveriesTableName = buildOutboundDeliveryTableNames().outboundDeliveries;
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresA2ASessionBindingSchema(this.pool);
  }

  async bindSession(input: BindA2ASessionInput): Promise<A2ASessionBindingRecord> {
    const normalized = normalizeLookup(input);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.a2aSessionBindings} (
        sender_session_id,
        recipient_session_id
      ) VALUES (
        $1,
        $2
      )
      ON CONFLICT (sender_session_id, recipient_session_id)
      DO UPDATE
      SET updated_at = NOW()
      RETURNING *
    `, [
      normalized.senderSessionId,
      normalized.recipientSessionId,
    ]);

    return parseRecord(result.rows[0] as Record<string, unknown>);
  }

  async deleteBinding(lookup: A2ASessionBindingLookup): Promise<boolean> {
    const normalized = normalizeLookup(lookup);
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.a2aSessionBindings}
      WHERE sender_session_id = $1
        AND recipient_session_id = $2
    `, [
      normalized.senderSessionId,
      normalized.recipientSessionId,
    ]);

    return (result.rowCount ?? 0) > 0;
  }

  async hasBinding(lookup: A2ASessionBindingLookup): Promise<boolean> {
    const normalized = normalizeLookup(lookup);
    const result = await this.pool.query(`
      SELECT 1
      FROM ${this.tables.a2aSessionBindings}
      WHERE sender_session_id = $1
        AND recipient_session_id = $2
      LIMIT 1
    `, [
      normalized.senderSessionId,
      normalized.recipientSessionId,
    ]);

    return result.rows.length > 0;
  }

  async listBindings(input: ListA2ASessionBindingsInput = {}): Promise<readonly A2ASessionBindingRecord[]> {
    const normalized = normalizeListInput(input);
    const values: unknown[] = [];
    const where: string[] = [];

    if (normalized.senderSessionId) {
      values.push(normalized.senderSessionId);
      where.push(`sender_session_id = $${values.length}`);
    }

    if (normalized.recipientSessionId) {
      values.push(normalized.recipientSessionId);
      where.push(`recipient_session_id = $${values.length}`);
    }

    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.a2aSessionBindings}
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY sender_session_id ASC, recipient_session_id ASC
    `, values);

    return result.rows.map((row) => parseRecord(row as Record<string, unknown>));
  }

  async countRecentMessages(input: CountRecentA2AMessagesInput): Promise<number> {
    const normalized = normalizeCountInput(input);
    const result = await this.pool.query(`
      SELECT COUNT(*)::INTEGER AS count
      FROM ${this.outboundDeliveriesTableName} AS delivery
      INNER JOIN ${this.threadTableName} AS thread
        ON thread.id = delivery.thread_id
      WHERE delivery.channel = 'a2a'
        AND delivery.connector_key = 'local'
        AND thread.session_id = $1
        AND delivery.external_conversation_id = $2
        AND delivery.created_at >= $3
    `, [
      normalized.senderSessionId,
      normalized.recipientSessionId,
      new Date(normalized.since),
    ]);

    return requireNonNegativeInteger(
      (result.rows[0] as {count?: unknown} | undefined)?.count,
      "A2A recent message count",
    );
  }

  async hasReceivedMessage(input: {
    recipientSessionId: string;
    senderSessionId: string;
    messageId: string;
  }): Promise<boolean> {
    const recipientSessionId = requireA2AString("recipient session id", input.recipientSessionId);
    const senderSessionId = requireA2AString("sender session id", input.senderSessionId);
    const messageId = requireA2AString("message id", input.messageId);
    const result = await this.pool.query(`
      SELECT 1
      FROM ${this.inputTableName} AS input
      INNER JOIN ${this.threadTableName} AS thread
        ON thread.id = input.thread_id
      WHERE thread.session_id = $1
        AND input.source = 'a2a'
        AND input.channel_id = $2
        AND input.external_message_id = $3
      LIMIT 1
    `, [
      recipientSessionId,
      senderSessionId,
      messageId,
    ]);

    return result.rows.length > 0;
  }
}
