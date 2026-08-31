import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {ensureReadonlySessionQuerySchema} from "../src/domain/threads/runtime/index.js";
import {PostgresScheduledTaskStore} from "../src/domain/scheduling/tasks/index.js";
import {ensurePostgresScheduledTaskSchema} from "../src/domain/scheduling/tasks/postgres-schema.js";
import {ensurePostgresWatchSchema} from "../src/domain/watches/postgres-schema.js";
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

      if (/^CREATE VIEW "session"."threads"/i.test(statement)) {
        const whereMatches = [...statement.matchAll(/\bWHERE\b/gi)];
        const whereIndex = whereMatches.at(-1)?.index;
        const whereClause = whereIndex === undefined
          ? undefined
          : statement.slice(whereIndex + "WHERE".length).trim();
        if (!whereClause) {
          throw new Error("Expected session.threads view SQL to contain a WHERE clause.");
        }

        await this.pool.query(`
          CREATE VIEW "session"."threads" AS
          SELECT
            t.id,
            t.session_id
          FROM "runtime"."threads" AS t
          WHERE ${whereClause}
        `);
        continue;
      }

      if (/^CREATE VIEW "session"\."messages"(?:\s|$)/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."messages" AS
          SELECT
            m.id,
            m.thread_id,
            m.sequence,
            m.run_id,
            m.created_at,
            m.message->>'role' AS role,
            m.message->>'content' AS text
          FROM "runtime"."messages" AS m
          INNER JOIN "runtime"."threads" AS t ON t.id = m.thread_id
          WHERE t.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."(messages_raw|tool_results|inputs|runs|prompts|agent_pairings|agent_skills|agent_sessions|subagent_history)"/i.test(statement)) {
        continue;
      }

      if (/^CREATE VIEW "session"."scheduled_tasks"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."scheduled_tasks" AS
          SELECT
            scheduled_tasks.id,
            scheduled_tasks.session_id,
            scheduled_tasks.created_by_identity_id,
            scheduled_tasks.created_from_message_id,
            session.current_thread_id AS resolved_thread_id
          FROM "runtime"."scheduled_tasks" AS scheduled_tasks
          INNER JOIN "runtime"."agent_sessions" AS session
            ON session.id = scheduled_tasks.session_id
          WHERE scheduled_tasks.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."scheduled_task_runs"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."scheduled_task_runs" AS
          SELECT
            scheduled_task_runs.id,
            scheduled_task_runs.task_id,
            scheduled_task_runs.session_id,
            scheduled_task_runs.status,
            scheduled_task_runs.created_at
          FROM "runtime"."scheduled_task_runs" AS scheduled_task_runs
          WHERE scheduled_task_runs.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."watches"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."watches" AS
          SELECT
            watch.id,
            watch.session_id,
            watch.created_by_identity_id,
            session.current_thread_id AS resolved_thread_id
          FROM "runtime"."watches" AS watch
          INNER JOIN "runtime"."agent_sessions" AS session
            ON session.id = watch.session_id
          WHERE watch.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."watch_runs"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."watch_runs" AS
          SELECT
            watch_runs.id,
            watch_runs.watch_id,
            watch_runs.session_id,
            watch_runs.status,
            watch_runs.created_at
          FROM "runtime"."watch_runs" AS watch_runs
          WHERE watch_runs.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."watch_events"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."watch_events" AS
          SELECT
            watch_events.id,
            watch_events.watch_id,
            watch_events.session_id,
            watch_events.created_by_identity_id,
            watch_events.created_at
          FROM "runtime"."watch_events" AS watch_events
          WHERE watch_events.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."email_allowed_recipients"/i.test(statement)) {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS "runtime"."email_allowed_recipients" (
            id UUID PRIMARY KEY,
            agent_key TEXT NOT NULL,
            account_key TEXT NOT NULL,
            address TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
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
  const db = newDb({noAstCoverageCheck: true});
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
  db.public.registerFunction({
    name: "jsonb_array_length",
    args: [DataType.jsonb],
    returns: DataType.integer,
    implementation: (value: unknown) => Array.isArray(value) ? value.length : 0,
  });
  db.public.registerFunction({
    name: "jsonb_typeof",
    args: [DataType.jsonb],
    returns: DataType.text,
    implementation: (value: unknown) => value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value,
  });

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();

  return {
    pool,
    setScope(next: {sessionId?: string | null; agentKey?: string | null}) {
      scope.set("runtime.session_id", next.sessionId ?? null);
      scope.set("runtime.agent_key", next.agentKey ?? null);
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

    const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);
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
    await threadStore.createThread({
      id: "session-thread",
      sessionId: "session-main",
    });
    const provenanceMessageId = "00000000-0000-4000-8000-000000000201";
    await pool.query(`
      INSERT INTO "runtime"."messages" (id, thread_id, origin, source, identity_id, created_at, message)
      VALUES ($1, 'session-thread', 'runtime', 'tui', $2, NOW(), $3::jsonb)
    `, [provenanceMessageId, alice.id, JSON.stringify({role: "user", content: "Remind me to research bees."})]);

    const scheduledTasks = new PostgresScheduledTaskStore({pool});
    await ensurePostgresScheduledTaskSchema(pool);

    const created = await scheduledTasks.createTask({
      sessionId: "session-main",
      createdByIdentityId: alice.id,
      createdFromMessageId: provenanceMessageId,
      title: "Bee research",
      instruction: "Research bees and summarize the result.",
      schedule: {
        kind: "once",
        runAt: "2026-04-11T03:00:00+02:00",
      },
    });

    expect(created).toMatchObject({
      sessionId: "session-main",
      createdByIdentityId: "alice-id",
      createdFromMessageId: provenanceMessageId,
      title: "Bee research",
      schedule: {
        kind: "once",
        runAt: "2026-04-11T01:00:00.000Z",
      },
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
    expect(updated.nextFireAt).toEqual(expect.any(Number));

    const cancelled = await scheduledTasks.cancelTask({
      taskId: created.id,
      sessionId: "session-main",
      reason: "done already",
    });

    expect(cancelled.cancelledAt).toEqual(expect.any(Number));
    expect(cancelled.nextFireAt).toBeUndefined();
    await expect(scheduledTasks.updateTask({
      taskId: created.id,
      sessionId: "session-main",
      title: "Do not resurrect cancelled history",
    })).rejects.toThrow("is terminal and cannot be updated; create a new task instead");
    await expect(scheduledTasks.cancelTask({
      taskId: created.id,
      sessionId: "session-main",
    })).rejects.toThrow("is terminal and cannot be cancelled");

    const completed = await scheduledTasks.createTask({
      sessionId: "session-main",
      title: "Completed immutable history",
      instruction: "This definition has already settled.",
      schedule: {kind: "once", runAt: "2026-04-12T01:00:00.000Z"},
    });
    await pool.query(`
      UPDATE "runtime"."scheduled_tasks"
      SET completed_at = NOW(),
          next_fire_at = NULL
      WHERE id = $1
    `, [completed.id]);
    await expect(scheduledTasks.cancelTask({
      taskId: completed.id,
      sessionId: "session-main",
    })).rejects.toThrow("is terminal and cannot be cancelled");

    await pool.query(`DELETE FROM "runtime"."messages" WHERE id = $1`, [provenanceMessageId]);
    await expect(scheduledTasks.getTask(created.id)).resolves.toMatchObject({
      createdFromMessageId: undefined,
    });

    await expect(scheduledTasks.createTask({
      sessionId: "session-main",
      createdFromMessageId: "00000000-0000-4000-8000-000000000099",
      title: "Bad provenance",
      instruction: "This should fail.",
      schedule: {
        kind: "once",
        runAt: "2026-04-11T03:00:00+02:00",
      },
    })).rejects.toThrow("does not belong to session session-main");
  });

  it("keeps scheduled-task delivery columns out of the schema", async () => {
    const {pool} = createScopedPool();
    pools.push(pool);

    await createRuntimeStores(pool);
    const scheduledTasks = new PostgresScheduledTaskStore({pool});
    await ensurePostgresScheduledTaskSchema(pool);

    const columns = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'runtime'
        AND table_name IN ('scheduled_tasks', 'scheduled_task_runs')
        AND column_name IN ('deliver_at', 'next_fire_kind', 'fire_kind', 'delivery_status')
      ORDER BY table_name, column_name
    `);
    expect(columns.rows).toEqual([]);
  });

  it("rejects corrupted persisted task and run states before returning records", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-0000-0000-000000000001",
          session_id: "session-main",
          created_by_identity_id: null,
          created_from_message_id: null,
          title: "Bad enabled",
          instruction: "Should not parse.",
          schedule_kind: "once",
          run_at: now,
          cron_expr: null,
          timezone: null,
          enabled: "yes",
          next_fire_at: now,
          completed_at: null,
          cancelled_at: null,
          created_at: now,
          updated_at: now,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-0000-0000-000000000002",
          task_id: "00000000-0000-0000-0000-000000000001",
          session_id: "session-main",
          created_by_identity_id: null,
          resolved_thread_id: null,
          scheduled_for: now,
          status: "stuck",
          thread_input_id: null,
          thread_run_id: null,
          claim_token: null,
          claimed_at: null,
          claimed_by: null,
          claim_expires_at: null,
          error: null,
          created_at: now,
          started_at: null,
          finished_at: null,
        }],
      });
    const scheduledTasks = new PostgresScheduledTaskStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by row reads");
        },
      },
    });

    await expect(scheduledTasks.getTask("00000000-0000-0000-0000-000000000001")).rejects.toThrow(
      "Scheduled task enabled flag must be a boolean.",
    );
    await expect(scheduledTasks.listTaskRuns({
      taskId: "00000000-0000-0000-0000-000000000001",
      sessionId: "session-main",
    })).rejects.toThrow("Unsupported scheduled task run status stuck.");
  });

  it("bounds explicit history reads and materialization batches", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({rows: []}));
    const scheduledTasks = new PostgresScheduledTaskStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by bounded reads");
        },
      },
    });
    const taskId = "00000000-0000-4000-8000-000000000001";

    await scheduledTasks.listTaskRuns({taskId, sessionId: "session-main", limit: 10_000});
    expect(query.mock.calls[0]?.[1]).toEqual([taskId, "session-main", 100]);

    await expect(scheduledTasks.materializeTaskRuns({
      runs: Array.from({length: 101}, (_, index) => ({
        taskId,
        scheduledFor: index,
      })),
    })).rejects.toThrow("cannot exceed 100 occurrences");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("lists active scheduled tasks for one session", async () => {
    const {pool} = createScopedPool();
    pools.push(pool);

    const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);
    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await sessionStore.createSession({
      id: "session-alice",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "home-a",
      createdByIdentityId: alice.id,
    });
    await sessionStore.createSession({
      id: "session-other",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "home-other",
      createdByIdentityId: alice.id,
    });
    await threadStore.createThread({
      id: "home-a",
      sessionId: "session-alice",
    });
    await threadStore.createThread({
      id: "home-other",
      sessionId: "session-other",
    });

    const scheduledTasks = new PostgresScheduledTaskStore({
      pool: {
        connect: () => pool.connect(),
        query: (text, values) => text.includes("scheduled_active_tasks")
          // pg-mem cannot resolve the production correlated EXISTS. This
          // fixture has no active run without next_fire_at, so use the exact
          // equivalent subset while the real plan is covered by PostgreSQL.
          ? pool.query(`
              SELECT task.*
              FROM "runtime"."scheduled_tasks" AS task
              WHERE task.session_id = $1
                AND task.enabled = TRUE
                AND task.cancelled_at IS NULL
                AND task.completed_at IS NULL
                AND task.next_fire_at IS NOT NULL
              ORDER BY task.next_fire_at ASC, task.id ASC
              LIMIT $2
            `, values)
          : pool.query(text, values),
      },
    });
    await ensurePostgresScheduledTaskSchema(pool);

    await scheduledTasks.createTask({
      sessionId: "session-alice",
      createdByIdentityId: alice.id,
      title: "Second",
      instruction: "Runs second.",
      schedule: {
        kind: "once",
        runAt: "2026-05-10T09:00:00.000Z",
      },
    });
    const first = await scheduledTasks.createTask({
      sessionId: "session-alice",
      createdByIdentityId: alice.id,
      title: "First",
      instruction: "Runs first.",
      schedule: {
        kind: "once",
        runAt: "2026-05-09T09:00:00.000Z",
      },
    });
    const cancelled = await scheduledTasks.createTask({
      sessionId: "session-alice",
      createdByIdentityId: alice.id,
      title: "Cancelled",
      instruction: "Should stay hidden.",
      schedule: {
        kind: "once",
        runAt: "2026-05-08T09:00:00.000Z",
      },
    });
    await scheduledTasks.cancelTask({
      taskId: cancelled.id,
      sessionId: "session-alice",
    });
    await scheduledTasks.createTask({
      sessionId: "session-alice",
      createdByIdentityId: alice.id,
      title: "Disabled",
      instruction: "Should stay hidden.",
      schedule: {
        kind: "once",
        runAt: "2026-05-07T09:00:00.000Z",
      },
      enabled: false,
    });
    await scheduledTasks.createTask({
      sessionId: "session-other",
      createdByIdentityId: alice.id,
      title: "Other session",
      instruction: "Should stay hidden.",
      schedule: {
        kind: "once",
        runAt: "2026-05-06T09:00:00.000Z",
      },
    });

    const tasks = await scheduledTasks.listActiveTasks({
      sessionId: "session-alice",
      limit: 1,
    });

    expect(tasks.map((task) => task.id)).toEqual([first.id]);
    expect(tasks[0]).toMatchObject({
      title: "First",
      nextFireAt: Date.parse("2026-05-09T09:00:00.000Z"),
    });
  });

  it("exposes scoped readonly scheduled-task views and resolves home targets dynamically", async () => {
    const {pool, setScope} = createScopedPool();
    pools.push(pool);

    const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);
    const scheduledTasks = new PostgresScheduledTaskStore({pool});
    await ensurePostgresScheduledTaskSchema(pool);
    await ensurePostgresWatchSchema(pool);

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
    await threadStore.createThread({
      id: "home-a",
      sessionId: "session-alice",
    });
    await threadStore.createThread({
      id: "home-bob",
      sessionId: "session-bob",
    });
    await threadStore.createThread({
      id: "home-b",
      sessionId: "session-alice",
    });
    const provenanceMessageId = "00000000-0000-4000-8000-000000000202";
    const provenanceMessageResult = await pool.query(`
      INSERT INTO "runtime"."messages" (id, thread_id, origin, source, identity_id, created_at, message)
      VALUES ($1, 'home-a', 'runtime', 'tui', $2, NOW(), $3::jsonb)
      RETURNING sequence
    `, [provenanceMessageId, alice.id, JSON.stringify({role: "user", content: "Remind me to buy apples."})]);
    const provenanceMessageSequence = Number((provenanceMessageResult.rows[0] as {sequence: unknown}).sequence);

    const aliceTask = await scheduledTasks.createTask({
      sessionId: "session-alice",
      createdByIdentityId: alice.id,
      createdFromMessageId: provenanceMessageId,
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

    const scheduledRunId = "00000000-0000-4000-8000-000000000001";
    await pool.query(`
      INSERT INTO "runtime"."scheduled_task_runs" (
        id,
        task_id,
        session_id,
        scheduled_for,
        status
      ) VALUES ($1, $2, 'session-alice', NOW(), 'pending')
    `, [scheduledRunId, aliceTask.id]);

    const runHistory = await scheduledTasks.listTaskRuns({
      taskId: aliceTask.id,
      sessionId: "session-alice",
      limit: 10,
    });
    expect(runHistory).toHaveLength(1);
    expect(runHistory[0]).toMatchObject({
      id: scheduledRunId,
      taskId: aliceTask.id,
      sessionId: "session-alice",
      status: "pending",
    });

    setScope({
      sessionId: "session-alice",
      agentKey: "panda",
    });
    await ensureReadonlySessionQuerySchema({
      queryable: new PgMemReadonlySchemaQueryable(pool),
    });

    let tasksResult = await pool.query(`
      SELECT id, resolved_thread_id, created_from_message_id
      FROM "session"."scheduled_tasks"
      ORDER BY id
    `);
    expect(tasksResult.rows).toEqual([{
      id: aliceTask.id,
      resolved_thread_id: "home-a",
      created_from_message_id: provenanceMessageId,
    }]);

    const messageResult = await pool.query(`
      SELECT id, thread_id, sequence, role, text
      FROM "session"."messages"
      WHERE id = $1
    `, [provenanceMessageId]);
    expect(messageResult.rows).toEqual([{
      id: provenanceMessageId,
      thread_id: "home-a",
      sequence: provenanceMessageSequence,
      role: "user",
      text: "Remind me to buy apples.",
    }]);

    const runsResult = await pool.query(`
      SELECT task_id, status
      FROM "session"."scheduled_task_runs"
      ORDER BY created_at
    `);
    expect(runsResult.rows).toEqual([{
      task_id: aliceTask.id,
      status: "pending",
    }]);

    await sessionStore.updateCurrentThread({
      sessionId: "session-alice",
      currentThreadId: "home-b",
    });
    tasksResult = await pool.query(`
      SELECT id, resolved_thread_id, created_from_message_id
      FROM "session"."scheduled_tasks"
      ORDER BY id
    `);
    expect(tasksResult.rows).toEqual([{
      id: aliceTask.id,
      resolved_thread_id: "home-b",
      created_from_message_id: provenanceMessageId,
    }]);
  });
});
