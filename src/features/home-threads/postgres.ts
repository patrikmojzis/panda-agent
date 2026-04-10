import type {Pool, PoolClient} from "pg";

import {quoteIdentifier, toJson, toMillis} from "../thread-runtime/postgres-shared.js";
import {buildHomeThreadTableNames, type HomeThreadTableNames} from "./postgres-shared.js";
import type {HomeThreadStore} from "./store.js";
import type {
    BindHomeThreadResult,
    ClaimHomeThreadHeartbeatInput,
    HomeThreadBindingInput,
    HomeThreadHeartbeatState,
    HomeThreadLookup,
    HomeThreadMetadata,
    HomeThreadRecord,
    ListDueHomeThreadHeartbeatsInput,
    RecordHomeThreadHeartbeatResultInput,
    UpdateHomeThreadHeartbeatConfigInput,
} from "./types.js";
import {DEFAULT_HOME_THREAD_HEARTBEAT_EVERY_MINUTES} from "./types.js";

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

function normalizeHeartbeatEveryMinutes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_HOME_THREAD_HEARTBEAT_EVERY_MINUTES;
  }

  return Math.floor(parsed);
}

function requireHeartbeatEveryMinutes(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Home thread heartbeat interval must be a positive integer.");
  }

  return value;
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

function parseHomeThreadHeartbeat(row: Record<string, unknown>): HomeThreadHeartbeatState {
  const everyMinutes = normalizeHeartbeatEveryMinutes(row.heartbeat_every_minutes);
  const nextFireAt = row.heartbeat_next_fire_at === null || row.heartbeat_next_fire_at === undefined
    ? Date.now() + everyMinutes * 60_000
    : toMillis(row.heartbeat_next_fire_at);

  return {
    enabled: row.heartbeat_enabled === undefined ? true : Boolean(row.heartbeat_enabled),
    everyMinutes,
    nextFireAt,
    lastFireAt: row.heartbeat_last_fire_at === null ? undefined : toMillis(row.heartbeat_last_fire_at),
    lastSkipReason: row.heartbeat_last_skip_reason === null || row.heartbeat_last_skip_reason === undefined
      ? undefined
      : String(row.heartbeat_last_skip_reason),
    claimedAt: row.heartbeat_claimed_at === null ? undefined : toMillis(row.heartbeat_claimed_at),
    claimedBy: row.heartbeat_claimed_by === null || row.heartbeat_claimed_by === undefined
      ? undefined
      : String(row.heartbeat_claimed_by),
    claimExpiresAt: row.heartbeat_claim_expires_at === null
      ? undefined
      : toMillis(row.heartbeat_claim_expires_at),
  };
}

function parseHomeThreadRow(row: Record<string, unknown>): HomeThreadRecord {
  return {
    identityId: String(row.identity_id),
    threadId: String(row.thread_id),
    metadata: parseHomeThreadMetadata(row.metadata),
    heartbeat: parseHomeThreadHeartbeat(row),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505";
}

function missingHomeThreadError(identityId: string): Error {
  return new Error(`Unknown home thread for identity ${identityId}`);
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
        heartbeat_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        heartbeat_every_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_HOME_THREAD_HEARTBEAT_EVERY_MINUTES},
        heartbeat_next_fire_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '${DEFAULT_HOME_THREAD_HEARTBEAT_EVERY_MINUTES} minutes',
        heartbeat_last_fire_at TIMESTAMPTZ,
        heartbeat_last_skip_reason TEXT,
        heartbeat_claimed_at TIMESTAMPTZ,
        heartbeat_claimed_by TEXT,
        heartbeat_claim_expires_at TIMESTAMPTZ,
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
      ALTER TABLE ${this.tables.homeThreads}
      ADD COLUMN IF NOT EXISTS heartbeat_enabled BOOLEAN NOT NULL DEFAULT TRUE
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.homeThreads}
      ADD COLUMN IF NOT EXISTS heartbeat_every_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_HOME_THREAD_HEARTBEAT_EVERY_MINUTES}
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.homeThreads}
      ADD COLUMN IF NOT EXISTS heartbeat_next_fire_at TIMESTAMPTZ
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.homeThreads}
      ADD COLUMN IF NOT EXISTS heartbeat_last_fire_at TIMESTAMPTZ
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.homeThreads}
      ADD COLUMN IF NOT EXISTS heartbeat_last_skip_reason TEXT
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.homeThreads}
      ADD COLUMN IF NOT EXISTS heartbeat_claimed_at TIMESTAMPTZ
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.homeThreads}
      ADD COLUMN IF NOT EXISTS heartbeat_claimed_by TEXT
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.homeThreads}
      ADD COLUMN IF NOT EXISTS heartbeat_claim_expires_at TIMESTAMPTZ
    `);
    await this.pool.query(`
      UPDATE ${this.tables.homeThreads}
      SET heartbeat_next_fire_at = COALESCE(
        heartbeat_next_fire_at,
        NOW() + INTERVAL '${DEFAULT_HOME_THREAD_HEARTBEAT_EVERY_MINUTES} minutes'
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_home_threads_thread_id_idx`)}
      ON ${this.tables.homeThreads} (thread_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_home_threads_heartbeat_due_idx`)}
      ON ${this.tables.homeThreads} (
        heartbeat_enabled,
        heartbeat_next_fire_at,
        heartbeat_claim_expires_at,
        identity_id
      )
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

  async listDueHeartbeats(
    input: ListDueHomeThreadHeartbeatsInput = {},
  ): Promise<readonly HomeThreadRecord[]> {
    const asOf = new Date(input.asOf ?? Date.now());
    const limit = input.limit ?? 100;
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.homeThreads}
        WHERE heartbeat_enabled = TRUE
          AND heartbeat_next_fire_at IS NOT NULL
          AND heartbeat_next_fire_at <= $1
          AND (
            heartbeat_claim_expires_at IS NULL
            OR heartbeat_claim_expires_at <= $1
          )
        ORDER BY heartbeat_next_fire_at ASC, identity_id ASC
        LIMIT $2
      `,
      [asOf, limit],
    );

    return result.rows.map((row) => parseHomeThreadRow(row as Record<string, unknown>));
  }

  async claimHeartbeat(input: ClaimHomeThreadHeartbeatInput): Promise<HomeThreadRecord | null> {
    const lookup = normalizeHomeThreadLookup(input);
    const claimedBy = requireTrimmedHomeThreadKeyPart("heartbeat claimant", input.claimedBy);
    const asOf = new Date(input.asOf ?? Date.now());
    const claimExpiresAt = new Date(input.claimExpiresAt);
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.homeThreads}
        SET heartbeat_claimed_at = NOW(),
            heartbeat_claimed_by = $2,
            heartbeat_claim_expires_at = $3,
            updated_at = NOW()
        WHERE identity_id = $1
          AND heartbeat_enabled = TRUE
          AND heartbeat_next_fire_at IS NOT NULL
          AND heartbeat_next_fire_at <= $4
          AND (
            heartbeat_claim_expires_at IS NULL
            OR heartbeat_claim_expires_at <= $4
          )
        RETURNING *
      `,
      [lookup.identityId, claimedBy, claimExpiresAt, asOf],
    );

    const row = result.rows[0];
    return row ? parseHomeThreadRow(row as Record<string, unknown>) : null;
  }

  async recordHeartbeatResult(input: RecordHomeThreadHeartbeatResultInput): Promise<HomeThreadRecord> {
    const lookup = normalizeHomeThreadLookup(input);
    const claimedBy = requireTrimmedHomeThreadKeyPart("heartbeat claimant", input.claimedBy);
    const nextFireAt = new Date(input.nextFireAt);
    const lastFireAt = input.lastFireAt === undefined ? null : new Date(input.lastFireAt);
    const lastSkipReason = input.lastSkipReason === undefined ? null : input.lastSkipReason;
    const result = await this.pool.query(
      `
        UPDATE ${this.tables.homeThreads}
        SET heartbeat_next_fire_at = $3,
            heartbeat_last_fire_at = COALESCE($4, heartbeat_last_fire_at),
            heartbeat_last_skip_reason = $5,
            heartbeat_claimed_at = NULL,
            heartbeat_claimed_by = NULL,
            heartbeat_claim_expires_at = NULL,
            updated_at = NOW()
        WHERE identity_id = $1
          AND heartbeat_claimed_by = $2
        RETURNING *
      `,
      [lookup.identityId, claimedBy, nextFireAt, lastFireAt, lastSkipReason],
    );

    const row = result.rows[0];
    if (!row) {
      throw missingHomeThreadError(lookup.identityId);
    }

    return parseHomeThreadRow(row as Record<string, unknown>);
  }

  async updateHeartbeatConfig(input: UpdateHomeThreadHeartbeatConfigInput): Promise<HomeThreadRecord> {
    const lookup = normalizeHomeThreadLookup(input);
    const requestedEveryMinutes = input.everyMinutes === undefined
      ? undefined
      : requireHeartbeatEveryMinutes(input.everyMinutes);
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const existingResult = await client.query(
        `
          SELECT *
          FROM ${this.tables.homeThreads}
          WHERE identity_id = $1
          FOR UPDATE
        `,
        [lookup.identityId],
      );
      const existingRow = existingResult.rows[0];
      if (!existingRow) {
        throw missingHomeThreadError(lookup.identityId);
      }

      const existing = parseHomeThreadRow(existingRow as Record<string, unknown>);
      const nextEnabled = input.enabled ?? existing.heartbeat.enabled;
      const nextEveryMinutes = requestedEveryMinutes === undefined
        ? existing.heartbeat.everyMinutes
        : requestedEveryMinutes;
      const hasConfigChange = input.enabled !== undefined || input.everyMinutes !== undefined;
      const nextFireAt = hasConfigChange
        ? new Date((input.asOf ?? Date.now()) + nextEveryMinutes * 60_000)
        : new Date(existing.heartbeat.nextFireAt);

      const updatedResult = await client.query(
        `
          UPDATE ${this.tables.homeThreads}
          SET heartbeat_enabled = $2,
              heartbeat_every_minutes = $3,
              heartbeat_next_fire_at = $4,
              heartbeat_claimed_at = NULL,
              heartbeat_claimed_by = NULL,
              heartbeat_claim_expires_at = NULL,
              updated_at = NOW()
          WHERE identity_id = $1
          RETURNING *
        `,
        [lookup.identityId, nextEnabled, nextEveryMinutes, nextFireAt],
      );
      const updatedRow = updatedResult.rows[0];
      if (!updatedRow) {
        throw missingHomeThreadError(lookup.identityId);
      }

      await client.query("COMMIT");
      inTransaction = false;

      return parseHomeThreadRow(updatedRow as Record<string, unknown>);
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK");
      }

      throw error;
    } finally {
      client.release();
    }
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
