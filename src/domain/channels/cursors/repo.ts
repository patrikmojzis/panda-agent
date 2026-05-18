import {requireTimestampMillis, toJson} from "../../../lib/postgres-values.js";
import {readOptionalJsonValue} from "../../../lib/json.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import {requireTrimmedString} from "../../../lib/strings.js";
import {buildChannelCursorTableNames, type ChannelCursorTableNames} from "./postgres-shared.js";
import {
  ensurePostgresChannelCursorSchema,
} from "./postgres-schema.js";
import type {ChannelCursorInput, ChannelCursorLookup, ChannelCursorRecord,} from "./types.js";

export interface ChannelCursorRepoOptions {
  pool: PgQueryable;
}

function requireTrimmedCursorKeyPart(field: string, value: unknown): string {
  return requireTrimmedString(
    value,
    `Channel cursor ${field} must be a string.`,
    `Channel cursor ${field} must not be empty.`,
  );
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
    metadata: readOptionalJsonValue(input.metadata, "Channel cursor metadata"),
  };
}

function parseChannelCursorRow(row: Record<string, unknown>): ChannelCursorRecord {
  return {
    source: requireTrimmedCursorKeyPart("source", row.source),
    connectorKey: requireTrimmedCursorKeyPart("connector key", row.connector_key),
    cursorKey: requireTrimmedCursorKeyPart("cursor key", row.cursor_key),
    value: requireTrimmedCursorKeyPart("value", row.cursor_value),
    metadata: readOptionalJsonValue(row.metadata, "Channel cursor metadata"),
    createdAt: requireTimestampMillis(row.created_at, "Channel cursor created_at must be a finite timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Channel cursor updated_at must be a finite timestamp."),
  };
}

export class ChannelCursorRepo {
  private readonly pool: PgQueryable;
  private readonly tables: ChannelCursorTableNames;

  constructor(options: ChannelCursorRepoOptions) {
    this.pool = options.pool;
    this.tables = buildChannelCursorTableNames();
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresChannelCursorSchema(this.pool);
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
