import {randomUUID} from "node:crypto";

import {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {addConstraint} from "../../src/lib/postgres-integrity.js";
import {
  createPostgresMigrator,
  NonPrefixPostgresMigrationHistoryError,
  type PostgresMigration,
} from "../../src/lib/postgres-migrations.js";
import {quoteIdentifier} from "../../src/lib/postgres-relations.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const postgresIt = databaseUrl ? it : it.skip;
const configuredSchema = process.env.PANDA_MIGRATION_TEST_SCHEMA?.trim();
const schema = configuredSchema || `panda_migration_${randomUUID().replaceAll("-", "")}`;
if (!/^(?:basalt_scratch|panda_migration_[a-f0-9]+)$/.test(schema)) {
  throw new Error(`Unsafe Postgres migration test schema ${schema}.`);
}
const quotedSchema = quoteIdentifier(schema);
const CHECKSUM_1 = "1".repeat(64);
const CHECKSUM_2 = "2".repeat(64);
const CHECKSUM_3 = "3".repeat(64);
let pool: Pool;

function migrator(migrations: readonly PostgresMigration[]) {
  return createPostgresMigrator({
    pool,
    migrations,
    schemaName: schema,
    tableName: "schema_migrations",
    lockName: `panda:test-migrations:${schema}`,
  });
}

async function dropScratchSchema(): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
}

describe.sequential("Postgres migrator with PostgreSQL", () => {
  beforeAll(async () => {
    if (!databaseUrl) return;
    pool = new Pool({
      connectionString: databaseUrl,
      application_name: "panda/test-postgres-migrations",
      max: 4,
    });
    await dropScratchSchema();
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    await dropScratchSchema();
    await pool.end();
  });

  it("requires TEST_DATABASE_URL for the PostgreSQL contract check", () => {
    expect(databaseUrl).toMatch(/^postgres(?:ql)?:\/\//);
  });

  postgresIt("rolls back every body and ledger row when a pending batch fails", async () => {
    const failedBatch: readonly PostgresMigration[] = [
      {
        id: "0001_create_items",
        description: "Create migration test items",
        checksum: CHECKSUM_1,
        apply: async ({queryable}) => {
          await queryable.query(`CREATE TABLE ${quotedSchema}.items (id INTEGER PRIMARY KEY)`);
          await queryable.query(`INSERT INTO ${quotedSchema}.items (id) VALUES (1)`);
        },
      },
      {
        id: "0002_fail_items",
        description: "Fail migration test items",
        checksum: CHECKSUM_2,
        apply: async ({queryable}) => {
          await queryable.query(`INSERT INTO ${quotedSchema}.items (id) VALUES (2)`);
          throw new Error("intentional migration failure");
        },
      },
    ];

    await expect(migrator(failedBatch).migrate()).rejects.toThrow("intentional migration failure");

    const result = await pool.query("SELECT to_regclass($1) AS relation", [`${schema}.items`]);
    expect(result.rows).toEqual([{relation: null}]);
  });

  postgresIt("serializes concurrent migrators and makes the second run a no-op", async () => {
    const migrations: readonly PostgresMigration[] = [
      {
        id: "0001_create_items",
        description: "Create migration test items",
        checksum: CHECKSUM_1,
        apply: async ({queryable}) => {
          await queryable.query(`CREATE TABLE ${quotedSchema}.items (id INTEGER PRIMARY KEY)`);
          await queryable.query("SELECT pg_sleep(0.15)");
          await queryable.query(`INSERT INTO ${quotedSchema}.items (id) VALUES (1)`);
        },
      },
      {
        id: "0002_add_item",
        description: "Add a second migration test item",
        checksum: CHECKSUM_2,
        apply: async ({queryable}) => {
          await queryable.query(`INSERT INTO ${quotedSchema}.items (id) VALUES (2)`);
        },
      },
    ];

    const [first, second] = await Promise.all([
      migrator(migrations).migrate(),
      migrator(migrations).migrate(),
    ]);

    expect(first.current).toBe(true);
    expect(second.current).toBe(true);
    const items = await pool.query(`SELECT id FROM ${quotedSchema}.items ORDER BY id`);
    expect(items.rows).toEqual([{id: 1}, {id: 2}]);
    const ledger = await pool.query(`SELECT migration_id FROM ${quotedSchema}.schema_migrations ORDER BY migration_id`);
    expect(ledger.rows).toEqual([
      {migration_id: "0001_create_items"},
      {migration_id: "0002_add_item"},
    ]);
  });

  postgresIt("preflights existing named constraints without aborting the transaction", async () => {
    const constraintSql = `
      ALTER TABLE ${quotedSchema}.${quoteIdentifier("items")}
      ADD CONSTRAINT ${quoteIdentifier("items_positive")}
      CHECK (id > 0)
    `;
    const constraintMigration: PostgresMigration = {
      id: "0003_add_item_constraint",
      description: "Add the migration test item constraint",
      checksum: CHECKSUM_3,
      apply: async ({queryable}) => {
        await addConstraint(queryable, constraintSql);
        await addConstraint(queryable, constraintSql);
      },
    };
    const migrations: readonly PostgresMigration[] = [
      {
        id: "0001_create_items",
        description: "Create migration test items",
        checksum: CHECKSUM_1,
        apply: async () => {},
      },
      {
        id: "0002_add_item",
        description: "Add a second migration test item",
        checksum: CHECKSUM_2,
        apply: async () => {},
      },
      constraintMigration,
    ];

    await expect(migrator(migrations).migrate()).resolves.toMatchObject({current: true});
    await expect(pool.query(`INSERT INTO ${quotedSchema}.items (id) VALUES (-1)`))
      .rejects.toMatchObject({code: "23514"});
  });

  postgresIt("refuses a tampered ledger that is not an exact catalog prefix", async () => {
    await pool.query(`DELETE FROM ${quotedSchema}.schema_migrations WHERE migration_id = '0001_create_items'`);
    const migrations: readonly PostgresMigration[] = [
      {id: "0001_create_items", description: "Create migration test items", checksum: CHECKSUM_1, apply: async () => {}},
      {id: "0002_add_item", description: "Add a second migration test item", checksum: CHECKSUM_2, apply: async () => {}},
      {id: "0003_add_item_constraint", description: "Add the migration test item constraint", checksum: CHECKSUM_3, apply: async () => {}},
    ];

    await expect(migrator(migrations).migrate())
      .rejects.toBeInstanceOf(NonPrefixPostgresMigrationHistoryError);
  });
});
