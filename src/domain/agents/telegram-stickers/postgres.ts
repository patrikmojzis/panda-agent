import type {PgPoolLike, PgQueryable} from "../../../lib/postgres-query.js";
import {requireNonNegativeInteger} from "../../../lib/numbers.js";
import {requireTimestampMillis} from "../../../lib/postgres-values.js";
import {optionalTrimmedString, requireNonEmptyString} from "../../../lib/strings.js";
import {normalizeAgentKey} from "../types.js";
import {ensurePostgresTelegramStickerSchema} from "./postgres-schema.js";
import {buildTelegramStickerTableNames, type TelegramStickerTableNames} from "./postgres-shared.js";
import type {TelegramStickerStore} from "./store.js";
import {
  createTelegramStickerId,
  MAX_AGENT_TELEGRAM_STICKERS,
  normalizeTelegramStickerDescription,
  normalizeTelegramStickerFormat,
  normalizeTelegramStickerImport,
  normalizeTelegramStickerTags,
  normalizeTelegramStickerType,
  type ImportTelegramStickersInput,
  type ImportTelegramStickersResult,
  type ListTelegramStickersFilter,
  type TelegramStickerItem,
  type TelegramStickerRecord,
} from "./types.js";

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Telegram sticker tags must be an array.");
  }
  return normalizeTelegramStickerTags(value);
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function parseStickerRow(row: Record<string, unknown>): TelegramStickerRecord {
  const sizeBytes = row.size_bytes === null || row.size_bytes === undefined
    ? undefined
    : requireNonNegativeInteger(Number(row.size_bytes), "Telegram sticker size");
  return {
    id: requireNonEmptyString(row.id, "Telegram sticker row is missing id."),
    agentKey: normalizeAgentKey(requireNonEmptyString(row.agent_key, "Telegram sticker row is missing agent key.")),
    connectorKey: requireNonEmptyString(row.connector_key, "Telegram sticker row is missing connector key."),
    fileId: requireNonEmptyString(row.file_id, "Telegram sticker row is missing file id."),
    fileUniqueId: requireNonEmptyString(row.file_unique_id, "Telegram sticker row is missing file unique id."),
    setName: optionalTrimmedString(row.set_name, "Telegram sticker set name must be a string."),
    setTitle: optionalTrimmedString(row.set_title, "Telegram sticker set title must be a string."),
    emoji: optionalTrimmedString(row.emoji, "Telegram sticker emoji must be a string."),
    stickerType: normalizeTelegramStickerType(row.sticker_type),
    format: normalizeTelegramStickerFormat(row.sticker_format),
    width: requirePositiveInteger(Number(row.width), "Telegram sticker width"),
    height: requirePositiveInteger(Number(row.height), "Telegram sticker height"),
    sizeBytes,
    tags: parseTags(row.tags),
    description: normalizeTelegramStickerDescription(
      optionalTrimmedString(row.description, "Telegram sticker description must be a string."),
    ),
    createdAt: requireTimestampMillis(row.created_at, "Telegram sticker created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Telegram sticker updated_at must be a valid timestamp."),
  };
}

function stickerValues(
  id: string,
  input: Pick<ImportTelegramStickersInput, "agentKey" | "connectorKey" | "tags" | "description">,
  sticker: TelegramStickerItem,
): readonly unknown[] {
  return [
    id,
    input.agentKey,
    input.connectorKey,
    sticker.fileId,
    sticker.fileUniqueId,
    sticker.setName ?? null,
    sticker.setTitle ?? null,
    sticker.emoji ?? null,
    sticker.stickerType,
    sticker.format,
    sticker.width,
    sticker.height,
    sticker.sizeBytes ?? null,
    input.tags ?? [],
    input.description ?? null,
  ];
}

async function upsertSticker(
  queryable: PgQueryable,
  tables: TelegramStickerTableNames,
  input: ImportTelegramStickersInput,
  sticker: TelegramStickerItem,
): Promise<TelegramStickerRecord> {
  const result = await queryable.query(`
    INSERT INTO ${tables.stickers} (
      id, agent_key, connector_key, file_id, file_unique_id,
      set_name, set_title, emoji, sticker_type, sticker_format,
      width, height, size_bytes, tags, description
    ) VALUES (
      $1::uuid, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14::text[], $15
    )
    ON CONFLICT (agent_key, connector_key, file_unique_id)
    DO UPDATE SET
      file_id = EXCLUDED.file_id,
      set_name = EXCLUDED.set_name,
      set_title = EXCLUDED.set_title,
      emoji = EXCLUDED.emoji,
      sticker_type = EXCLUDED.sticker_type,
      sticker_format = EXCLUDED.sticker_format,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      size_bytes = EXCLUDED.size_bytes,
      tags = EXCLUDED.tags,
      description = EXCLUDED.description,
      updated_at = NOW()
    RETURNING *
  `, stickerValues(createTelegramStickerId(), input, sticker));
  return parseStickerRow(result.rows[0] as Record<string, unknown>);
}

export class PostgresTelegramStickerStore implements TelegramStickerStore {
  private readonly pool: PgPoolLike;
  private readonly tables = buildTelegramStickerTableNames();

  constructor(options: {pool: PgPoolLike}) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresTelegramStickerSchema(this.pool);
  }

  async importStickers(rawInput: ImportTelegramStickersInput): Promise<ImportTelegramStickersResult> {
    const input = normalizeTelegramStickerImport(rawInput);
    const stickers = [...new Map(input.stickers.map((sticker) => [sticker.fileUniqueId, sticker])).values()];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`telegram-stickers:${input.agentKey}`]);
      const existingResult = await client.query(`
        SELECT file_unique_id, tags, description
        FROM ${this.tables.stickers}
        WHERE agent_key = $1
          AND connector_key = $2
          AND file_unique_id = ANY($3::text[])
      `, [input.agentKey, input.connectorKey, stickers.map((sticker) => sticker.fileUniqueId)]);
      const existing = new Map(existingResult.rows.map((row) => {
        const record = row as {file_unique_id: unknown; tags: unknown; description: unknown};
        return [
          String(record.file_unique_id),
          {
            tags: parseTags(record.tags),
            description: normalizeTelegramStickerDescription(
              optionalTrimmedString(record.description, "Telegram sticker description must be a string."),
            ),
          },
        ] as const;
      }));
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${this.tables.stickers} WHERE agent_key = $1`,
        [input.agentKey],
      );
      const count = requireNonNegativeInteger(
        Number((countResult.rows[0] as {count: unknown}).count),
        "Telegram sticker library count",
      );
      const createdCount = stickers.filter((sticker) => !existing.has(sticker.fileUniqueId)).length;
      if (count + createdCount > MAX_AGENT_TELEGRAM_STICKERS) {
        throw new Error(
          `Telegram sticker library is limited to ${MAX_AGENT_TELEGRAM_STICKERS} stickers per agent.`,
        );
      }
      const records: TelegramStickerRecord[] = [];
      for (const sticker of stickers) {
        const current = existing.get(sticker.fileUniqueId);
        records.push(await upsertSticker(client, this.tables, {
          ...input,
          tags: normalizeTelegramStickerTags([...(current?.tags ?? []), ...(input.tags ?? [])]),
          description: input.description ?? current?.description,
        }, sticker));
      }
      await client.query("COMMIT");
      return {
        stickers: records,
        createdCount,
        updatedCount: stickers.length - createdCount,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getSticker(agentKey: string, id: string): Promise<TelegramStickerRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.stickers} WHERE agent_key = $1 AND id = $2::uuid LIMIT 1`,
      [normalizeAgentKey(agentKey), id],
    );
    return result.rows[0] ? parseStickerRow(result.rows[0] as Record<string, unknown>) : null;
  }

  async listStickers(filter: ListTelegramStickersFilter): Promise<readonly TelegramStickerRecord[]> {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 100));
    const query = filter.query?.trim().toLowerCase();
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.stickers}
      WHERE agent_key = $1
        AND ($2::text IS NULL OR connector_key = $2)
        AND ($3::text IS NULL OR emoji = $3)
        AND ($4::text IS NULL OR $4 = ANY(tags))
        AND (
          $5::text IS NULL
          OR LOWER(COALESCE(description, '')) LIKE '%' || $5 || '%'
          OR LOWER(COALESCE(set_name, '')) LIKE '%' || $5 || '%'
          OR LOWER(COALESCE(set_title, '')) LIKE '%' || $5 || '%'
          OR LOWER(COALESCE(emoji, '')) LIKE '%' || $5 || '%'
        )
      ORDER BY updated_at DESC, id ASC
      LIMIT $6
    `, [
      normalizeAgentKey(filter.agentKey),
      filter.connectorKey?.trim() || null,
      filter.emoji?.trim() || null,
      filter.tag?.trim().toLowerCase() || null,
      query || null,
      limit,
    ]);
    return result.rows.map((row) => parseStickerRow(row as Record<string, unknown>));
  }
}
