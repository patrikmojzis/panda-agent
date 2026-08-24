import type {PgPoolLike, PgQueryable} from "./postgres-query.js";
import {postgresRelationExists, quoteIdentifier, quoteQualifiedIdentifier, validateIdentifier} from "./postgres-relations.js";
import {requireTimestampMillis} from "./postgres-values.js";
import {requireNonEmptyString} from "./strings.js";

const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_MIGRATION_DDL_LOCK_TIMEOUT_MS = 300_000;
const MIGRATION_ID_PATTERN = /^\d{4,}_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const MIGRATION_CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export interface PostgresMigrationContext {
  /**
   * The transaction holding the migration advisory lock. This is deliberately
   * the only database seam: a migration must not commit work independently.
   */
  queryable: PgQueryable;
}

export interface PostgresMigration extends PostgresMigrationSummary {
  apply(context: PostgresMigrationContext): Promise<void>;
}

export interface PostgresMigrationSummary {
  id: string;
  description: string;
  /** SHA-256 of the immutable migration body and any frozen schema sources it executes. */
  checksum: string;
}

export interface AppliedPostgresMigration extends PostgresMigrationSummary {
  appliedAt: number;
  durationMs: number;
}

export interface PostgresMigrationStatus {
  applied: readonly AppliedPostgresMigration[];
  pending: readonly PostgresMigrationSummary[];
  unknownApplied: readonly AppliedPostgresMigration[];
  nonPrefixApplied: readonly AppliedPostgresMigration[];
  changedApplied: readonly {
    id: string;
    catalogDescription: string;
    appliedDescription: string;
    catalogChecksum: string;
    appliedChecksum: string;
  }[];
  current: boolean;
}

export interface PostgresMigrationLog {
  (event: "migration_started" | "migration_applied", payload: {
    id: string;
    description: string;
    durationMs?: number;
  }): void;
}

export interface PostgresMigrator {
  status(): Promise<PostgresMigrationStatus>;
  migrate(): Promise<PostgresMigrationStatus>;
  assertCurrent(): Promise<void>;
}

export interface PostgresMigrationVerifier {
  status(): Promise<PostgresMigrationStatus>;
  assertCurrent(): Promise<void>;
}

export class PendingPostgresMigrationsError extends Error {
  readonly pending: readonly PostgresMigrationSummary[];

  constructor(pending: readonly PostgresMigrationSummary[]) {
    const ids = pending.map((migration) => migration.id);
    super(
      `Database schema is behind this Panda build. Pending migrations: ${ids.join(", ")}. Stop Panda database writers, then run: panda db migrate --writers-stopped`,
    );
    this.name = "PendingPostgresMigrationsError";
    this.pending = pending;
  }
}

export class UnknownPostgresMigrationsError extends Error {
  readonly unknownApplied: readonly AppliedPostgresMigration[];

  constructor(unknownApplied: readonly AppliedPostgresMigration[]) {
    const ids = unknownApplied.map((migration) => migration.id);
    super(
      `Database schema is newer than this Panda build. Unknown applied migrations: ${ids.join(", ")}. Deploy a matching or newer build.`,
    );
    this.name = "UnknownPostgresMigrationsError";
    this.unknownApplied = unknownApplied;
  }
}

export class ChangedPostgresMigrationError extends Error {
  readonly changedApplied: PostgresMigrationStatus["changedApplied"];

  constructor(changedApplied: PostgresMigrationStatus["changedApplied"]) {
    const ids = changedApplied.map((migration) => migration.id);
    super(`Applied Postgres migrations were changed in this build: ${ids.join(", ")}. Restore their immutable catalog metadata.`);
    this.name = "ChangedPostgresMigrationError";
    this.changedApplied = changedApplied;
  }
}

export class NonPrefixPostgresMigrationHistoryError extends Error {
  readonly nonPrefixApplied: readonly AppliedPostgresMigration[];

  constructor(nonPrefixApplied: readonly AppliedPostgresMigration[]) {
    const ids = nonPrefixApplied.map((migration) => migration.id);
    super(`Postgres migration history is not a catalog prefix. Refusing to run older migrations after: ${ids.join(", ")}.`);
    this.name = "NonPrefixPostgresMigrationHistoryError";
    this.nonPrefixApplied = nonPrefixApplied;
  }
}

export class PostgresMigrationLockTimeoutError extends Error {
  constructor(lockTimeoutMs: number, options: {cause: unknown}) {
    super(`Timed out after ${lockTimeoutMs}ms waiting for another Panda database migration to finish.`, options);
    this.name = "PostgresMigrationLockTimeoutError";
  }
}

export class PostgresMigrationDdlLockTimeoutError extends Error {
  readonly migrationId: string | null;

  constructor(ddlLockTimeoutMs: number, migrationId: string | null, options: {cause: unknown}) {
    const target = migrationId === null
      ? "deployment configuration reconciliation"
      : `migration ${migrationId}`;
    super(`Timed out after ${ddlLockTimeoutMs}ms waiting for a database lock while applying ${target}. Panda database writers must remain stopped.`, options);
    this.name = "PostgresMigrationDdlLockTimeoutError";
    this.migrationId = migrationId;
  }
}

function isLockTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {code?: unknown; message?: unknown};
  return candidate.code === "55P03"
    || (typeof candidate.message === "string" && candidate.message.includes("lock timeout"));
}

export interface CreatePostgresMigratorOptions {
  pool: PgPoolLike;
  migrations: readonly PostgresMigration[];
  schemaName: string;
  tableName: string;
  lockName: string;
  lockTimeoutMs?: number;
  ddlLockTimeoutMs?: number;
  /** Reconciles deploy-time database configuration inside the migration transaction. */
  reconcile?: (context: PostgresMigrationContext) => Promise<void>;
  log?: PostgresMigrationLog;
  now?: () => number;
}

export interface CreatePostgresMigrationVerifierOptions {
  pool: PgPoolLike;
  migrations: readonly PostgresMigrationSummary[];
  schemaName: string;
  tableName: string;
}

function validateMigrationSummaries(
  migrations: readonly PostgresMigrationSummary[],
): readonly PostgresMigrationSummary[] {
  const seen = new Set<string>();
  let previousId: string | null = null;

  for (const migration of migrations) {
    const id = requireNonEmptyString(migration.id, "Postgres migration id must not be empty.");
    requireNonEmptyString(migration.description, `Postgres migration ${id} description must not be empty.`);
    const checksum = requireNonEmptyString(
      migration.checksum,
      `Postgres migration ${id} checksum must not be empty.`,
    );
    if (!MIGRATION_ID_PATTERN.test(id)) {
      throw new Error(
        `Invalid Postgres migration id ${id}. Use a sortable id such as 0001_create_runtime_schema.`,
      );
    }
    if (!MIGRATION_CHECKSUM_PATTERN.test(checksum)) {
      throw new Error(`Postgres migration ${id} checksum must be a lowercase SHA-256 digest.`);
    }
    if (seen.has(id)) throw new Error(`Duplicate Postgres migration id ${id}.`);
    if (previousId !== null && id <= previousId) {
      throw new Error(`Postgres migrations must be ordered by id: ${id} follows ${previousId}.`);
    }
    seen.add(id);
    previousId = id;
  }

  return migrations.map(({id, description, checksum}) => ({id, description, checksum}));
}

function validateMigrationCatalog(migrations: readonly PostgresMigration[]): readonly PostgresMigration[] {
  validateMigrationSummaries(migrations);
  for (const migration of migrations) {
    const id = migration.id;
    if (typeof migration.apply !== "function") {
      throw new Error(`Postgres migration ${id} must provide an apply function.`);
    }
  }

  return [...migrations];
}

function requireDurationMs(value: unknown, migrationId: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Postgres migration ${migrationId} duration must be a non-negative integer.`);
  }
  return parsed;
}

function parseAppliedMigration(row: unknown): AppliedPostgresMigration {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Postgres migration ledger returned an invalid row.");
  }

  const record = row as Record<string, unknown>;
  const id = requireNonEmptyString(record.migration_id, "Applied Postgres migration id must not be empty.");
  return {
    id,
    description: requireNonEmptyString(
      record.description,
      `Applied Postgres migration ${id} description must not be empty.`,
    ),
    checksum: requireNonEmptyString(
      record.checksum,
      `Applied Postgres migration ${id} checksum must not be empty.`,
    ),
    appliedAt: requireTimestampMillis(
      record.applied_at,
      `Applied Postgres migration ${id} timestamp must be valid.`,
    ),
    durationMs: requireDurationMs(record.duration_ms, id),
  };
}

function buildStatus(
  migrations: readonly PostgresMigrationSummary[],
  applied: readonly AppliedPostgresMigration[],
): PostgresMigrationStatus {
  const catalogIds = new Set(migrations.map((migration) => migration.id));
  const catalogById = new Map(migrations.map((migration) => [migration.id, migration]));
  const appliedIds = new Set(applied.map((migration) => migration.id));
  const pending = migrations
    .filter((migration) => !appliedIds.has(migration.id))
    .map(({id, description, checksum}) => ({id, description, checksum}));
  const unknownApplied = applied.filter((migration) => !catalogIds.has(migration.id));
  const firstPendingIndex = migrations.findIndex((migration) => !appliedIds.has(migration.id));
  const nonPrefixIds = new Set(
    firstPendingIndex < 0
      ? []
      : migrations.slice(firstPendingIndex + 1)
        .filter((migration) => appliedIds.has(migration.id))
        .map((migration) => migration.id),
  );
  const nonPrefixApplied = applied.filter((migration) => nonPrefixIds.has(migration.id));
  const changedApplied = applied.flatMap((migration) => {
    const catalogMigration = catalogById.get(migration.id);
    return catalogMigration && (
      catalogMigration.description !== migration.description
      || catalogMigration.checksum !== migration.checksum
    )
      ? [{
          id: migration.id,
          catalogDescription: catalogMigration.description,
          appliedDescription: migration.description,
          catalogChecksum: catalogMigration.checksum,
          appliedChecksum: migration.checksum,
        }]
      : [];
  });

  return {
    applied,
    pending,
    unknownApplied,
    nonPrefixApplied,
    changedApplied,
    current: pending.length === 0
      && unknownApplied.length === 0
      && nonPrefixApplied.length === 0
      && changedApplied.length === 0,
  };
}

function assertCompatible(status: PostgresMigrationStatus): void {
  if (status.unknownApplied.length > 0) {
    throw new UnknownPostgresMigrationsError(status.unknownApplied);
  }
  if (status.nonPrefixApplied.length > 0) {
    throw new NonPrefixPostgresMigrationHistoryError(status.nonPrefixApplied);
  }
  if (status.changedApplied.length > 0) {
    throw new ChangedPostgresMigrationError(status.changedApplied);
  }
  if (status.pending.length > 0) {
    throw new PendingPostgresMigrationsError(status.pending);
  }
}

async function readAppliedMigrations(input: {
  queryable: PgQueryable;
  schemaName: string;
  tableName: string;
  relationName: string;
  relationKnownToExist?: boolean;
}): Promise<readonly AppliedPostgresMigration[]> {
  if (!input.relationKnownToExist
    && !await postgresRelationExists(input.queryable, input.schemaName, input.tableName)) {
    return [];
  }

  const result = await input.queryable.query(`
    SELECT migration_id, description, checksum, applied_at, duration_ms
    FROM ${input.relationName}
    ORDER BY applied_at, migration_id
  `);
  return result.rows.map(parseAppliedMigration);
}

export function createPostgresMigrationVerifier(
  options: CreatePostgresMigrationVerifierOptions,
): PostgresMigrationVerifier {
  const migrations = validateMigrationSummaries(options.migrations);
  const schemaName = validateIdentifier(options.schemaName);
  const tableName = validateIdentifier(options.tableName);
  const relationName = quoteQualifiedIdentifier(schemaName, tableName);
  const status = async (): Promise<PostgresMigrationStatus> => {
    const applied = await readAppliedMigrations({
      queryable: options.pool,
      schemaName,
      tableName,
      relationName,
    });
    return buildStatus(migrations, applied);
  };
  return {
    status,
    assertCurrent: async () => assertCompatible(await status()),
  };
}

/**
 * Creates the single migration seam used by deploys and runtime verification.
 * Every pending body and its ledger row share one transaction. A failed batch
 * therefore leaves neither half-applied schema nor misleading ledger entries.
 */
export function createPostgresMigrator(options: CreatePostgresMigratorOptions): PostgresMigrator {
  const migrations = validateMigrationCatalog(options.migrations);
  const schemaName = validateIdentifier(options.schemaName);
  const tableName = validateIdentifier(options.tableName);
  const relationName = quoteQualifiedIdentifier(schemaName, tableName);
  const lockName = requireNonEmptyString(options.lockName, "Postgres migration lock name must not be empty.");
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new Error("Postgres migration lock timeout must be a positive integer.");
  }
  const ddlLockTimeoutMs = options.ddlLockTimeoutMs ?? DEFAULT_MIGRATION_DDL_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(ddlLockTimeoutMs) || ddlLockTimeoutMs <= 0) {
    throw new Error("Postgres migration DDL lock timeout must be a positive integer.");
  }
  const now = options.now ?? Date.now;

  const verifier = createPostgresMigrationVerifier({
    pool: options.pool,
    migrations,
    schemaName,
    tableName,
  });

  return {
    status: verifier.status,
    assertCurrent: verifier.assertCurrent,
    migrate: async () => {
      const client = await options.pool.connect();
      let operationError: unknown;
      let transactionOpen = false;
      const appliedLogs: Array<Parameters<PostgresMigrationLog>[1]> = [];

      try {
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
        // A transaction-scoped lock cannot leak when a pooled client is reused.
        try {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockName]);
        } catch (error) {
          if (isLockTimeoutError(error)) {
            throw new PostgresMigrationLockTimeoutError(lockTimeoutMs, {cause: error});
          }
          throw error;
        }
        // Advisory-lock contention and application-table contention are
        // different failures. Keep both bounded, but report the latter as an
        // unsafe writer-quiescence problem instead of a competing migrator.
        await client.query("SELECT set_config('lock_timeout', $1, true)", [`${ddlLockTimeoutMs}ms`]);
        const ledgerExists = await postgresRelationExists(client, schemaName, tableName);
        if (!ledgerExists) {
          await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`);
          await client.query(`
            CREATE TABLE ${relationName} (
              migration_id TEXT PRIMARY KEY,
              description TEXT NOT NULL,
              checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
              applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0)
            )
          `);
        }

        const applied = await readAppliedMigrations({
          queryable: client,
          schemaName,
          tableName,
          relationName,
          relationKnownToExist: true,
        });
        const initialStatus = buildStatus(migrations, applied);
        if (
          initialStatus.unknownApplied.length > 0
          || initialStatus.nonPrefixApplied.length > 0
          || initialStatus.changedApplied.length > 0
        ) {
          assertCompatible(initialStatus);
        }
        const appliedIds = new Set(applied.map((migration) => migration.id));

        for (const migration of migrations) {
          if (appliedIds.has(migration.id)) {
            continue;
          }

          options.log?.("migration_started", {
            id: migration.id,
            description: migration.description,
          });
          const startedAt = now();
          try {
            await migration.apply({queryable: client});
          } catch (error) {
            if (isLockTimeoutError(error)) {
              throw new PostgresMigrationDdlLockTimeoutError(ddlLockTimeoutMs, migration.id, {cause: error});
            }
            throw error;
          }
          const durationMs = Math.max(0, now() - startedAt);
          await client.query(`
            INSERT INTO ${relationName} (migration_id, description, checksum, duration_ms)
            VALUES ($1, $2, $3, $4)
          `, [migration.id, migration.description, migration.checksum, durationMs]);
          appliedIds.add(migration.id);
          appliedLogs.push({
            id: migration.id,
            description: migration.description,
            durationMs,
          });
        }
        try {
          await options.reconcile?.({queryable: client});
        } catch (error) {
          if (isLockTimeoutError(error)) {
            throw new PostgresMigrationDdlLockTimeoutError(ddlLockTimeoutMs, null, {cause: error});
          }
          throw error;
        }

        const finalApplied = await readAppliedMigrations({
          queryable: client,
          schemaName,
          tableName,
          relationName,
          relationKnownToExist: true,
        });
        const finalStatus = buildStatus(migrations, finalApplied);
        await client.query("COMMIT");
        transactionOpen = false;
        for (const payload of appliedLogs) {
          options.log?.("migration_applied", payload);
        }
        return finalStatus;
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        try {
          if (transactionOpen) {
            await client.query("ROLLBACK");
          }
        } catch (rollbackError) {
          if (operationError === undefined) {
            throw rollbackError;
          }
        } finally {
          client.release();
        }
      }
    },
  };
}
