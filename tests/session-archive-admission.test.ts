import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {stringToUserMessage} from "../src/kernel/agent/helpers/input.js";
import {PostgresChannelActionStore} from "../src/domain/channels/actions/postgres.js";
import {ensurePostgresChannelActionSchema} from "../src/domain/channels/actions/postgres-schema.js";
import {PostgresOutboundDeliveryStore} from "../src/domain/channels/deliveries/postgres.js";
import {ensurePostgresOutboundDeliverySchema} from "../src/domain/channels/deliveries/postgres-schema.js";
import {PostgresScheduledTaskStore} from "../src/domain/scheduling/tasks/postgres.js";
import {ensurePostgresScheduledTaskSchema} from "../src/domain/scheduling/tasks/postgres-schema.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/postgres.js";
import {SessionArchivedError} from "../src/domain/threads/runtime/store.js";
import {PostgresWatchStore} from "../src/domain/watches/postgres.js";
import {ensurePostgresWatchSchema} from "../src/domain/watches/postgres-schema.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

function createPool() {
  const db = newDb({noAstCoverageCheck: true});
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  return new adapter.Pool();
}

describe("session archive admission", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) await pools.pop()?.end();
  });

  it("hides archived branches and fences runtime work without deleting configuration", async () => {
    const pool = createPool();
    pools.push(pool);
    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    await ensurePostgresScheduledTaskSchema(pool);
    await ensurePostgresWatchSchema(pool);
    await ensurePostgresOutboundDeliverySchema(pool);
    await ensurePostgresChannelActionSchema(pool);
    const tasks = new PostgresScheduledTaskStore({
      pool: {
        connect: () => pool.connect(),
        query: (text, values) => text.includes("session.archived_at IS NULL")
          && text.includes("scheduled_task_runs")
          ? pool.query(`
              SELECT task.*
              FROM "runtime"."scheduled_tasks" AS task
              INNER JOIN "runtime"."agent_sessions" AS session
                ON session.id = task.session_id
               AND session.archived_at IS NULL
              WHERE task.enabled = TRUE
                AND task.cancelled_at IS NULL
                AND task.completed_at IS NULL
                AND task.next_fire_at IS NOT NULL
                AND task.next_fire_at <= $1
              ORDER BY task.next_fire_at ASC, task.id ASC
              LIMIT $2
            `, values)
          : pool.query(text, values),
      },
    });
    const watches = new PostgresWatchStore({pool});
    const deliveries = new PostgresOutboundDeliveryStore({pool});
    const actions = new PostgresChannelActionStore({pool});

    await sessionStore.createSession({
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-main",
    });
    await threadStore.createThread({id: "thread-main", sessionId: "session-main"});
    await sessionStore.createSession({
      id: "session-branch",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-branch",
    });
    await threadStore.createThread({id: "thread-branch", sessionId: "session-branch"});
    await sessionStore.updateHeartbeatConfig({
      sessionId: "session-branch",
      enabled: true,
      everyMinutes: 5,
      asOf: 0,
    });
    const task = await tasks.createTask({
      sessionId: "session-branch",
      title: "Archive fence",
      instruction: "This must not run while archived.",
      schedule: {kind: "once", runAt: "2099-08-26T00:00:00.000Z"},
    });
    const watch = await watches.createWatch({
      sessionId: "session-branch",
      title: "Archive fence",
      intervalMinutes: 5,
      source: {
        kind: "http_json",
        url: "https://example.test/status",
        result: {observation: "scalar", valuePath: "value"},
      },
      detector: {kind: "percent_change", percent: 10},
    });
    const pendingDelivery = await deliveries.enqueueDelivery({
      sessionId: "session-branch",
      threadId: "thread-branch",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{type: "text", text: "must not escape"}],
    });
    const pendingAction = await actions.enqueueAction({
      sessionId: "session-branch",
      threadId: "thread-branch",
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: {
        channel: "telegram",
        target: {
          source: "telegram",
          connectorKey: "bot-1",
          externalConversationId: "chat-1",
        },
        phase: "start",
      },
    });
    const dueAt = Date.parse("2100-08-27T00:00:00.000Z");
    expect((await tasks.listDueTasks({asOf: dueAt})).map((record) => record.id)).toContain(task.id);
    expect((await watches.listDueWatches({asOf: dueAt})).map((record) => record.id)).toContain(watch.id);

    await pool.query(`
      UPDATE "runtime"."agent_sessions"
      SET archived_at = '2026-08-25T12:00:00.000Z'
      WHERE id = 'session-branch'
    `);

    await expect(pool.query(`
      SELECT id, archived_at, archived_at IS NOT NULL AS archived
      FROM "runtime"."agent_sessions"
      ORDER BY id
    `)).resolves.toMatchObject({rows: [
      {id: "session-branch", archived: true},
      {id: "session-main", archived: false},
    ]});
    expect((await sessionStore.listAgentSessions("panda")).map((session) => session.id))
      .toEqual(["session-main"]);
    await expect(deliveries.enqueueDelivery({
      sessionId: "session-branch",
      threadId: "thread-branch",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{type: "text", text: "blocked"}],
    })).rejects.toBeInstanceOf(SessionArchivedError);
    await expect(actions.enqueueAction({
      sessionId: "session-branch",
      threadId: "thread-branch",
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: {
        channel: "telegram",
        target: {
          source: "telegram",
          connectorKey: "bot-1",
          externalConversationId: "chat-1",
        },
        phase: "stop",
      },
    })).rejects.toBeInstanceOf(SessionArchivedError);
    await expect(tasks.listDueTasks({asOf: dueAt})).resolves.toEqual([]);
    await expect(watches.listDueWatches({asOf: dueAt})).resolves.toEqual([]);
    expect((await sessionStore.listDueHeartbeats({asOf: dueAt})).map((heartbeat) => heartbeat.sessionId))
      .not.toContain("session-branch");
    await expect(watches.claimWatch({
      watchId: watch.id,
      claimedBy: "watch-runner",
      claimExpiresAt: dueAt + 60_000,
      nextPollAt: dueAt + 300_000,
    })).resolves.toBeNull();
    await expect(watches.recordEvent({
      watchId: watch.id,
      sessionId: "session-branch",
      resolvedThreadId: "thread-branch",
      eventKind: "percent_change",
      summary: "blocked",
      dedupeKey: "blocked-while-archived",
      payload: {value: 1},
    })).rejects.toBeInstanceOf(SessionArchivedError);
    await expect(deliveries.claimNextPendingDelivery({
      channel: "telegram",
      connectorKey: "bot-1",
    })).resolves.toBeNull();
    await expect(actions.claimNextPendingAction({
      channel: "telegram",
      connectorKey: "bot-1",
    })).resolves.toBeNull();
    await expect(deliveries.getDelivery(pendingDelivery.id)).resolves.toMatchObject({
      status: "failed",
      lastError: "Session archived.",
    });
    await expect(pool.query(
      `SELECT status, last_error FROM "runtime"."channel_actions" WHERE id = $1`,
      [pendingAction.id],
    )).resolves.toMatchObject({
      rows: [{status: "failed", last_error: "Session archived."}],
    });

    await expect(pool.query(`
      UPDATE "runtime"."agent_sessions"
      SET archived_at = NOW()
      WHERE id = 'session-main'
    `)).rejects.toThrow("runtime_agent_sessions_archive_kind_check");
    await expect(sessionStore.getSession("session-branch")).resolves.toMatchObject({
      archivedAt: Date.parse("2026-08-25T12:00:00.000Z"),
      currentThreadId: "thread-branch",
    });
    await expect(tasks.getTask(task.id)).resolves.toMatchObject({title: "Archive fence"});
    await expect(watches.getWatch(watch.id)).resolves.toMatchObject({title: "Archive fence"});
  });

  it("reports archived session input as a terminal lifecycle error", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({rows: []})
      .mockResolvedValueOnce({rows: [{
        current_thread_id: "thread-branch",
        archived_at: new Date("2026-08-25T12:00:00.000Z"),
        blocked: false,
      }]});
    const threadStore = new PostgresThreadRuntimeStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by input admission");
        },
      },
    });

    await expect(threadStore.enqueueSessionInput("session-branch", {
      source: "test",
      message: stringToUserMessage("blocked"),
    })).rejects.toBeInstanceOf(SessionArchivedError);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
