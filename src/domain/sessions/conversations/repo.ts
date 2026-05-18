import {requireTimestampMillis, toJson} from "../../../lib/postgres-values.js";
import {readOptionalJsonValue} from "../../../lib/json.js";
import type {PgPoolLike} from "../../../lib/postgres-query.js";
import {isUniqueViolation} from "../../../lib/postgres-errors.js";
import {requireNonEmptyString} from "../../../lib/strings.js";
import {buildConversationSessionTableNames, type ConversationSessionTableNames} from "./postgres-shared.js";
import {ensurePostgresConversationSessionSchema} from "./postgres-schema.js";
import type {
  BindConversationInput,
  BindConversationResult,
  ConversationBinding,
  ConversationBindingListFilter,
  ConversationLookup,
} from "./types.js";

export interface ConversationRepoOptions {
  pool: PgPoolLike;
}

function requireConversationBindingString(field: string, value: unknown): string {
  return requireNonEmptyString(value, `Conversation binding ${field} must not be empty.`);
}

function normalizeConversationLookup(lookup: ConversationLookup): ConversationLookup {
  return {
    source: requireConversationBindingString("source", lookup.source),
    connectorKey: requireConversationBindingString("connector key", lookup.connectorKey),
    externalConversationId: requireConversationBindingString("external conversation id", lookup.externalConversationId),
  };
}

function normalizeConversationBindingListFilter(
  filter: ConversationBindingListFilter,
): ConversationBindingListFilter {
  return {
    source: requireConversationBindingString("source", filter.source),
    connectorKey: requireConversationBindingString("connector key", filter.connectorKey),
  };
}

function normalizeBindConversationInput(
  input: BindConversationInput,
): BindConversationInput {
  const lookup = normalizeConversationLookup(input);
  return {
    ...input,
    ...lookup,
    sessionId: requireConversationBindingString("session id", input.sessionId),
    metadata: readOptionalJsonValue(input.metadata, "Conversation binding metadata"),
  };
}

function parseConversationBinding(row: Record<string, unknown>): ConversationBinding {
  return {
    source: requireConversationBindingString("source", row.source),
    connectorKey: requireConversationBindingString("connector key", row.connector_key),
    externalConversationId: requireConversationBindingString("external conversation id", row.external_conversation_id),
    sessionId: requireConversationBindingString("session id", row.session_id),
    metadata: readOptionalJsonValue(row.metadata, "Conversation binding metadata"),
    createdAt: requireTimestampMillis(row.created_at, "Conversation binding created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Conversation binding updated_at must be a valid timestamp."),
  };
}

export class ConversationRepo {
  private readonly pool: PgPoolLike;
  private readonly tables: ConversationSessionTableNames;

  constructor(options: ConversationRepoOptions) {
    this.pool = options.pool;
    this.tables = buildConversationSessionTableNames();
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresConversationSessionSchema(this.pool);
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

  async listConversationBindings(
    filter: ConversationBindingListFilter,
  ): Promise<readonly ConversationBinding[]> {
    const normalizedFilter = normalizeConversationBindingListFilter(filter);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.conversationSessions}
        WHERE source = $1
          AND connector_key = $2
        ORDER BY external_conversation_id ASC
      `,
      [
        normalizedFilter.source,
        normalizedFilter.connectorKey,
      ],
    );

    return result.rows.map((row) => parseConversationBinding(row as Record<string, unknown>));
  }

  async createConversationBinding(input: BindConversationInput): Promise<ConversationBinding | null> {
    const normalizedInput = normalizeBindConversationInput(input);

    try {
      const result = await this.pool.query(
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

      return parseConversationBinding(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }

      throw error;
    }
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

      const existingBinding = parseConversationBinding(existingRow as Record<string, unknown>);
      const previousSessionId = existingBinding.sessionId;

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
