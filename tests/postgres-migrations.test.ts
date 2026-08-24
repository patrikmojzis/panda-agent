import {describe, expect, it, vi} from "vitest";

import {
  ChangedPostgresMigrationError,
  createPostgresMigrator,
  NonPrefixPostgresMigrationHistoryError,
  PendingPostgresMigrationsError,
  PostgresMigrationDdlLockTimeoutError,
  PostgresMigrationLockTimeoutError,
  type PostgresMigration,
  UnknownPostgresMigrationsError,
} from "../src/lib/postgres-migrations.js";
import type {PgClientLike, PgPoolLike, PgQueryResult} from "../src/lib/postgres-query.js";

interface LedgerRow {
  migration_id: string;
  description: string;
  checksum: string;
  applied_at: Date;
  duration_ms: number;
}

const ALPHA_CHECKSUM = "a".repeat(64);
const BETA_CHECKSUM = "b".repeat(64);

class MigrationDatabaseFake implements PgPoolLike {
  readonly queries: Array<{sql: string; params: readonly unknown[]}> = [];
  readonly work: string[] = [];
  readonly reconciled: string[] = [];
  readonly ledger: LedgerRow[] = [];
  ledgerExists = false;
  releaseCount = 0;
  failLock = false;
  failDdlLock = false;
  private transactionSnapshot: {
    ledger: LedgerRow[];
    ledgerExists: boolean;
    work: string[];
    reconciled: string[];
  } | null = null;

  private readonly client: PgClientLike = {
    query: (sql, params) => this.query(sql, params),
    release: () => {
      this.releaseCount += 1;
    },
  };

  async connect(): Promise<PgClientLike> {
    return this.client;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.queries.push({sql: normalized, params});

    if (normalized === "BEGIN") {
      this.transactionSnapshot = {
        ledger: [...this.ledger],
        ledgerExists: this.ledgerExists,
        work: [...this.work],
        reconciled: [...this.reconciled],
      };
      return {rows: []};
    }
    if (normalized === "COMMIT") {
      this.transactionSnapshot = null;
      return {rows: []};
    }
    if (normalized === "ROLLBACK") {
      if (this.transactionSnapshot !== null) {
        this.ledger.splice(0, this.ledger.length, ...this.transactionSnapshot.ledger);
        this.ledgerExists = this.transactionSnapshot.ledgerExists;
        this.work.splice(0, this.work.length, ...this.transactionSnapshot.work);
        this.reconciled.splice(0, this.reconciled.length, ...this.transactionSnapshot.reconciled);
      }
      this.transactionSnapshot = null;
      return {rows: []};
    }
    if (normalized.includes("pg_advisory_xact_lock") && this.failLock) {
      throw Object.assign(new Error("canceling statement due to lock timeout"), {code: "55P03"});
    }

    if (normalized.includes("FROM information_schema.tables")) {
      return {
        rows: this.ledgerExists ? [{table_schema: "runtime"}] : [],
      };
    }
    if (normalized.startsWith("SELECT to_regclass")) {
      return {rows: [{relation: this.ledgerExists ? "runtime.schema_migrations" : null}]};
    }
    if (normalized.startsWith("CREATE TABLE")) {
      this.ledgerExists = true;
      return {rows: []};
    }
    if (normalized.includes("SELECT migration_id, description, checksum, applied_at, duration_ms")) {
      return {rows: [...this.ledger]};
    }
    if (normalized.startsWith("INSERT INTO \"runtime\".\"schema_migrations\"")) {
      this.ledger.push({
        migration_id: String(params[0]),
        description: String(params[1]),
        checksum: String(params[2]),
        applied_at: new Date("2026-08-24T20:00:00.000Z"),
        duration_ms: Number(params[3]),
      });
      return {rows: [], rowCount: 1};
    }
    if (normalized.startsWith("SELECT record_work")) {
      if (this.failDdlLock) {
        throw Object.assign(new Error("canceling statement due to lock timeout"), {code: "55P03"});
      }
      this.work.push(String(params[0]));
      return {rows: []};
    }
    if (normalized.startsWith("SELECT record_reconciliation")) {
      this.reconciled.push(String(params[0]));
      return {rows: []};
    }

    return {rows: []};
  }
}

function createMigrations(options: {failSecond?: boolean} = {}): readonly PostgresMigration[] {
  return [
    {
      id: "0001_create_alpha",
      description: "Create alpha",
      checksum: ALPHA_CHECKSUM,
      apply: async ({queryable}) => {
        await queryable.query("SELECT record_work($1)", ["alpha"]);
      },
    },
    {
      id: "0002_create_beta",
      description: "Create beta",
      checksum: BETA_CHECKSUM,
      apply: async ({queryable}) => {
        if (options.failSecond) {
          throw new Error("beta failed");
        }
        await queryable.query("SELECT record_work($1)", ["beta"]);
      },
    },
  ];
}

function createMigrator(database: MigrationDatabaseFake, migrations = createMigrations()) {
  let time = 1_000;
  return createPostgresMigrator({
    pool: database,
    migrations,
    schemaName: "runtime",
    tableName: "schema_migrations",
    lockName: "panda:schema-migrations",
    now: () => {
      time += 5;
      return time;
    },
  });
}

describe("Postgres migrator", () => {
  it("reports every migration pending when the ledger does not exist", async () => {
    const status = await createMigrator(new MigrationDatabaseFake()).status();

    expect(status).toEqual({
      applied: [],
      pending: [
        {id: "0001_create_alpha", description: "Create alpha", checksum: ALPHA_CHECKSUM},
        {id: "0002_create_beta", description: "Create beta", checksum: BETA_CHECKSUM},
      ],
      unknownApplied: [],
      nonPrefixApplied: [],
      changedApplied: [],
      current: false,
    });
  });

  it("applies missing migrations once and makes later runs no-ops", async () => {
    const database = new MigrationDatabaseFake();
    const migrator = createMigrator(database);

    const first = await migrator.migrate();
    const second = await migrator.migrate();

    expect(first.current).toBe(true);
    expect(second.current).toBe(true);
    expect(database.work).toEqual(["alpha", "beta"]);
    expect(database.ledger.map((row) => row.migration_id)).toEqual([
      "0001_create_alpha",
      "0002_create_beta",
    ]);
    expect(database.queries.filter(({sql}) => sql.startsWith("CREATE SCHEMA"))).toHaveLength(1);
    expect(database.queries.filter(({sql}) => sql.startsWith("CREATE TABLE"))).toHaveLength(1);
    expect(database.queries.filter(({sql, params}) => (
      sql.includes("set_config('lock_timeout', $1") && params[0] === "300000ms"
    ))).toHaveLength(2);
  });

  it("rolls back the entire pending batch and releases the connection when a migration fails", async () => {
    const database = new MigrationDatabaseFake();

    await expect(createMigrator(database, createMigrations({failSecond: true})).migrate())
      .rejects.toThrow("beta failed");

    expect(database.work).toEqual([]);
    expect(database.ledger).toEqual([]);
    expect(database.ledgerExists).toBe(false);
    expect(database.releaseCount).toBe(1);
    expect(database.queries.some(({sql}) => sql === "ROLLBACK")).toBe(true);
    expect(database.queries.some(({sql}) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
  });

  it("rejects runtime startup with the exact pending migrations", async () => {
    const migrator = createMigrator(new MigrationDatabaseFake());

    await expect(migrator.assertCurrent()).rejects.toEqual(
      expect.objectContaining<Partial<PendingPostgresMigrationsError>>({
        name: "PendingPostgresMigrationsError",
        message: expect.stringContaining("0001_create_alpha, 0002_create_beta"),
      }),
    );
  });

  it("rejects duplicate or unsorted migration catalogs before touching Postgres", () => {
    const database = new MigrationDatabaseFake();
    const duplicate = createMigrations()[0];

    expect(() => createMigrator(database, [duplicate, duplicate])).toThrow("Duplicate Postgres migration id");
    expect(() => createMigrator(database, [createMigrations()[1], createMigrations()[0]]))
      .toThrow("must be ordered by id");
    expect(database.queries).toEqual([]);
  });

  it("rejects a database with migrations unknown to this build", async () => {
    const database = new MigrationDatabaseFake();
    database.ledgerExists = true;
    database.ledger.push({
      migration_id: "9999_future_schema",
      description: "Future schema",
      checksum: "f".repeat(64),
      applied_at: new Date("2026-08-24T20:00:00.000Z"),
      duration_ms: 1,
    });
    const migrator = createMigrator(database);

    await expect(migrator.assertCurrent()).rejects.toBeInstanceOf(UnknownPostgresMigrationsError);
    await expect(migrator.migrate()).rejects.toBeInstanceOf(UnknownPostgresMigrationsError);
    expect(database.work).toEqual([]);
    expect(database.ledger.map((row) => row.migration_id)).toEqual(["9999_future_schema"]);
  });

  it("rejects edits to metadata for an applied migration", async () => {
    const database = new MigrationDatabaseFake();
    database.ledgerExists = true;
    database.ledger.push({
      migration_id: "0001_create_alpha",
      description: "Old alpha description",
      checksum: ALPHA_CHECKSUM,
      applied_at: new Date("2026-08-24T20:00:00.000Z"),
      duration_ms: 1,
    });

    await expect(createMigrator(database).assertCurrent())
      .rejects.toBeInstanceOf(ChangedPostgresMigrationError);
  });

  it("refuses to run an older migration after a newer catalog entry is applied", async () => {
    const database = new MigrationDatabaseFake();
    database.ledgerExists = true;
    database.ledger.push({
      migration_id: "0002_create_beta",
      description: "Create beta",
      checksum: BETA_CHECKSUM,
      applied_at: new Date("2026-08-24T20:00:00.000Z"),
      duration_ms: 1,
    });

    await expect(createMigrator(database).migrate())
      .rejects.toBeInstanceOf(NonPrefixPostgresMigrationHistoryError);
    expect(database.work).toEqual([]);
  });

  it("rejects edits to the checksum of an applied migration", async () => {
    const database = new MigrationDatabaseFake();
    database.ledgerExists = true;
    database.ledger.push({
      migration_id: "0001_create_alpha",
      description: "Create alpha",
      checksum: "c".repeat(64),
      applied_at: new Date("2026-08-24T20:00:00.000Z"),
      duration_ms: 1,
    });

    await expect(createMigrator(database).assertCurrent())
      .rejects.toBeInstanceOf(ChangedPostgresMigrationError);
  });

  it("emits migration lifecycle logs through the migrator interface", async () => {
    const database = new MigrationDatabaseFake();
    const log = vi.fn();
    const migrator = createPostgresMigrator({
      pool: database,
      migrations: createMigrations().slice(0, 1),
      schemaName: "runtime",
      tableName: "schema_migrations",
      lockName: "panda:schema-migrations",
      log,
    });

    await migrator.migrate();

    expect(log).toHaveBeenCalledWith("migration_started", {
      id: "0001_create_alpha",
      description: "Create alpha",
    });
    expect(log).toHaveBeenCalledWith("migration_applied", expect.objectContaining({
      id: "0001_create_alpha",
      description: "Create alpha",
    }));
  });

  it("reconciles deploy configuration on every run in the migration transaction", async () => {
    const database = new MigrationDatabaseFake();
    const migrator = createPostgresMigrator({
      pool: database,
      migrations: createMigrations().slice(0, 1),
      schemaName: "runtime",
      tableName: "schema_migrations",
      lockName: "panda:schema-migrations",
      reconcile: async ({queryable}) => {
        await queryable.query("SELECT record_reconciliation($1)", ["readonly-role"]);
      },
    });

    await migrator.migrate();
    await migrator.migrate();

    expect(database.reconciled).toEqual(["readonly-role", "readonly-role"]);
  });

  it("reports a concurrent migrator lock timeout clearly and rolls back", async () => {
    const database = new MigrationDatabaseFake();
    database.failLock = true;

    await expect(createMigrator(database).migrate())
      .rejects.toBeInstanceOf(PostgresMigrationLockTimeoutError);

    expect(database.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(database.releaseCount).toBe(1);
  });

  it("bounds DDL lock waits separately from migrator coordination", async () => {
    const database = new MigrationDatabaseFake();
    database.failDdlLock = true;
    const migrator = createPostgresMigrator({
      pool: database,
      migrations: createMigrations(),
      schemaName: "runtime",
      tableName: "schema_migrations",
      lockName: "panda:schema-migrations",
      ddlLockTimeoutMs: 2_000,
    });

    await expect(migrator.migrate()).rejects.toEqual(
      expect.objectContaining<Partial<PostgresMigrationDdlLockTimeoutError>>({
        name: "PostgresMigrationDdlLockTimeoutError",
        migrationId: "0001_create_alpha",
        message: expect.stringContaining("Panda database writers must remain stopped"),
      }),
    );
    expect(database.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(database.ledger).toEqual([]);
  });
});
