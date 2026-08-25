import {randomUUID} from "node:crypto";

import {Pool, type PoolClient} from "pg";
import {describe, expect, it} from "vitest";

import {buildSessionTableNames} from "../../src/domain/sessions/postgres-shared.js";
import {THREAD_INPUT_ADMISSION_MIGRATION} from "../../src/app/database/migrations/0002-thread-input-admission.js";
import {
  completeOwnedThreadRun,
  failOwnedThreadRun,
  failOrphanedThreadRuns,
  isThreadRunActive,
  takeOwnedThreadRunBoundary,
  tryStartThreadRun,
} from "../../src/domain/threads/runtime/postgres-run-claims.js";
import {buildThreadRuntimeTableNames} from "../../src/domain/threads/runtime/postgres-shared.js";
import type {PgQueryable, PgQueryResult} from "../../src/lib/postgres-query.js";
import {quoteIdentifier} from "../../src/lib/postgres-relations.js";

class SchemaScopedQuery implements PgQueryable {
  constructor(
    private readonly pool: Pool | PoolClient,
    private readonly schema: string,
  ) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    const scopedSql = sql.replaceAll('"runtime".', `${quoteIdentifier(this.schema)}.`);
    const result = await this.pool.query(scopedSql, [...params]);
    return {rows: result.rows, rowCount: result.rowCount};
  }
}

async function waitForLockWait(pool: Pool, pid: number, operation = "statement"): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (result.rows[0]?.wait_event_type === "Lock") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for the ${operation} to block on a row lock.`);
}

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const postgresIt = databaseUrl ? it : it.skip;

describe("durable thread run claims with PostgreSQL", () => {
  it("requires TEST_DATABASE_URL for the PostgreSQL contract check", () => {
    expect(databaseUrl).toMatch(/^postgres(?:ql)?:\/\//);
  });

  postgresIt("admits one owner and fences it immediately after daemon failover", async () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: "panda/test-thread-run-claims",
      max: 4,
    });
    const schema = `thread_claim_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = quoteIdentifier(schema);
    const tables = buildThreadRuntimeTableNames();
    const sessionTables = buildSessionTableNames();
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      schemaCreated = true;
      await pool.query(`
        CREATE TABLE ${quotedSchema}.agent_sessions (
          id TEXT PRIMARY KEY,
          current_thread_id TEXT NOT NULL
        );
        CREATE TABLE ${quotedSchema}.threads (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE ${quotedSchema}.session_runtime_config (
          session_id TEXT PRIMARY KEY,
          pending_wake_at TIMESTAMPTZ,
          pending_wake_generation BIGINT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT session_runtime_config_wake_generation_check CHECK (
            pending_wake_generation >= 0
            AND (pending_wake_at IS NULL OR pending_wake_generation > 0)
          )
        );
        CREATE TABLE ${quotedSchema}.inputs (
          id UUID PRIMARY KEY,
          thread_id TEXT NOT NULL,
          delivery_mode TEXT NOT NULL,
          admitted_run_id UUID,
          applied_at TIMESTAMPTZ,
          applied_run_id UUID,
          discarded_at TIMESTAMPTZ
        );
        CREATE TABLE ${quotedSchema}.runs (
          id UUID PRIMARY KEY,
          thread_id TEXT NOT NULL,
          owner_source TEXT,
          owner_key TEXT,
          owner_holder_id TEXT,
          status TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL,
          finished_at TIMESTAMPTZ,
          abort_requested_at TIMESTAMPTZ,
          abort_reason TEXT,
          error TEXT
        );
        CREATE UNIQUE INDEX runs_one_running_per_thread_idx
          ON ${quotedSchema}.runs (thread_id)
          WHERE status = 'running';
        CREATE TABLE ${quotedSchema}.connector_leases (
          source TEXT NOT NULL,
          connector_key TEXT NOT NULL,
          holder_id TEXT NOT NULL,
          leased_until TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (source, connector_key)
        );
        INSERT INTO ${quotedSchema}.agent_sessions (id, current_thread_id)
        VALUES ('session-a', 'thread-a');
        INSERT INTO ${quotedSchema}.threads (id, session_id)
        VALUES ('thread-a', 'session-a');
        INSERT INTO ${quotedSchema}.session_runtime_config (
          session_id, pending_wake_at, pending_wake_generation
        ) VALUES ('session-a', NOW(), 1);
        INSERT INTO ${quotedSchema}.inputs (id, thread_id, delivery_mode)
        VALUES ('00000000-0000-4000-8000-000000000001', 'thread-a', 'wake');
      `);

      const queryable = new SchemaScopedQuery(pool, schema);
      const ownerA = {source: "daemon", connectorKey: "primary", holderId: "owner-a"};
      await queryable.query(`
        INSERT INTO "runtime"."connector_leases" (source, connector_key, holder_id, leased_until)
        VALUES ($1, $2, $3, NOW() + INTERVAL '1 minute')
      `, [ownerA.source, ownerA.connectorKey, ownerA.holderId]);

      const competingClaims = await Promise.all([
        tryStartThreadRun({
          queryable,
          tables,
          sessionTables,
          threadId: "thread-a",
          owner: ownerA,
          notificationChannel: "thread_claim_test",
        }),
        tryStartThreadRun({
          queryable,
          tables,
          sessionTables,
          threadId: "thread-a",
          owner: ownerA,
          notificationChannel: "thread_claim_test",
        }),
      ]);
      const firstRun = competingClaims.find((run) => run !== null);
      expect(competingClaims.filter((run) => run !== null)).toHaveLength(1);
      expect(firstRun?.owner).toEqual(ownerA);
      await expect(isThreadRunActive({queryable, tables, runId: firstRun!.id})).resolves.toBe(true);
      await expect(queryable.query(`
        SELECT delivery_mode FROM "runtime".inputs
        WHERE id = '00000000-0000-4000-8000-000000000001'
      `)).resolves.toMatchObject({rows: [{delivery_mode: "queue"}]});

      const ownerB = {source: "daemon", connectorKey: "primary", holderId: "owner-b"};
      await queryable.query(`
        UPDATE "runtime"."connector_leases"
        SET holder_id = $1, leased_until = NOW() + INTERVAL '1 minute'
        WHERE source = $2 AND connector_key = $3
      `, [ownerB.holderId, ownerB.source, ownerB.connectorKey]);
      await expect(isThreadRunActive({queryable, tables, runId: firstRun!.id})).resolves.toBe(false);
      await expect(completeOwnedThreadRun({queryable, tables, runId: firstRun!.id})).rejects.toThrow(
        "is no longer owned by this daemon",
      );

      const recovered = await failOrphanedThreadRuns({
        queryable,
        tables,
        sessionTables,
        owner: ownerB,
        error: "recovered after failover",
        limit: 100,
        notificationChannel: "thread_claim_test",
      });
      expect(recovered.map((run) => run.id)).toEqual([firstRun!.id]);
      await expect(queryable.query(`
        SELECT input.delivery_mode, config.pending_wake_at IS NOT NULL AS pending_wake
        FROM "runtime".inputs AS input
        INNER JOIN "runtime".threads AS thread ON thread.id = input.thread_id
        INNER JOIN "runtime".session_runtime_config AS config ON config.session_id = thread.session_id
        WHERE input.id = '00000000-0000-4000-8000-000000000001'
      `)).resolves.toMatchObject({rows: [{delivery_mode: "wake", pending_wake: true}]});
      const successor = await tryStartThreadRun({
        queryable,
        tables,
        sessionTables,
        threadId: "thread-a",
        owner: ownerB,
        notificationChannel: "thread_claim_test",
      });
      expect(successor?.owner).toEqual(ownerB);
      await completeOwnedThreadRun({queryable, tables, runId: successor!.id});
      await expect(tryStartThreadRun({
        queryable,
        tables,
        sessionTables,
        threadId: "thread-a",
        owner: ownerB,
        notificationChannel: "thread_claim_test",
      })).resolves.toBeNull();

      await queryable.query(`
        INSERT INTO "runtime".inputs (id, thread_id, delivery_mode)
        VALUES ('00000000-0000-4000-8000-000000000002', 'thread-a', 'wake');
        UPDATE "runtime".session_runtime_config
        SET pending_wake_at = NOW(),
            pending_wake_generation = pending_wake_generation + 1
        WHERE session_id = 'session-a';
      `);
      const aborted = await tryStartThreadRun({
        queryable,
        tables,
        sessionTables,
        threadId: "thread-a",
        owner: ownerB,
        notificationChannel: "thread_claim_test",
      });
      await queryable.query(`
        UPDATE "runtime".runs
        SET abort_requested_at = NOW(), abort_reason = 'stop'
        WHERE id = $1
      `, [aborted!.id]);
      await failOwnedThreadRun({
        queryable,
        tables,
        sessionTables,
        runId: aborted!.id,
        error: "stop",
        notificationChannel: "thread_claim_test",
      });
      await expect(queryable.query(`
        SELECT ARRAY_AGG(DISTINCT delivery_mode ORDER BY delivery_mode) AS modes,
               ARRAY_AGG(DISTINCT admitted_run_id) AS admitted_runs,
               (SELECT pending_wake_at IS NOT NULL
                FROM "runtime".session_runtime_config
                WHERE session_id = 'session-a') AS pending_wake
        FROM "runtime".inputs
        WHERE thread_id = 'thread-a'
          AND applied_at IS NULL
          AND discarded_at IS NULL
      `)).resolves.toMatchObject({
        rows: [{modes: ["queue"], admitted_runs: [aborted!.id], pending_wake: false}],
      });
      await expect(tryStartThreadRun({
        queryable,
        tables,
        sessionTables,
        threadId: "thread-a",
        owner: ownerB,
        notificationChannel: "thread_claim_test",
      })).resolves.toBeNull();

      await queryable.query(`
        INSERT INTO "runtime".agent_sessions (id, current_thread_id)
        VALUES ('session-paged', 'thread-paged');
        INSERT INTO "runtime".threads (id, session_id)
        VALUES ('thread-paged', 'session-paged');
        INSERT INTO "runtime".session_runtime_config (
          session_id, pending_wake_at, pending_wake_generation
        ) VALUES ('session-paged', NOW(), 1);
        INSERT INTO "runtime".inputs (id, thread_id, delivery_mode)
        SELECT (
          SUBSTR(MD5('paged-' || value::text), 1, 8) || '-' ||
          SUBSTR(MD5('paged-' || value::text), 9, 4) || '-4' ||
          SUBSTR(MD5('paged-' || value::text), 14, 3) || '-8' ||
          SUBSTR(MD5('paged-' || value::text), 18, 3) || '-' ||
          SUBSTR(MD5('paged-' || value::text), 21, 12)
        )::uuid, 'thread-paged', 'queue'
        FROM GENERATE_SERIES(1, 501) AS value;
      `);
      const pagedRun = await tryStartThreadRun({
        queryable,
        tables,
        sessionTables,
        threadId: "thread-paged",
        owner: ownerB,
        notificationChannel: "thread_claim_test",
      });
      await expect(queryable.query(`
        SELECT COUNT(*)::integer AS count
        FROM "runtime".inputs
        WHERE thread_id = 'thread-paged' AND admitted_run_id = $1
      `, [pagedRun!.id])).resolves.toMatchObject({rows: [{count: 501}]});
      await queryable.query(`
        UPDATE "runtime".inputs
        SET applied_at = NOW(), applied_run_id = $1, admitted_run_id = NULL
        WHERE id IN (
          SELECT id FROM "runtime".inputs
          WHERE thread_id = 'thread-paged'
          ORDER BY id
          LIMIT 500
        )
      `, [pagedRun!.id]);
      await expect(takeOwnedThreadRunBoundary({
        queryable,
        tables,
        sessionTables,
        threadId: "thread-paged",
        runId: pagedRun!.id,
      })).resolves.toEqual({
        hasRunnableInputs: false,
        hasAdmittedInputs: true,
        hadPendingWake: false,
      });

      await queryable.query(`
        INSERT INTO "runtime".inputs (id, thread_id, delivery_mode)
        VALUES ('00000000-0000-4000-8000-000000000004', 'thread-paged', 'queue');
        UPDATE "runtime".session_runtime_config
        SET pending_wake_at = NOW(),
            pending_wake_generation = pending_wake_generation + 1
        WHERE session_id = 'session-paged';
      `);
      await expect(takeOwnedThreadRunBoundary({
        queryable,
        tables,
        sessionTables,
        threadId: "thread-paged",
        runId: pagedRun!.id,
      })).resolves.toEqual({
        hasRunnableInputs: false,
        hasAdmittedInputs: true,
        hadPendingWake: true,
      });
      await queryable.query(`
        INSERT INTO "runtime".inputs (id, thread_id, delivery_mode)
        VALUES ('00000000-0000-4000-8000-000000000003', 'thread-paged', 'queue')
      `);
      await failOwnedThreadRun({
        queryable,
        tables,
        sessionTables,
        runId: pagedRun!.id,
        error: "provider failed",
        notificationChannel: "thread_claim_test",
      });
      await expect(queryable.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE applied_at IS NULL AND delivery_mode = 'wake' AND admitted_run_id IS NULL
          )::integer AS rearmed,
          COUNT(*) FILTER (
            WHERE id = '00000000-0000-4000-8000-000000000003'
              AND delivery_mode = 'queue'
              AND admitted_run_id IS NULL
          )::integer AS late_queue
        FROM "runtime".inputs
        WHERE thread_id = 'thread-paged'
      `)).resolves.toMatchObject({rows: [{rearmed: 2, late_queue: 1}]});

      await queryable.query(`
        INSERT INTO "runtime".agent_sessions (id, current_thread_id)
        VALUES ('session-fail-before-apply', 'thread-fail-before-apply');
        INSERT INTO "runtime".threads (id, session_id)
        VALUES ('thread-fail-before-apply', 'session-fail-before-apply');
        INSERT INTO "runtime".session_runtime_config (
          session_id, pending_wake_at, pending_wake_generation
        ) VALUES ('session-fail-before-apply', NOW(), 1);
        INSERT INTO "runtime".inputs (id, thread_id, delivery_mode)
        VALUES ('00000000-0000-4000-8000-000000000005', 'thread-fail-before-apply', 'queue');
      `);
      const failedBeforeApply = await tryStartThreadRun({
        queryable,
        tables,
        sessionTables,
        threadId: "thread-fail-before-apply",
        owner: ownerB,
        notificationChannel: "thread_claim_test",
      });
      await failOwnedThreadRun({
        queryable,
        tables,
        sessionTables,
        runId: failedBeforeApply!.id,
        error: "provider failed before apply",
        notificationChannel: "thread_claim_test",
      });
      await expect(queryable.query(`
        SELECT delivery_mode, admitted_run_id,
               (SELECT pending_wake_at IS NOT NULL
                FROM "runtime".session_runtime_config
                WHERE session_id = 'session-fail-before-apply') AS pending_wake
        FROM "runtime".inputs
        WHERE id = '00000000-0000-4000-8000-000000000005'
      `)).resolves.toMatchObject({
        rows: [{delivery_mode: "wake", admitted_run_id: null, pending_wake: true}],
      });

      await queryable.query(`
        INSERT INTO "runtime".agent_sessions (id, current_thread_id)
        VALUES ('session-generation', 'thread-generation');
        INSERT INTO "runtime".threads (id, session_id)
        VALUES ('thread-generation', 'session-generation');
        INSERT INTO "runtime".session_runtime_config (
          session_id, pending_wake_at, pending_wake_generation
        ) VALUES ('session-generation', NOW(), 1);
      `);
      const generationRun = await tryStartThreadRun({
        queryable,
        tables,
        sessionTables,
        threadId: "thread-generation",
        owner: ownerB,
        notificationChannel: "thread_claim_test",
      });
      expect(generationRun).not.toBeNull();
      await queryable.query(`
        UPDATE "runtime".session_runtime_config
        SET pending_wake_at = NOW(),
            pending_wake_generation = pending_wake_generation + 1
        WHERE session_id = 'session-generation'
      `);
      const wakeBlocker = await pool.connect();
      const boundaryClient = await pool.connect();
      try {
        await wakeBlocker.query("BEGIN");
        await wakeBlocker.query(`
          UPDATE ${quotedSchema}.session_runtime_config
          SET pending_wake_at = COALESCE(pending_wake_at, NOW()),
              pending_wake_generation = pending_wake_generation + 1
          WHERE session_id = 'session-generation'
        `);
        const pidResult = await boundaryClient.query("SELECT pg_backend_pid() AS pid");
        const boundaryPid = Number(pidResult.rows[0]?.pid);
        const staleBoundary = takeOwnedThreadRunBoundary({
          queryable: new SchemaScopedQuery(boundaryClient, schema),
          tables,
          sessionTables,
          threadId: "thread-generation",
          runId: generationRun!.id,
        });
        await waitForLockWait(pool, boundaryPid);
        await wakeBlocker.query("COMMIT");
        await expect(staleBoundary).resolves.toMatchObject({hadPendingWake: true});
        await expect(queryable.query(`
          SELECT pending_wake_at IS NOT NULL AS pending,
                 pending_wake_generation::integer AS generation
          FROM "runtime".session_runtime_config
          WHERE session_id = 'session-generation'
        `)).resolves.toMatchObject({rows: [{pending: true, generation: 3}]});
        await expect(takeOwnedThreadRunBoundary({
          queryable,
          tables,
          sessionTables,
          threadId: "thread-generation",
          runId: generationRun!.id,
        })).resolves.toMatchObject({hadPendingWake: true});
        await expect(takeOwnedThreadRunBoundary({
          queryable,
          tables,
          sessionTables,
          threadId: "thread-generation",
          runId: generationRun!.id,
        })).resolves.toEqual({
          hasRunnableInputs: false,
          hasAdmittedInputs: false,
          hadPendingWake: false,
        });
      } finally {
        await Promise.allSettled([
          wakeBlocker.query("ROLLBACK"),
          boundaryClient.query("ROLLBACK"),
        ]);
        wakeBlocker.release();
        boundaryClient.release();
      }

      await queryable.query(`
        INSERT INTO "runtime"."threads" (id, session_id)
        VALUES ('thread-b', 'session-a')
      `);
      await queryable.query(`
        UPDATE "runtime".session_runtime_config
        SET pending_wake_at = NOW(),
            pending_wake_generation = pending_wake_generation + 1
        WHERE session_id = 'session-a'
      `);
      const resetClient = await pool.connect();
      const claimClient = await pool.connect();
      try {
        await resetClient.query("BEGIN");
        await resetClient.query(`
          SELECT current_thread_id
          FROM ${quotedSchema}.agent_sessions
          WHERE id = 'session-a'
          FOR UPDATE
        `);
        await resetClient.query(`
          SELECT id
          FROM ${quotedSchema}.threads
          WHERE id = 'thread-a'
          FOR UPDATE
        `);

        const pidResult = await claimClient.query("SELECT pg_backend_pid() AS pid");
        const claimPid = Number(pidResult.rows[0]?.pid);
        const staleClaim = tryStartThreadRun({
          queryable: new SchemaScopedQuery(claimClient, schema),
          tables,
          sessionTables,
          threadId: "thread-a",
          owner: ownerB,
          notificationChannel: "thread_claim_test",
        });
        await waitForLockWait(pool, claimPid);

        await resetClient.query(`
          UPDATE ${quotedSchema}.agent_sessions
          SET current_thread_id = 'thread-b'
          WHERE id = 'session-a'
        `);
        await resetClient.query("COMMIT");

        await expect(staleClaim).resolves.toBeNull();
      } finally {
        await Promise.allSettled([
          resetClient.query("ROLLBACK"),
          claimClient.query("ROLLBACK"),
        ]);
        resetClient.release();
        claimClient.release();
      }
    } finally {
      try {
        if (schemaCreated) {
          await pool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
        }
      } finally {
        await pool.end();
      }
    }
  });

  postgresIt("backfills pending inputs owned by pre-0002 running runs", async () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: "panda/test-thread-input-admission-migration",
      max: 1,
    });
    const schema = `thread_admission_migration_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = quoteIdentifier(schema);
    try {
      await pool.query(`
        CREATE SCHEMA ${quotedSchema};
        CREATE TABLE ${quotedSchema}.runs (
          id UUID PRIMARY KEY,
          thread_id TEXT NOT NULL,
          status TEXT NOT NULL,
          abort_requested_at TIMESTAMPTZ,
          UNIQUE (thread_id, id)
        );
        CREATE TABLE ${quotedSchema}.inputs (
          id UUID PRIMARY KEY,
          thread_id TEXT NOT NULL,
          input_order BIGSERIAL NOT NULL,
          delivery_mode TEXT NOT NULL,
          applied_at TIMESTAMPTZ,
          discarded_at TIMESTAMPTZ,
          message JSONB
        );
        INSERT INTO ${quotedSchema}.runs (id, thread_id, status, abort_requested_at) VALUES
          ('10000000-0000-4000-8000-000000000001', 'thread-running', 'running', NULL),
          ('10000000-0000-4000-8000-000000000002', 'thread-aborted', 'running', NOW());
        INSERT INTO ${quotedSchema}.inputs (id, thread_id, delivery_mode, message) VALUES
          ('20000000-0000-4000-8000-000000000001', 'thread-running', 'wake', '{}'),
          ('20000000-0000-4000-8000-000000000002', 'thread-running', 'queue', '{}'),
          ('20000000-0000-4000-8000-000000000003', 'thread-aborted', 'wake', '{}');
        INSERT INTO ${quotedSchema}.inputs (
          id, thread_id, delivery_mode, applied_at, message
        ) VALUES (
          '20000000-0000-4000-8000-000000000004', 'thread-running', 'wake', NOW(), NULL
        );
      `);

      await THREAD_INPUT_ADMISSION_MIGRATION.apply({
        queryable: new SchemaScopedQuery(pool, schema),
      });

      const pending = await pool.query(`
        SELECT id, delivery_mode, admitted_run_id
        FROM ${quotedSchema}.inputs
        WHERE applied_at IS NULL
        ORDER BY id
      `);
      expect(pending.rows).toEqual([
        {
          id: "20000000-0000-4000-8000-000000000001",
          delivery_mode: "queue",
          admitted_run_id: "10000000-0000-4000-8000-000000000001",
        },
        {
          id: "20000000-0000-4000-8000-000000000002",
          delivery_mode: "queue",
          admitted_run_id: "10000000-0000-4000-8000-000000000001",
        },
        {
          id: "20000000-0000-4000-8000-000000000003",
          delivery_mode: "queue",
          admitted_run_id: "10000000-0000-4000-8000-000000000002",
        },
      ]);
      await expect(pool.query(`
        SELECT admitted_run_id
        FROM ${quotedSchema}.inputs
        WHERE id = '20000000-0000-4000-8000-000000000004'
      `)).resolves.toMatchObject({rows: [{admitted_run_id: null}]});
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });
});
