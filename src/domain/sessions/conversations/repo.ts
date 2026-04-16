import type {Pool, PoolClient} from "pg";

import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier, toJson, toMillis} from "../../threads/runtime/postgres-shared.js";
import {buildConversationSessionTableNames, type ConversationSessionTableNames} from "./postgres-shared.js";
import type {BindConversationInput, BindConversationResult, ConversationBinding, ConversationLookup,} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface ConversationRepoOptions {
  pool: PgPoolLike;
}

function requireTrimmedConversationKeyPart(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Conversation binding ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeConversationLookup(lookup: ConversationLookup): ConversationLookup {
  return {
    source: requireTrimmedConversationKeyPart("source", lookup.source),
    connectorKey: requireTrimmedConversationKeyPart("connector key", lookup.connectorKey),
    externalConversationId: requireTrimmedConversationKeyPart("external conversation id", lookup.externalConversationId),
  };
}

function normalizeBindConversationInput(
  input: BindConversationInput,
): BindConversationInput {
  const lookup = normalizeConversationLookup(input);
  return {
    ...input,
    ...lookup,
    sessionId: requireTrimmedConversationKeyPart("session id", input.sessionId),
  };
}

function parseConversationBinding(row: Record<string, unknown>): ConversationBinding {
  return {
    source: String(row.source),
    connectorKey: String(row.connector_key),
    externalConversationId: String(row.external_conversation_id),
    sessionId: String(row.session_id),
    metadata: row.metadata === null ? undefined : (row.metadata as ConversationBinding["metadata"]),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505";
}

export class ConversationRepo {
  private readonly pool: PgPoolLike;
  private readonly tables: ConversationSessionTableNames;

  constructor(options: ConversationRepoOptions) {
    this.pool = options.pool;
    this.tables = buildConversationSessionTableNames();
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.conversationSessions} (
        source TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, connector_key, external_conversation_id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_conversation_sessions_session_id_idx`)}
      ON ${this.tables.conversationSessions} (session_id)
    `);
  }

  async getConversationBinding(lookup: ConversationLookup): Promise<ConversationBinding | null> {
    const normalizedLookup = normalizeConversationLookup(lookup);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.conversationSessions}
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
    return row ? parseConversationBinding(row as Record<string, unknown>) : null;
  }

  async bindConversation(input: BindConversationInput): Promise<BindConversationResult> {
    const normalizedInput = normalizeBindConversationInput(input);
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      try {
        const insertedResult = await client.query(
          `
            INSERT INTO ${this.tables.conversationSessions} (
              source,
              connector_key,
              external_conversation_id,
              session_id,
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
            normalizedInput.sessionId,
            toJson(normalizedInput.metadata),
          ],
        );

        return {
          binding: parseConversationBinding(insertedResult.rows[0] as Record<string, unknown>),
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
          FROM ${this.tables.conversationSessions}
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
        throw new Error("Failed to lock existing conversation session after conflict.");
      }

      const previousSessionId = String((existingRow as Record<string, unknown>).session_id);

      const updateResult = await client.query(
        `
          UPDATE ${this.tables.conversationSessions}
          SET session_id = $4,
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
          normalizedInput.sessionId,
          toJson(normalizedInput.metadata),
        ],
      );
      const updatedRow = updateResult.rows[0];
      if (!updatedRow) {
        throw new Error("Failed to bind conversation session after conflict.");
      }

      await client.query("COMMIT");
      inTransaction = false;

      return {
        binding: parseConversationBinding(updatedRow as Record<string, unknown>),
        previousSessionId: previousSessionId !== normalizedInput.sessionId
          ? previousSessionId
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

  async deleteConversationBinding(lookup: ConversationLookup): Promise<boolean> {
    const normalizedLookup = normalizeConversationLookup(lookup);
    const result = await this.pool.query(
      `
        DELETE FROM ${this.tables.conversationSessions}
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

    return (result.rowCount ?? 0) > 0;
  }
}
