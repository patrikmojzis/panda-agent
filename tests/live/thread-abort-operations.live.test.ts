import {randomUUID} from "node:crypto";

import {Pool, type PoolClient} from "pg";
import {describe, expect, it} from "vitest";

import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import type {PgPoolLike, PgQueryResult} from "../../src/lib/postgres-query.js";
import {quoteIdentifier} from "../../src/lib/postgres-relations.js";

class SchemaScopedClientPool implements PgPoolLike {
  constructor(
    private readonly client: PoolClient,
    private readonly schema: string,
  ) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    const result = await this.client.query(
      sql.replaceAll('"runtime".', `${quoteIdentifier(this.schema)}.`),
      [...params],
    );
    return {rows: result.rows, rowCount: result.rowCount};
  }

  async connect(): Promise<never> {
    throw new Error("The abort-operation test does not open nested clients.");
  }
}

async function waitForLockWait(pool: Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (result.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for abort to block on the active run lock.");
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const postgresIt = databaseUrl ? it : it.skip;

describe("durable thread abort operations with PostgreSQL", () => {
  it("requires TEST_DATABASE_URL for the PostgreSQL contract check", () => {
    expect(databaseUrl).toMatch(/^postgres(?:ql)?:\/\//);
  });

  postgresIt("uses run-before-thread locking and keeps a no-run replay off later runs", async () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: "panda/test-thread-abort-operations",
      max: 4,
    });
    const schema = `thread_abort_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = quoteIdentifier(schema);
    const blocker = await pool.connect();
    const abortClient = await pool.connect();
    const listener = await pool.connect();
    const notifications: Array<{channel: string; payload?: string}> = [];
    listener.on("notification", (notification) => {
      notifications.push({
        channel: notification.channel,
        ...(notification.payload === undefined ? {} : {payload: notification.payload}),
      });
    });
    try {
      await listener.query("LISTEN runtime_events; LISTEN abort_operation_test_sync");
      await pool.query(`
        CREATE SCHEMA ${quotedSchema};
        CREATE TABLE ${quotedSchema}.threads (
          id TEXT PRIMARY KEY
        );
        CREATE TABLE ${quotedSchema}.runs (
          id UUID PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES ${quotedSchema}.threads(id) ON DELETE CASCADE,
          owner_source TEXT,
          owner_key TEXT,
          owner_holder_id TEXT,
          status TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL,
          finished_at TIMESTAMPTZ,
          abort_requested_at TIMESTAMPTZ,
          abort_reason TEXT,
          error TEXT,
          UNIQUE (thread_id, id)
        );
        CREATE UNIQUE INDEX runs_one_running_per_thread_idx
          ON ${quotedSchema}.runs (thread_id)
          WHERE status = 'running';
        CREATE TABLE ${quotedSchema}.thread_abort_operations (
          operation_id UUID PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES ${quotedSchema}.threads(id) ON DELETE CASCADE,
          run_id UUID,
          reason TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          FOREIGN KEY (thread_id, run_id) REFERENCES ${quotedSchema}.runs(thread_id, id)
        );
        INSERT INTO ${quotedSchema}.threads (id) VALUES ('thread-a'), ('thread-b');
        INSERT INTO ${quotedSchema}.runs (id, thread_id, status, started_at)
        VALUES ('10000000-0000-4000-8000-000000000001', 'thread-a', 'running', NOW());
      `);

      await blocker.query("BEGIN");
      await blocker.query(`
        SELECT id FROM ${quotedSchema}.runs
        WHERE id = '10000000-0000-4000-8000-000000000001'
        FOR UPDATE
      `);

      const abortPid = Number((await abortClient.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
      const store = new PostgresThreadRuntimeStore({
        pool: new SchemaScopedClientPool(abortClient, schema),
      });
      const abortOperationId = "20000000-0000-4000-8000-000000000001";
      const abort = store.requestRunAbort("thread-a", "operator stop", abortOperationId);
      await waitForLockWait(pool, abortPid);

      // An active-run mutation already holding the run must still be able to
      // take the thread. If abort held thread while waiting on run, this is the
      // exact run -> thread / thread -> run deadlock we are guarding against.
      await expect(blocker.query(`
        SELECT id FROM ${quotedSchema}.threads
        WHERE id = 'thread-a'
        FOR UPDATE NOWAIT
      `)).resolves.toMatchObject({rows: [{id: "thread-a"}]});
      await blocker.query("COMMIT");

      await expect(abort).resolves.toMatchObject({
        id: "10000000-0000-4000-8000-000000000001",
        abortReason: "operator stop",
      });
      await pool.query("SELECT pg_notify('abort_operation_test_sync', 'first')");
      await waitForCondition(
        () => notifications.some((notification) => notification.payload === "first"),
        "the first abort notification barrier",
      );
      expect(notifications.filter((notification) => notification.channel === "runtime_events")).toHaveLength(1);

      await expect(store.requestRunAbort("thread-a", "operator stop", abortOperationId)).resolves.toMatchObject({
        id: "10000000-0000-4000-8000-000000000001",
        abortReason: "operator stop",
      });
      await pool.query("SELECT pg_notify('abort_operation_test_sync', 'replay')");
      await waitForCondition(
        () => notifications.some((notification) => notification.payload === "replay"),
        "the replay notification barrier",
      );
      expect(notifications.filter((notification) => notification.channel === "runtime_events")).toHaveLength(1);

      await expect(store.requestRunAbort("thread-b", "operator stop", abortOperationId))
        .rejects.toThrow(`Abort operation ${abortOperationId} conflicts with another request.`);

      await pool.query(`
        UPDATE ${quotedSchema}.runs
        SET status = 'failed', finished_at = NOW()
        WHERE id = '10000000-0000-4000-8000-000000000001';
      `);
      const noRunOperationId = "20000000-0000-4000-8000-000000000002";
      await expect(store.requestRunAbort("thread-a", "nothing active", noRunOperationId)).resolves.toBeNull();
      await pool.query(`
        INSERT INTO ${quotedSchema}.runs (id, thread_id, status, started_at)
        VALUES ('10000000-0000-4000-8000-000000000002', 'thread-a', 'running', NOW());
      `);
      await expect(store.requestRunAbort("thread-a", "nothing active", noRunOperationId)).resolves.toBeNull();
      await expect(pool.query(`
        SELECT abort_requested_at FROM ${quotedSchema}.runs
        WHERE id = '10000000-0000-4000-8000-000000000002'
      `)).resolves.toMatchObject({rows: [{abort_requested_at: null}]});

      const concurrentStore = new PostgresThreadRuntimeStore({
        pool: new SchemaScopedClientPool(blocker, schema),
      });
      const concurrentOperationId = "20000000-0000-4000-8000-000000000003";
      const notificationCountBeforeConcurrentAbort = notifications.filter(
        (notification) => notification.channel === "runtime_events",
      ).length;
      const concurrentResults = await Promise.all([
        store.requestRunAbort("thread-a", "concurrent stop", concurrentOperationId),
        concurrentStore.requestRunAbort("thread-a", "concurrent stop", concurrentOperationId),
      ]);
      expect(concurrentResults).toEqual([
        expect.objectContaining({id: "10000000-0000-4000-8000-000000000002"}),
        expect.objectContaining({id: "10000000-0000-4000-8000-000000000002"}),
      ]);
      await pool.query("SELECT pg_notify('abort_operation_test_sync', 'concurrent')");
      await waitForCondition(
        () => notifications.some((notification) => notification.payload === "concurrent"),
        "the concurrent abort notification barrier",
      );
      expect(notifications.filter((notification) => notification.channel === "runtime_events"))
        .toHaveLength(notificationCountBeforeConcurrentAbort + 1);
    } finally {
      await Promise.allSettled([blocker.query("ROLLBACK"), abortClient.query("ROLLBACK")]);
      blocker.release();
      abortClient.release();
      listener.release();
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });
});
