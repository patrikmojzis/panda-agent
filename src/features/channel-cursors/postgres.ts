import type { Pool } from "pg";

import { quoteIdentifier, toJson, toMillis } from "../thread-runtime/postgres-shared.js";
import { buildChannelCursorTableNames, type ChannelCursorTableNames } from "./postgres-shared.js";
import type { ChannelCursorStore } from "./store.js";
import type {
  ChannelCursorInput,
  ChannelCursorLookup,
  ChannelCursorRecord,
} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

export interface PostgresChannelCursorStoreOptions {
  pool: PgQueryable;
  tablePrefix?: string;
}

function requireTrimmedCursorKeyPart(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Channel cursor ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeChannelCursorLookup(lookup: ChannelCursorLookup): ChannelCursorLookup {
  return {
    source: requireTrimmedCursorKeyPart("source", lookup.source),
    connectorKey: requireTrimmedCursorKeyPart("connector key", lookup.connectorKey),
    cursorKey: requireTrimmedCursorKeyPart("cursor key", lookup.cursorKey),
  };
}

function normalizeChannelCursorInput(input: ChannelCursorInput): ChannelCursorInput {
  const lookup = normalizeChannelCursorLookup(input);
  return {
    ...input,
    ...lookup,
    value: requireTrimmedCursorKeyPart("value", input.value),
  };
}

function parseChannelCursorRow(row: Record<string, unknown>): ChannelCursorRecord {
  return {
    source: String(row.source),
    connectorKey: String(row.connector_key),
    cursorKey: String(row.cursor_key),
    value: String(row.cursor_value),
    metadata: row.metadata === null ? undefined : (row.metadata as ChannelCursorRecord["metadata"]),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export class PostgresChannelCursorStore implements ChannelCursorStore {
  private readonly pool: PgQueryable;
  private readonly tables: ChannelCursorTableNames;

  constructor(options: PostgresChannelCursorStoreOptions) {
    this.pool = options.pool;
    this.tables = buildChannelCursorTableNames(options.tablePrefix ?? "thread_runtime");
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.channelCursors} (
        source TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        cursor_key TEXT NOT NULL,
        cursor_value TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, connector_key, cursor_key)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_channel_cursors_updated_idx`)}
      ON ${this.tables.channelCursors} (updated_at DESC)
    `);
  }

  async resolveChannelCursor(lookup: ChannelCursorLookup): Promise<ChannelCursorRecord | null> {
    const normalizedLookup = normalizeChannelCursorLookup(lookup);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.channelCursors}
        WHERE source = $1
          AND connector_key = $2
          AND cursor_key = $3
      `,
      [
        normalizedLookup.source,
        normalizedLookup.connectorKey,
        normalizedLookup.cursorKey,
      ],
    );

    const row = result.rows[0];
    return row ? parseChannelCursorRow(row as Record<string, unknown>) : null;
  }

  async upsertChannelCursor(input: ChannelCursorInput): Promise<ChannelCursorRecord> {
    const normalizedInput = normalizeChannelCursorInput(input);
    const result = await this.pool.query(
      `
        INSERT INTO ${this.tables.channelCursors} (
          source,
          connector_key,
          cursor_key,
          cursor_value,
          metadata
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb
        )
        ON CONFLICT (source, connector_key, cursor_key)
        DO UPDATE SET
          cursor_value = EXCLUDED.cursor_value,
          metadata = COALESCE(EXCLUDED.metadata, ${this.tables.channelCursors}.metadata),
          updated_at = NOW()
        RETURNING *
      `,
      [
        normalizedInput.source,
        normalizedInput.connectorKey,
        normalizedInput.cursorKey,
        normalizedInput.value,
        toJson(normalizedInput.metadata),
      ],
    );

    return parseChannelCursorRow(result.rows[0] as Record<string, unknown>);
  }
}
