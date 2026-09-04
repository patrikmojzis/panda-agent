import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import {createPostgresMigrator} from "../../src/lib/postgres-migrations.js";
import {HEARTBEAT_CADENCE_MIGRATION} from "../../src/app/database/migrations/0019-heartbeat-cadence.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

describe.skipIf(!databaseUrl)("heartbeat cadence migration on PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;

  beforeEach(async () => {
    const target = await recreateSmokeDatabase(databaseUrl!);
    pool = createPostgresPool({connectionString: target.connectionString, max: 1});
    // Historical heartbeat shape, before cadence revision and reason existed.
    await pool.query(`
      CREATE SCHEMA runtime;
      CREATE TABLE runtime.session_heartbeats (
        session_id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL,
        every_minutes INTEGER NOT NULL, next_fire_at TIMESTAMPTZ NOT NULL,
        last_fire_at TIMESTAMPTZ, last_skip_reason TEXT,
        claimed_at TIMESTAMPTZ, claimed_by TEXT, claim_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO runtime.session_heartbeats
        (session_id, enabled, every_minutes, next_fire_at)
      VALUES ('active', true, 45, '2040-01-01T12:00:00Z'),
             ('disabled', false, 240, '2040-01-02T12:00:00Z');
    `);
  });

  afterEach(async () => { await pool?.end(); });

  it("upgrades existing schedules without changing them and is a no-op on rerun", async () => {
    const migrator = createPostgresMigrator({pool, schemaName: "runtime", tableName: "schema_migrations", lockName: "heartbeat-test", migrations: [HEARTBEAT_CADENCE_MIGRATION]});
    await migrator.migrate();
    const sessions = new PostgresSessionStore({pool});
    const active = await sessions.getHeartbeat("active");
    const disabled = await sessions.getHeartbeat("disabled");
    expect(active).toMatchObject({enabled: true, everyMinutes: 45, nextFireAt: Date.parse("2040-01-01T12:00:00Z"), configRevision: 0});
    expect(disabled).toMatchObject({enabled: false, everyMinutes: 240, nextFireAt: Date.parse("2040-01-02T12:00:00Z"), configRevision: 0});
    expect(active?.lastCadenceChangeReason).toBeUndefined();
    await migrator.migrate();
    expect(await sessions.getHeartbeat("active")).toEqual(active);
    expect(await sessions.getHeartbeat("disabled")).toEqual(disabled);
  });

  it("rolls the schema expansion back when a later pending migration fails", async () => {
    const migrator = createPostgresMigrator({pool, schemaName: "runtime", tableName: "schema_migrations", lockName: "heartbeat-test", migrations: [HEARTBEAT_CADENCE_MIGRATION, {
      id: "0020_test_failure", description: "Test rollback", checksum: "a".repeat(64),
      apply: async () => { throw new Error("Rollback probe"); },
    }]});
    await expect(migrator.migrate()).rejects.toThrow("Rollback probe");
    const columns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'runtime' AND table_name = 'session_heartbeats'`);
    expect(columns.rows.map((row) => row.column_name)).not.toContain("config_revision");
    expect((await pool.query("SELECT every_minutes FROM runtime.session_heartbeats WHERE session_id = 'active'")).rows[0].every_minutes).toBe(45);
  });
});
