import type { Pool, PoolClient } from "pg";

import { quoteIdentifier, toMillis } from "../thread-runtime/postgres-shared.js";
import { buildIdentityTableNames, type IdentityTableNames } from "./postgres-shared.js";
import { createDefaultIdentityInput, type CreateIdentityInput, type IdentityRecord } from "./types.js";
import type { IdentityStore } from "./store.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface PostgresIdentityStoreOptions {
  pool: PgPoolLike;
  tablePrefix?: string;
}

function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase();
}

function parseIdentityRow(row: Record<string, unknown>): IdentityRecord {
  return {
    id: String(row.id),
    handle: String(row.handle),
    displayName: String(row.display_name),
    status: String(row.status) as IdentityRecord["status"],
    metadata: row.metadata === null ? undefined : (row.metadata as IdentityRecord["metadata"]),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function missingIdentityError(identityId: string): Error {
  return new Error(`Unknown identity ${identityId}`);
}

function missingIdentityHandleError(handle: string): Error {
  return new Error(`Unknown identity handle ${handle}`);
}

export class PostgresIdentityStore implements IdentityStore {
  private readonly pool: PgPoolLike;
  private readonly tables: IdentityTableNames;

  constructor(options: PostgresIdentityStoreOptions) {
    this.pool = options.pool;
    this.tables = buildIdentityTableNames(options.tablePrefix ?? "thread_runtime");
  }

  async ensureSchema(): Promise<void> {
    const localIdentity = createDefaultIdentityInput();
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.identities} (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.identityBindings} (
        id UUID PRIMARY KEY,
        identity_id TEXT NOT NULL REFERENCES ${this.tables.identities}(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        connector_key TEXT,
        external_actor_id TEXT,
        external_channel_id TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_identity_bindings_unique_idx`)}
      ON ${this.tables.identityBindings} (
        source,
        COALESCE(connector_key, ''),
        COALESCE(external_actor_id, ''),
        COALESCE(external_channel_id, '')
      )
    `);
    await this.pool.query(`
      INSERT INTO ${this.tables.identities} (
        id,
        handle,
        display_name,
        status
      ) VALUES (
        $1,
        $2,
        $3,
        $4
      )
      ON CONFLICT (id) DO NOTHING;
    `, [
      localIdentity.id,
      normalizeHandle(localIdentity.handle),
      localIdentity.displayName,
      localIdentity.status ?? "active",
    ]);
  }

  async createIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.identities} (
        id,
        handle,
        display_name,
        status,
        metadata
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb
      )
      RETURNING *
    `, [
      input.id,
      normalizeHandle(input.handle),
      input.displayName,
      input.status ?? "active",
      toJson(input.metadata),
    ]);

    return parseIdentityRow(result.rows[0] as Record<string, unknown>);
  }

  async ensureIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    const existingResult = await this.pool.query(
      `SELECT * FROM ${this.tables.identities} WHERE id = $1`,
      [input.id],
    );

    const existing = existingResult.rows[0];
    if (existing) {
      return parseIdentityRow(existing as Record<string, unknown>);
    }

    return this.createIdentity(input);
  }

  async getIdentity(identityId: string): Promise<IdentityRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.identities} WHERE id = $1`,
      [identityId],
    );

    const row = result.rows[0];
    if (!row) {
      throw missingIdentityError(identityId);
    }

    return parseIdentityRow(row as Record<string, unknown>);
  }

  async getIdentityByHandle(handle: string): Promise<IdentityRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.identities} WHERE handle = $1`,
      [normalizeHandle(handle)],
    );

    const row = result.rows[0];
    if (!row) {
      throw missingIdentityHandleError(handle);
    }

    return parseIdentityRow(row as Record<string, unknown>);
  }

  async listIdentities(): Promise<readonly IdentityRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.identities} ORDER BY created_at ASC`,
    );

    return result.rows.map((row) => parseIdentityRow(row as Record<string, unknown>));
  }
}
