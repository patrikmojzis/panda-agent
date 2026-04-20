import type {Pool, PoolClient} from "pg";

import {requireA2AString} from "./shared.js";
import {
    buildThreadRuntimeTableNames,
    CREATE_RUNTIME_SCHEMA_SQL,
    quoteIdentifier,
    toMillis
} from "../threads/runtime/postgres-shared.js";
import {buildOutboundDeliveryTableNames} from "../channels/deliveries/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {addConstraint, assertIntegrityChecks} from "../../lib/postgres-integrity.js";
import {type A2ATableNames, buildA2ATableNames} from "./postgres-shared.js";
import type {
    A2ASessionBindingLookup,
    A2ASessionBindingRecord,
    BindA2ASessionInput,
    CountRecentA2AMessagesInput,
    ListA2ASessionBindingsInput,
} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface A2ASessionBindingRepoOptions {
  pool: PgPoolLike;
}

const requireTrimmed = requireA2AString;

function normalizeLookup(lookup: A2ASessionBindingLookup): A2ASessionBindingLookup {
  return {
    senderSessionId: requireTrimmed("sender session id", lookup.senderSessionId),
    recipientSessionId: requireTrimmed("recipient session id", lookup.recipientSessionId),
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
    senderSessionId: String(row.sender_session_id),
    recipientSessionId: String(row.recipient_session_id),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export class A2ASessionBindingRepo {
  private readonly pool: PgPoolLike;
  private readonly tables: A2ATableNames;
  private readonly sessionTableName: string;
  private readonly threadTableName: string;
  private readonly inputTableName: string;
  private readonly outboundDeliveriesTableName: string;

  constructor(options: A2ASessionBindingRepoOptions) {
    this.pool = options.pool;
    this.tables = buildA2ATableNames();
    this.sessionTableName = buildSessionTableNames().sessions;
    const threadTables = buildThreadRuntimeTableNames();
    this.threadTableName = threadTables.threads;
    this.inputTableName = threadTables.inputs;
    this.outboundDeliveriesTableName = buildOutboundDeliveryTableNames().outboundDeliveries;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.a2aSessionBindings} (
        sender_session_id TEXT NOT NULL,
        recipient_session_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (sender_session_id, recipient_session_id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_session_bindings_sender_idx`)}
      ON ${this.tables.a2aSessionBindings} (sender_session_id, updated_at DESC)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_session_bindings_recipient_idx`)}
      ON ${this.tables.a2aSessionBindings} (recipient_session_id, updated_at DESC)
    `);
    await assertIntegrityChecks(this.pool, "A2A binding schema", [
      {
        label: "a2a_session_bindings.sender_session_id orphaned from agent_sessions.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.a2aSessionBindings} AS binding
          LEFT JOIN ${this.sessionTableName} AS sender
            ON sender.id = binding.sender_session_id
          WHERE sender.id IS NULL
        `,
      },
      {
        label: "a2a_session_bindings.recipient_session_id orphaned from agent_sessions.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.a2aSessionBindings} AS binding
          LEFT JOIN ${this.sessionTableName} AS recipient
            ON recipient.id = binding.recipient_session_id
          WHERE recipient.id IS NULL
        `,
      },
    ]);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.a2aSessionBindings}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_session_bindings_sender_session_fk`)}
      FOREIGN KEY (sender_session_id)
      REFERENCES ${this.sessionTableName}(id)
      ON DELETE CASCADE
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.a2aSessionBindings}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_session_bindings_recipient_session_fk`)}
      FOREIGN KEY (recipient_session_id)
      REFERENCES ${this.sessionTableName}(id)
      ON DELETE CASCADE
    `);
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

    return Number((result.rows[0] as {count?: unknown} | undefined)?.count ?? 0);
  }

  async hasReceivedMessage(input: {
    recipientSessionId: string;
    senderSessionId: string;
    messageId: string;
  }): Promise<boolean> {
    const recipientSessionId = requireTrimmed("recipient session id", input.recipientSessionId);
    const senderSessionId = requireTrimmed("sender session id", input.senderSessionId);
    const messageId = requireTrimmed("message id", input.messageId);
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
