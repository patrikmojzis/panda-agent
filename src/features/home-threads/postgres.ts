import type {Pool, PoolClient} from "pg";

import {quoteIdentifier, toJson, toMillis} from "../thread-runtime/postgres-shared.js";
import {buildHomeThreadTableNames, type HomeThreadTableNames} from "./postgres-shared.js";
import type {HomeThreadStore} from "./store.js";
import type {
    BindHomeThreadResult,
    HomeThreadBindingInput,
    HomeThreadLookup,
    HomeThreadMetadata,
    HomeThreadRecord,
} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface PostgresHomeThreadStoreOptions {
  pool: PgPoolLike;
  tablePrefix?: string;
}

function requireTrimmedHomeThreadKeyPart(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Home thread ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeHomeThreadLookup(lookup: HomeThreadLookup): HomeThreadLookup {
  return {
    identityId: requireTrimmedHomeThreadKeyPart("identity id", lookup.identityId),
  };
}

function normalizeHomeThreadBindingInput(input: HomeThreadBindingInput): HomeThreadBindingInput {
  const lookup = normalizeHomeThreadLookup(input);
  return {
    ...input,
    ...lookup,
    threadId: requireTrimmedHomeThreadKeyPart("thread id", input.threadId),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHomeThreadMetadata(value: unknown): HomeThreadMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadata: HomeThreadMetadata = {};
  if (typeof value.homeDir === "string") {
    metadata.homeDir = value.homeDir;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function parseHomeThreadRow(row: Record<string, unknown>): HomeThreadRecord {
  return {
    identityId: String(row.identity_id),
    threadId: String(row.thread_id),
    metadata: parseHomeThreadMetadata(row.metadata),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505";
}

export class PostgresHomeThreadStore implements HomeThreadStore {
  private readonly pool: PgPoolLike;
  private readonly tables: HomeThreadTableNames;

  constructor(options: PostgresHomeThreadStoreOptions) {
    this.pool = options.pool;
    this.tables = buildHomeThreadTableNames(options.tablePrefix ?? "thread_runtime");
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.homeThreads} (
        identity_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (identity_id)
      )
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.homeThreads}
      ADD COLUMN IF NOT EXISTS metadata JSONB
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_home_threads_thread_id_idx`)}
      ON ${this.tables.homeThreads} (thread_id)
    `);
  }

  async resolveHomeThread(lookup: HomeThreadLookup): Promise<HomeThreadRecord | null> {
    const normalizedLookup = normalizeHomeThreadLookup(lookup);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.homeThreads}
        WHERE identity_id = $1
      `,
      [
        normalizedLookup.identityId,
      ],
    );

    const row = result.rows[0];
    return row ? parseHomeThreadRow(row as Record<string, unknown>) : null;
  }

  async bindHomeThread(input: HomeThreadBindingInput): Promise<BindHomeThreadResult> {
    const normalizedInput = normalizeHomeThreadBindingInput(input);
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      try {
        const insertedResult = await client.query(
          `
            INSERT INTO ${this.tables.homeThreads} (
              identity_id,
              thread_id,
              metadata
            ) VALUES (
              $1,
              $2,
              $3::jsonb
            )
            RETURNING *
          `,
          [
            normalizedInput.identityId,
            normalizedInput.threadId,
            toJson(normalizedInput.metadata),
          ],
        );

        return {
          binding: parseHomeThreadRow(insertedResult.rows[0] as Record<string, unknown>),
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
          FROM ${this.tables.homeThreads}
          WHERE identity_id = $1
          FOR UPDATE
        `,
        [
          normalizedInput.identityId,
        ],
      );
      const existingRow = existingResult.rows[0];
      if (!existingRow) {
        throw new Error("Failed to lock existing home thread after conflict.");
      }

      const previousThreadId = String((existingRow as Record<string, unknown>).thread_id);

      const updateResult = await client.query(
        `
          UPDATE ${this.tables.homeThreads}
          SET thread_id = $2,
              metadata = COALESCE($3::jsonb, metadata),
              updated_at = NOW()
          WHERE identity_id = $1
          RETURNING *
        `,
        [
          normalizedInput.identityId,
          normalizedInput.threadId,
          toJson(normalizedInput.metadata),
        ],
      );
      const updatedRow = updateResult.rows[0];
      if (!updatedRow) {
        throw new Error("Failed to bind home thread after conflict.");
      }

      await client.query("COMMIT");
      inTransaction = false;

      return {
        binding: parseHomeThreadRow(updatedRow as Record<string, unknown>),
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
