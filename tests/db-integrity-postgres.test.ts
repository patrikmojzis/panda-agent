import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {stringToUserMessage} from "../src/index.js";
import {ConversationRepo, SessionRouteRepo} from "../src/domain/sessions/index.js";
import {PostgresScheduledTaskStore} from "../src/domain/scheduling/tasks/index.js";
import {PostgresWatchStore} from "../src/domain/watches/index.js";
import {PostgresOutboundDeliveryStore} from "../src/domain/channels/deliveries/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

function createPool() {
  const db = newDb();
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  return new adapter.Pool();
}

describe("Database integrity hardening", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (pool) {
        await pool.end();
      }
    }
  });

  it("rejects missing ownership and provenance references on sessions", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);

    await expect(sessionStore.createSession({
      id: "missing-agent-session",
      agentKey: "ghost",
      kind: "main",
      currentThreadId: "thread-1",
    })).rejects.toThrow();

    await expect(sessionStore.createSession({
      id: "missing-identity-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-1",
      createdByIdentityId: "ghost-identity",
    })).rejects.toThrow();

    const identity = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
      createdByIdentityId: identity.id,
    });
    await sessionStore.createSession({
      id: "session-b",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-b",
    });
    await threadStore.createThread({
      id: "thread-a",
      sessionId: "session-a",
    });
    await threadStore.createThread({
      id: "thread-b",
      sessionId: "session-b",
    });

    await expect(sessionStore.updateCurrentThread({
      sessionId: "session-a",
      currentThreadId: "thread-b",
    })).rejects.toThrow("does not belong");
  });

  it("rejects soft-route and conversation bindings that point at missing parents", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore} = await createRuntimeStores(pool);
    const routes = new SessionRouteRepo({pool});
    const conversations = new ConversationRepo({pool});
    await routes.ensureSchema();
    await conversations.ensureSchema();

    await expect(routes.saveLastRoute({
      sessionId: "missing-session",
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        capturedAt: 1,
      },
    })).rejects.toThrow();

    await expect(conversations.bindConversation({
      source: "telegram",
      connectorKey: "bot-1",
      externalConversationId: "chat-1",
      sessionId: "missing-session",
    })).rejects.toThrow();

    const identity = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
      createdByIdentityId: identity.id,
    });

    await routes.saveLastRoute({
      sessionId: "session-a",
      route: {
        source: "telegram",
        connectorKey: "bot-main",
        externalConversationId: "chat-global",
        capturedAt: 10,
      },
    });
    await routes.saveLastRoute({
      sessionId: "session-a",
      identityId: identity.id,
      route: {
        source: "telegram",
        connectorKey: "bot-main",
        externalConversationId: "chat-identity",
        capturedAt: 20,
      },
    });

    await expect(routes.getLastRoute({
      sessionId: "session-a",
    })).resolves.toMatchObject({
      externalConversationId: "chat-global",
    });
    await expect(routes.getLastRoute({
      sessionId: "session-a",
      identityId: identity.id,
    })).resolves.toMatchObject({
      externalConversationId: "chat-identity",
    });

    await pool.query(`DELETE FROM "runtime"."identities" WHERE id = $1`, [identity.id]);
    const remainingRoutes = await pool.query(`
      SELECT identity_id, external_conversation_id
      FROM "runtime"."session_routes"
      ORDER BY external_conversation_id
    `);
    expect(remainingRoutes.rows).toEqual([{
      identity_id: null,
      external_conversation_id: "chat-global",
    }]);
  });

  it("rejects cross-thread message and bash run links", async () => {
    const pool = createPool();
    pools.push(pool);

    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
    });
    await sessionStore.createSession({
      id: "session-b",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-b",
    });
    await threadStore.createThread({
      id: "thread-a",
      sessionId: "session-a",
    });
    await threadStore.createThread({
      id: "thread-b",
      sessionId: "session-b",
    });

    const run = await threadStore.createRun("thread-a");

    await expect(threadStore.appendRuntimeMessage("thread-b", {
      source: "tui",
      message: stringToUserMessage("hello"),
      runId: run.id,
    })).rejects.toThrow();

    await expect(threadStore.createToolJob({
      id: "job-1",
      threadId: "thread-b",
      runId: run.id,
      kind: "bash",
      summary: "echo hi",
    })).rejects.toThrow();
  });

  it("rejects scheduled task run scope mismatches", async () => {
    const pool = createPool();
    pools.push(pool);

    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const tasks = new PostgresScheduledTaskStore({pool});
    await tasks.ensureSchema();

    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
    });
    await sessionStore.createSession({
      id: "session-b",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-b",
    });
    await threadStore.createThread({
      id: "thread-a",
      sessionId: "session-a",
    });
    await threadStore.createThread({
      id: "thread-b",
      sessionId: "session-b",
    });

    const task = await tasks.createTask({
      sessionId: "session-a",
      title: "Task A",
      instruction: "Run task A",
      schedule: {
        kind: "once",
        runAt: "2000-04-17T10:00:00.000Z",
      },
    });

    await expect(pool.query(`
      INSERT INTO "runtime"."scheduled_task_runs" (
        id,
        task_id,
        session_id,
        scheduled_for,
        status
      ) VALUES (
        '00000000-0000-4000-8000-000000000001',
        $1,
        'session-b',
        NOW(),
        'claimed'
      )
    `, [task.id])).rejects.toThrow();

    const claim = await tasks.claimTask({
      taskId: task.id,
      claimedBy: "runner",
      claimExpiresAt: Date.now() + 60_000,
    });
    expect(claim).not.toBeNull();

    await expect(tasks.startTaskRun({
      runId: claim!.run.id,
      resolvedThreadId: "thread-b",
    })).rejects.toThrow();

    const threadRun = await threadStore.createRun("thread-b");
    await expect(tasks.completeTaskRun({
      runId: claim!.run.id,
      resolvedThreadId: "thread-a",
      threadRunId: threadRun.id,
    })).rejects.toThrow();
  });

  it("rejects watch scope mismatches and nulls audit links on delete", async () => {
    const pool = createPool();
    pools.push(pool);

    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const watches = new PostgresWatchStore({pool});
    await watches.ensureSchema();

    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
    });
    await sessionStore.createSession({
      id: "session-b",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-b",
    });
    await threadStore.createThread({
      id: "thread-a",
      sessionId: "session-a",
    });
    await threadStore.createThread({
      id: "thread-b",
      sessionId: "session-b",
    });

    const watch = await watches.createWatch({
      sessionId: "session-a",
      title: "Registrations",
      intervalMinutes: 5,
      source: {
        kind: "http_json",
        url: "https://example.com",
        result: {
          observation: "scalar",
          valuePath: "price",
        },
      },
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    });
    const otherWatch = await watches.createWatch({
      sessionId: "session-a",
      title: "Orders",
      intervalMinutes: 5,
      source: {
        kind: "http_json",
        url: "https://example.com/orders",
        result: {
          observation: "scalar",
          valuePath: "count",
        },
      },
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    });

    const claim = await watches.claimWatch({
      watchId: watch.id,
      claimedBy: "watch-runner",
      claimExpiresAt: Date.now() + 60_000,
    });
    expect(claim).not.toBeNull();

    await expect(watches.startWatchRun({
      runId: claim!.run.id,
      resolvedThreadId: "thread-b",
    })).rejects.toThrow();

    await expect(watches.recordEvent({
      watchId: watch.id,
      sessionId: "session-a",
      resolvedThreadId: "thread-b",
      eventKind: "new_items",
      summary: "Wrong thread",
      dedupeKey: "wrong-thread",
    })).rejects.toThrow();
    const otherEvent = await watches.recordEvent({
      watchId: otherWatch.id,
      sessionId: "session-a",
      resolvedThreadId: "thread-a",
      eventKind: "new_items",
      summary: "Wrong watch",
      dedupeKey: "wrong-watch",
    });
    await expect(watches.completeWatchRun({
      runId: claim!.run.id,
      status: "changed",
      resolvedThreadId: "thread-a",
      emittedEventId: otherEvent.event.id,
      lastError: null,
    })).rejects.toThrow();

    const event = await watches.recordEvent({
      watchId: watch.id,
      sessionId: "session-a",
      resolvedThreadId: "thread-a",
      eventKind: "new_items",
      summary: "All good",
      dedupeKey: "good-thread",
    });
    const completed = await watches.completeWatchRun({
      runId: claim!.run.id,
      status: "changed",
      resolvedThreadId: "thread-a",
      emittedEventId: event.event.id,
      lastError: null,
    });
    expect(completed.emittedEventId).toBe(event.event.id);

    await pool.query(`DELETE FROM "runtime"."watch_events" WHERE id = $1`, [event.event.id]);
    const runRows = await pool.query(`
      SELECT emitted_event_id
      FROM "runtime"."watch_runs"
      WHERE id = $1
    `, [claim!.run.id]);
    expect(runRows.rows).toEqual([{
      emitted_event_id: null,
    }]);
  });

  it("cascades session trees on agent delete and nulls outbound thread audit links on thread delete", async () => {
    const pool = createPool();
    pools.push(pool);

    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const outbound = new PostgresOutboundDeliveryStore({pool});
    await outbound.ensureSchema();

    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
    });
    await threadStore.createThread({
      id: "thread-a",
      sessionId: "session-a",
    });

    const delivery = await outbound.enqueueDelivery({
      threadId: "thread-a",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{type: "text", text: "hello"}],
    });

    await pool.query(`DELETE FROM "runtime"."threads" WHERE id = 'thread-a'`);
    const deliveryRows = await pool.query(`
      SELECT thread_id
      FROM "runtime"."outbound_deliveries"
      WHERE id = $1
    `, [delivery.id]);
    expect(deliveryRows.rows).toEqual([{
      thread_id: null,
    }]);

    await pool.query(`DELETE FROM "runtime"."agents" WHERE agent_key = 'panda'`);
    const sessionCounts = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."agent_sessions"`);
    const threadCounts = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."threads"`);
    expect(sessionCounts.rows).toEqual([{count: 0}]);
    expect(threadCounts.rows).toEqual([{count: 0}]);
  });
});
