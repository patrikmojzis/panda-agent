import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {ensureReadonlyChatQuerySchema,} from "../src/domain/threads/runtime/index.js";
import {PostgresScheduledTaskStore} from "../src/domain/scheduling/tasks/index.js";
import {PostgresWatchStore} from "../src/domain/watches/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

class PgMemReadonlySchemaQueryable {
  constructor(
    private readonly pool: { query(text: string): Promise<{ rows: unknown[] }> },
  ) {}

  async query(text: string): Promise<{ rows: unknown[] }> {
    const statements = text
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      if (/^DROP VIEW IF EXISTS\b/i.test(statement)) {
        continue;
      }

      if (/^CREATE VIEW "panda_threads"/i.test(statement)) {
        const whereMatches = [...statement.matchAll(/\bWHERE\b/gi)];
        const whereIndex = whereMatches.at(-1)?.index;
        const whereClause = whereIndex === undefined
          ? undefined
          : statement.slice(whereIndex + "WHERE".length).trim();
        if (!whereClause) {
          throw new Error("Expected panda_threads view SQL to contain a WHERE clause.");
        }

        await this.pool.query(`
          CREATE VIEW "panda_threads" AS
          SELECT
            t.id,
            t.session_id
          FROM "thread_runtime_threads" AS t
          WHERE ${whereClause}
        `);
        continue;
      }

      if (/^CREATE VIEW "panda_(messages_raw|messages|tool_results|inputs|runs|agent_skills)"/i.test(statement)) {
        continue;
      }

      if (/^CREATE VIEW "panda_scheduled_tasks"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "panda_scheduled_tasks" AS
          SELECT
            scheduled_tasks.id,
            scheduled_tasks.session_id,
            scheduled_tasks.created_by_identity_id,
            session.current_thread_id AS resolved_thread_id
          FROM "thread_runtime_scheduled_tasks" AS scheduled_tasks
          INNER JOIN "thread_runtime_agent_sessions" AS session
            ON session.id = scheduled_tasks.session_id
          WHERE scheduled_tasks.session_id = current_setting('panda.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "panda_scheduled_task_runs"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "panda_scheduled_task_runs" AS
          SELECT
            scheduled_task_runs.id,
            scheduled_task_runs.task_id,
            scheduled_task_runs.session_id,
            scheduled_task_runs.status,
            scheduled_task_runs.delivery_status,
            scheduled_task_runs.created_at
          FROM "thread_runtime_scheduled_task_runs" AS scheduled_task_runs
          WHERE scheduled_task_runs.session_id = current_setting('panda.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "panda_watches"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "panda_watches" AS
          SELECT
            watch.id,
            watch.session_id,
            watch.created_by_identity_id,
            session.current_thread_id AS resolved_thread_id
          FROM "thread_runtime_watches" AS watch
          INNER JOIN "thread_runtime_agent_sessions" AS session
            ON session.id = watch.session_id
          WHERE watch.session_id = current_setting('panda.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "panda_watch_runs"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "panda_watch_runs" AS
          SELECT
            watch_runs.id,
            watch_runs.watch_id,
            watch_runs.session_id,
            watch_runs.status,
            watch_runs.created_at
          FROM "thread_runtime_watch_runs" AS watch_runs
          WHERE watch_runs.session_id = current_setting('panda.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "panda_watch_events"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "panda_watch_events" AS
          SELECT
            watch_events.id,
            watch_events.watch_id,
            watch_events.session_id,
            watch_events.created_by_identity_id,
            watch_events.created_at
          FROM "thread_runtime_watch_events" AS watch_events
          WHERE watch_events.session_id = current_setting('panda.session_id', true)
        `);
        continue;
      }

      const sanitized = statement.replace(
        /\bWITH\s*\(security_barrier\s*=\s*true\)\s+AS\b/gi,
        "AS",
      );
      await this.pool.query(sanitized);
    }

    return { rows: [] };
  }
}

function createScopedPool() {
  const db = newDb();
  const scope = new Map<string, string | null>();

  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  db.public.registerFunction({
    name: "current_setting",
    args: [DataType.text, DataType.bool],
    returns: DataType.text,
    implementation: (key: string) => scope.get(key) ?? null,
  });
  db.public.registerFunction({
    name: "convert_to",
    args: [DataType.text, DataType.text],
    returns: DataType.bytea,
    implementation: (value: string, encoding: string) => Buffer.from(value, encoding),
  });
  db.public.registerFunction({
    name: "octet_length",
    args: [DataType.bytea],
    returns: DataType.integer,
    implementation: (value: Buffer) => value.length,
  });

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();

  return {
    pool,
    setScope(next: {sessionId?: string | null; agentKey?: string | null}) {
      scope.set("panda.session_id", next.sessionId ?? null);
      scope.set("panda.agent_key", next.agentKey ?? null);
    },
  };
}

describe("PostgresScheduledTaskStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    vi.useRealTimers();

    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("creates, updates, and cancels scheduled tasks", async () => {
    const {pool} = createScopedPool();
    pools.push(pool);

    const {identityStore, sessionStore} = await createRuntimeStores(pool);
    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await sessionStore.createSession({
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "session-thread",
      createdByIdentityId: alice.id,
    });

    const scheduledTasks = new PostgresScheduledTaskStore({pool});
    await scheduledTasks.ensureSchema();

    const created = await scheduledTasks.createTask({
      sessionId: "session-main",
      createdByIdentityId: alice.id,
      title: "Bee research",
      instruction: "Research bees and summarize the result.",
      schedule: {
        kind: "once",
        runAt: "2026-04-11T03:00:00+02:00",
        deliverAt: "2026-04-11T08:00:00+02:00",
      },
    });

    expect(created).toMatchObject({
      sessionId: "session-main",
      createdByIdentityId: "alice-id",
      title: "Bee research",
      schedule: {
        kind: "once",
        runAt: "2026-04-11T01:00:00.000Z",
        deliverAt: "2026-04-11T06:00:00.000Z",
      },
      nextFireKind: "execute",
    });

    const updated = await scheduledTasks.updateTask({
      taskId: created.id,
      sessionId: "session-main",
      title: "Morning news",
      schedule: {
        kind: "recurring",
        cron: "0 8 * * *",
        timezone: "Europe/Bratislava",
      },
      enabled: false,
    });

    expect(updated).toMatchObject({
      id: created.id,
      title: "Morning news",
      enabled: false,
      schedule: {
        kind: "recurring",
        cron: "0 8 * * *",
        timezone: "Europe/Bratislava",
      },
    });
    expect(updated.nextFireAt).toBeDefined();

    const cancelled = await scheduledTasks.cancelTask({
      taskId: created.id,
      sessionId: "session-main",
      reason: "done already",
    });

    expect(cancelled.cancelledAt).toBeDefined();
    expect(cancelled.nextFireAt).toBeUndefined();
  });

  it("exposes scoped readonly scheduled-task views and resolves home targets dynamically", async () => {
    const {pool, setScope} = createScopedPool();
    pools.push(pool);

    const {identityStore, sessionStore} = await createRuntimeStores(pool);
    const scheduledTasks = new PostgresScheduledTaskStore({pool});
    await scheduledTasks.ensureSchema();
    await new PostgresWatchStore({pool}).ensureSchema();

    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    const bob = await identityStore.createIdentity({
      id: "bob-id",
      handle: "bob",
      displayName: "Bob",
    });

    await sessionStore.createSession({
      id: "session-alice",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "home-a",
      createdByIdentityId: alice.id,
    });
    await sessionStore.createSession({
      id: "session-bob",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "home-bob",
      createdByIdentityId: bob.id,
    });

    const aliceTask = await scheduledTasks.createTask({
      sessionId: "session-alice",
      createdByIdentityId: alice.id,
      title: "Buy apples",
      instruction: "Remind me to buy apples.",
      schedule: {
        kind: "once",
        runAt: "2000-04-10T05:30:00.000Z",
      },
    });
    await scheduledTasks.createTask({
      sessionId: "session-bob",
      createdByIdentityId: bob.id,
      title: "Bob task",
      instruction: "Hidden from Alice.",
      schedule: {
        kind: "once",
        runAt: "2000-04-10T05:30:00.000Z",
      },
    });

    const claim = await scheduledTasks.claimTask({
      taskId: aliceTask.id,
      claimedBy: "runner:telegram",
      claimExpiresAt: Date.now() + 60_000,
    });
    expect(claim).not.toBeNull();
    await scheduledTasks.startTaskRun({
      runId: claim!.run.id,
      resolvedThreadId: "home-a",
    });
    await scheduledTasks.completeTaskRun({
      runId: claim!.run.id,
      resolvedThreadId: "home-a",
      threadRunId: "thread-run-1",
      deliveryStatus: "sent",
    });

    setScope({
      sessionId: "session-alice",
      agentKey: "panda",
    });
    await ensureReadonlyChatQuerySchema({
      queryable: new PgMemReadonlySchemaQueryable(pool),
    });

    let tasksResult = await pool.query(`
      SELECT id, resolved_thread_id
      FROM "panda_scheduled_tasks"
      ORDER BY id
    `);
    expect(tasksResult.rows).toEqual([{
      id: aliceTask.id,
      resolved_thread_id: "home-a",
    }]);

    const runsResult = await pool.query(`
      SELECT task_id, status, delivery_status
      FROM "panda_scheduled_task_runs"
      ORDER BY created_at
    `);
    expect(runsResult.rows).toEqual([{
      task_id: aliceTask.id,
      status: "succeeded",
      delivery_status: "sent",
    }]);

    await sessionStore.updateCurrentThread({
      sessionId: "session-alice",
      currentThreadId: "home-b",
    });
    tasksResult = await pool.query(`
      SELECT id, resolved_thread_id
      FROM "panda_scheduled_tasks"
      ORDER BY id
    `);
    expect(tasksResult.rows).toEqual([{
      id: aliceTask.id,
      resolved_thread_id: "home-b",
    }]);
  });
});
