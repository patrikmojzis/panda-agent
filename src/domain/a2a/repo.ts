import {requireNonNegativeInteger} from "../../lib/numbers.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildOutboundDeliveryTableNames} from "../channels/deliveries/postgres-shared.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import {ensurePostgresA2ASessionBindingSchema} from "./postgres-schema.js";
import {type A2ATableNames, buildA2ATableNames} from "./postgres-shared.js";
import {requireA2AString} from "./shared.js";
import {isRecord} from "../../lib/records.js";
import type {
    A2ADeliveryDirection,
    A2ADeliveryItemSummary,
    A2ADeliveryRecord,
    A2ADeliverySentItemSummary,
    A2ASessionBindingLookup,
    A2ASessionBindingRecord,
    BindA2ASessionInput,
    CountRecentA2AMessagesInput,
    GetA2ADeliveryInput,
    ListA2ADeliveriesInput,
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

function readA2AMetadata(row: Record<string, unknown>): Record<string, unknown> {
  const metadata = row.metadata;
  if (!isRecord(metadata) || !isRecord(metadata.a2a)) {
    throw new Error("A2A delivery metadata is missing.");
  }

  return metadata.a2a;
}

function readA2AOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requireA2AString(field, value);
}

function parseA2ADeliveryStatus(value: unknown): A2ADeliveryRecord["status"] {
  if (value === "pending" || value === "sending" || value === "sent" || value === "failed") {
    return value;
  }

  throw new Error(`Unsupported A2A delivery status ${String(value)}.`);
}

function readItemType(value: unknown, label: string): A2ADeliveryItemSummary["type"] {
  if (value === "text" || value === "image" || value === "file") {
    return value;
  }

  throw new Error(`${label} type is invalid: ${String(value)}.`);
}

function textPreview(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function parseA2AItems(value: unknown): readonly A2ADeliveryItemSummary[] {
  if (!Array.isArray(value)) {
    throw new Error("A2A delivery items are missing or invalid.");
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`A2A delivery items[${index}] must be an object.`);
    }
    const type = readItemType(item.type, `A2A delivery items[${index}]`);
    return {
      type,
      ...(type === "text" ? {textPreview: textPreview(item.text)} : {}),
      ...(typeof item.path === "string" && item.path.trim() ? {path: item.path.trim()} : {}),
      ...(typeof item.filename === "string" && item.filename.trim() ? {filename: item.filename.trim()} : {}),
    };
  });
}

function parseA2ASentItems(value: unknown): readonly A2ADeliverySentItemSummary[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("A2A delivery sent items are invalid.");
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`A2A delivery sentItems[${index}] must be an object.`);
    }

    return {
      type: readItemType(item.type, `A2A delivery sentItems[${index}]`),
      externalMessageId: requireA2AString(`sentItems[${index}] external message id`, item.externalMessageId),
    };
  });
}

function parseA2ADirection(row: Record<string, unknown>, sessionId: string): A2ADeliveryDirection {
  const metadata = readA2AMetadata(row);
  const fromSessionId = requireA2AString("from session id", metadata.fromSessionId);
  const toSessionId = requireA2AString("to session id", metadata.toSessionId);
  if (fromSessionId === sessionId) {
    return "outbound";
  }
  if (toSessionId === sessionId) {
    return "inbound";
  }

  throw new Error("A2A delivery is not visible to the current session.");
}

function parseA2ADeliveryRow(row: Record<string, unknown>, sessionId: string): A2ADeliveryRecord {
  const metadata = readA2AMetadata(row);
  const items = parseA2AItems(row.items);
  const sentItems = parseA2ASentItems(row.sent_items);
  const fromRunId = readA2AOptionalString(metadata.fromRunId, "from run id");
  const lastError = readA2AOptionalString(row.last_error, "last error");
  return {
    deliveryId: requireA2AString("delivery id", row.id),
    messageId: requireA2AString("message id", metadata.messageId),
    fromAgentKey: requireA2AString("from agent key", metadata.fromAgentKey),
    fromSessionId: requireA2AString("from session id", metadata.fromSessionId),
    fromThreadId: requireA2AString("from thread id", metadata.fromThreadId),
    ...(fromRunId ? {fromRunId} : {}),
    toAgentKey: requireA2AString("to agent key", metadata.toAgentKey),
    toSessionId: requireA2AString("to session id", metadata.toSessionId),
    direction: parseA2ADirection(row, sessionId),
    status: parseA2ADeliveryStatus(row.status),
    attemptCount: requireNonNegativeInteger(row.attempt_count, "A2A delivery attempt count"),
    ...(lastError ? {lastError} : {}),
    itemCount: items.length,
    items,
    ...(sentItems ? {sentItems} : {}),
    sentAt: typeof metadata.sentAt === "number" && Number.isFinite(metadata.sentAt)
      ? metadata.sentAt
      : requireTimestampMillis(row.created_at, "A2A delivery created_at must be a valid timestamp."),
    claimedAt: optionalTimestampMillis(row.claimed_at, "A2A delivery claimed_at must be a valid timestamp."),
    completedAt: optionalTimestampMillis(row.completed_at, "A2A delivery completed_at must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "A2A delivery created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "A2A delivery updated_at must be a valid timestamp."),
  };
}

function normalizeDeliveryLimit(value: number | undefined): number {
  if (value === undefined) {
    return 10;
  }
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("A2A history limit must be an integer from 1 to 50.");
  }

  return value;
}

function normalizeDeliveryDirection(value: ListA2ADeliveriesInput["direction"]): A2ADeliveryDirection | "all" {
  if (value === undefined || value === "all" || value === "inbound" || value === "outbound") {
    return value ?? "all";
  }

  throw new Error("A2A history direction must be inbound, outbound, or all.");
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

  async getA2ADelivery(input: GetA2ADeliveryInput): Promise<A2ADeliveryRecord | null> {
    const sessionId = requireA2AString("session id", input.sessionId);
    const deliveryId = requireA2AString("delivery id", input.deliveryId);
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.outboundDeliveriesTableName}
      WHERE id = $1
        AND channel = 'a2a'
        AND connector_key = 'local'
        AND (
          metadata -> 'a2a' ->> 'fromSessionId' = $2
          OR metadata -> 'a2a' ->> 'toSessionId' = $2
        )
      LIMIT 1
    `, [
      deliveryId,
      sessionId,
    ]);

    const row = result.rows[0];
    return row ? parseA2ADeliveryRow(row as Record<string, unknown>, sessionId) : null;
  }

  async listA2ADeliveries(input: ListA2ADeliveriesInput): Promise<readonly A2ADeliveryRecord[]> {
    const sessionId = requireA2AString("session id", input.sessionId);
    const peerSessionId = input.peerSessionId?.trim() || undefined;
    const direction = normalizeDeliveryDirection(input.direction);
    const limit = normalizeDeliveryLimit(input.limit);
    const values: unknown[] = [sessionId];
    const clauses: string[] = [
      "channel = 'a2a'",
      "connector_key = 'local'",
    ];

    if (direction === "inbound") {
      clauses.push("metadata -> 'a2a' ->> 'toSessionId' = $1");
    } else if (direction === "outbound") {
      clauses.push("metadata -> 'a2a' ->> 'fromSessionId' = $1");
    } else {
      clauses.push("(metadata -> 'a2a' ->> 'fromSessionId' = $1 OR metadata -> 'a2a' ->> 'toSessionId' = $1)");
    }

    if (peerSessionId) {
      values.push(peerSessionId);
      clauses.push(`(metadata -> 'a2a' ->> 'fromSessionId' = $${values.length} OR metadata -> 'a2a' ->> 'toSessionId' = $${values.length})`);
    }

    values.push(limit);
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.outboundDeliveriesTableName}
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
    `, values);

    return result.rows.map((row) => parseA2ADeliveryRow(row as Record<string, unknown>, sessionId));
  }
}
