import type { Pool, PoolClient } from "pg";

import { quoteIdentifier, toJson, toMillis } from "../thread-runtime/postgres-shared.js";
import { buildConversationThreadTableNames, type ConversationThreadTableNames } from "./postgres-shared.js";
import type { ConversationThreadStore } from "./store.js";
import type {
  BindConversationThreadResult,
  ConversationThreadBindingInput,
  ConversationThreadLookup,
  ConversationThreadRecord,
} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface PostgresConversationThreadStoreOptions {
  pool: PgPoolLike;
  tablePrefix?: string;
}

function requireTrimmedConversationKeyPart(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Conversation thread ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeConversationThreadLookup(lookup: ConversationThreadLookup): ConversationThreadLookup {
  return {
    source: requireTrimmedConversationKeyPart("source", lookup.source),
    connectorKey: requireTrimmedConversationKeyPart("connector key", lookup.connectorKey),
    externalConversationId: requireTrimmedConversationKeyPart("external conversation id", lookup.externalConversationId),
  };
}

function normalizeConversationThreadBindingInput(
  input: ConversationThreadBindingInput,
): ConversationThreadBindingInput {
  const lookup = normalizeConversationThreadLookup(input);
  return {
    ...input,
    ...lookup,
    threadId: requireTrimmedConversationKeyPart("thread id", input.threadId),
  };
}

function parseConversationThreadRow(row: Record<string, unknown>): ConversationThreadRecord {
  return {
    source: String(row.source),
    connectorKey: String(row.connector_key),
    externalConversationId: String(row.external_conversation_id),
    threadId: String(row.thread_id),
    metadata: row.metadata === null ? undefined : (row.metadata as ConversationThreadRecord["metadata"]),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505";
}

export class PostgresConversationThreadStore implements ConversationThreadStore {
  private readonly pool: PgPoolLike;
  private readonly tables: ConversationThreadTableNames;

  constructor(options: PostgresConversationThreadStoreOptions) {
    this.pool = options.pool;
    this.tables = buildConversationThreadTableNames(options.tablePrefix ?? "thread_runtime");
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.conversationThreads} (
        source TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, connector_key, external_conversation_id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_conversation_threads_thread_id_idx`)}
      ON ${this.tables.conversationThreads} (thread_id)
    `);
  }

  async resolveConversationThread(lookup: ConversationThreadLookup): Promise<ConversationThreadRecord | null> {
    const normalizedLookup = normalizeConversationThreadLookup(lookup);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.conversationThreads}
        WHERE source = $1
          AND connector_key = $2
          AND external_conversation_id = $3
      `,
      [
        normalizedLookup.source,
        normalizedLookup.connectorKey,
        normalizedLookup.externalConversationId,
      ],
    );

    const row = result.rows[0];
    return row ? parseConversationThreadRow(row as Record<string, unknown>) : null;
  }

  async bindConversationThread(input: ConversationThreadBindingInput): Promise<BindConversationThreadResult> {
    const normalizedInput = normalizeConversationThreadBindingInput(input);
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      try {
        const insertedResult = await client.query(
          `
            INSERT INTO ${this.tables.conversationThreads} (
              source,
              connector_key,
              external_conversation_id,
              thread_id,
              metadata
            ) VALUES (
              $1,
              $2,
              $3,
              $4,
              $5::jsonb
            )
            RETURNING *
          `,
          [
            normalizedInput.source,
            normalizedInput.connectorKey,
            normalizedInput.externalConversationId,
            normalizedInput.threadId,
            toJson(normalizedInput.metadata),
          ],
        );

        return {
          binding: parseConversationThreadRow(insertedResult.rows[0] as Record<string, unknown>),
        };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }

      await client.query("BEGIN");
      inTransaction = true;

      const existingResult = await client.query(
        `
          SELECT *
          FROM ${this.tables.conversationThreads}
          WHERE source = $1
            AND connector_key = $2
            AND external_conversation_id = $3
          FOR UPDATE
        `,
        [
          normalizedInput.source,
          normalizedInput.connectorKey,
          normalizedInput.externalConversationId,
        ],
      );
      const existingRow = existingResult.rows[0];
      if (!existingRow) {
        throw new Error("Failed to lock existing conversation thread after conflict.");
      }

      const previousThreadId = String((existingRow as Record<string, unknown>).thread_id);

      const updateResult = await client.query(
        `
          UPDATE ${this.tables.conversationThreads}
          SET thread_id = $4,
              metadata = COALESCE($5::jsonb, metadata),
              updated_at = NOW()
          WHERE source = $1
            AND connector_key = $2
            AND external_conversation_id = $3
          RETURNING *
        `,
        [
          normalizedInput.source,
          normalizedInput.connectorKey,
          normalizedInput.externalConversationId,
          normalizedInput.threadId,
          toJson(normalizedInput.metadata),
        ],
      );
      const updatedRow = updateResult.rows[0];
      if (!updatedRow) {
        throw new Error("Failed to bind conversation thread after conflict.");
      }

      await client.query("COMMIT");
      inTransaction = false;

      return {
        binding: parseConversationThreadRow(updatedRow as Record<string, unknown>),
        previousThreadId: previousThreadId !== normalizedInput.threadId
          ? previousThreadId
          : undefined,
      };
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
