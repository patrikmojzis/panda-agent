import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {ensureReadonlySessionQuerySchema,} from "../src/domain/threads/runtime/index.js";
import {PostgresScheduledTaskStore} from "../src/domain/scheduling/tasks/index.js";
import {PostgresTelepathyDeviceStore} from "../src/domain/telepathy/index.js";
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

      if (/^CREATE VIEW "session"."(messages_raw|tool_results|inputs|runs|agent_prompts|agent_pairings|agent_skills|agent_telepathy_devices|agent_sessions)"/i.test(statement)) {
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
    const provenanceMessage = await threadStore.appendRuntimeMessage("session-thread", {
      origin: "input",
      source: "tui",
      identityId: alice.id,
      message: {
        role: "user",
        content: "Remind me to research bees.",
      },
    });

    const scheduledTasks = new PostgresScheduledTaskStore({pool});
    await scheduledTasks.ensureSchema();

    const created = await scheduledTasks.createTask({
      sessionId: "session-main",
      createdByIdentityId: alice.id,
      createdFromMessageId: provenanceMessage.id,
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
      createdFromMessageId: provenanceMessage.id,
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
    expect(updated.nextFireAt).toBeDefined();

    const cancelled = await scheduledTasks.cancelTask({
      taskId: created.id,
      sessionId: "session-main",
      reason: "done already",
    });

    expect(cancelled.cancelledAt).toBeDefined();
    expect(cancelled.nextFireAt).toBeUndefined();

    await pool.query(`DELETE FROM "runtime"."messages" WHERE id = $1`, [provenanceMessage.id]);
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
    await scheduledTasks.ensureSchema();

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

    const scheduledTasks = new PostgresScheduledTaskStore({pool});
    await scheduledTasks.ensureSchema();

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
    await scheduledTasks.ensureSchema();
    await new PostgresTelepathyDeviceStore({pool}).ensureSchema();
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
    const provenanceMessage = await threadStore.appendRuntimeMessage("home-a", {
      origin: "input",
      source: "tui",
      identityId: alice.id,
      message: {
        role: "user",
        content: "Remind me to buy apples.",
      },
    });

    const aliceTask = await scheduledTasks.createTask({
      sessionId: "session-alice",
      createdByIdentityId: alice.id,
      createdFromMessageId: provenanceMessage.id,
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
    const threadRun = await threadStore.createRun("home-a");
    await scheduledTasks.startTaskRun({
      runId: claim!.run.id,
      resolvedThreadId: "home-a",
    });
    await scheduledTasks.completeTaskRun({
      runId: claim!.run.id,
      resolvedThreadId: "home-a",
      threadRunId: threadRun.id,
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
      created_from_message_id: provenanceMessage.id,
    }]);

    const messageResult = await pool.query(`
      SELECT id, thread_id, sequence, role, text
      FROM "session"."messages"
      WHERE id = $1
    `, [provenanceMessage.id]);
    expect(messageResult.rows).toEqual([{
      id: provenanceMessage.id,
      thread_id: "home-a",
      sequence: provenanceMessage.sequence,
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
      status: "succeeded",
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
      created_from_message_id: provenanceMessage.id,
    }]);
  });
});
