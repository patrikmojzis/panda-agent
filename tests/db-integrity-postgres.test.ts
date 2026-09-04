import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {stringToUserMessage} from "../src/index.js";
import {ConversationRepo, SessionRouteRepo} from "../src/domain/sessions/index.js";
import {ensurePostgresConversationSessionSchema} from "../src/domain/sessions/conversations/postgres-schema.js";
import {ensurePostgresSessionRouteSchema} from "../src/domain/sessions/routes/postgres-schema.js";
import {PostgresScheduledTaskStore} from "../src/domain/scheduling/tasks/index.js";
import {ensurePostgresScheduledTaskSchema} from "../src/domain/scheduling/tasks/postgres-schema.js";
import {PostgresWatchStore} from "../src/domain/watches/index.js";
import {ensurePostgresWatchSchema} from "../src/domain/watches/postgres-schema.js";
import {PostgresOutboundDeliveryStore} from "../src/domain/channels/deliveries/index.js";
import {ensurePostgresOutboundDeliverySchema} from "../src/domain/channels/deliveries/postgres-schema.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {seedPendingThreadInput} from "./helpers/thread-runtime-fixtures.js";

function createPool() {
  const db = newDb({noAstCoverageCheck: true});
  db.public.registerFunction({name: "clock_timestamp", returns: DataType.timestamptz, impure: true, implementation: () => new Date()});
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
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
    await ensurePostgresSessionRouteSchema(pool);
    await ensurePostgresConversationSessionSchema(pool);

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

  it("rejects cross-session thread replacement and cross-thread run links", async () => {
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
    await expect(threadStore.createThread({
      id: "thread-invalid-replacement",
      sessionId: "session-a",
      replacesThreadId: "thread-b",
    })).rejects.toThrow();

    const runId = "00000000-0000-4000-8000-000000000001";
    await pool.query(`
      INSERT INTO "runtime"."runs" (id, thread_id, status, started_at, finished_at)
      VALUES ($1, 'thread-a', 'completed', NOW(), NOW())
    `, [runId]);

    await expect(pool.query(`
      INSERT INTO "runtime"."messages" (
        id, thread_id, origin, source, run_id, run_thread_id, created_at, message
      ) VALUES (
        '00000000-0000-4000-8000-000000000002',
        'thread-b',
        'runtime',
        'tui',
        $1,
        'thread-b',
        NOW(),
        $2::jsonb
      )
    `, [runId, JSON.stringify(stringToUserMessage("hello"))])).rejects.toThrow();

    await expect(pool.query(`
      INSERT INTO "runtime"."tool_jobs" (
        id, thread_id, run_id, run_thread_id, kind, status, summary, started_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000003',
        'thread-b',
        $1,
        'thread-b',
        'bash',
        'running',
        'echo hi',
        NOW()
      )
    `, [runId])).rejects.toThrow();
  });

  it("rejects scheduled task run scope mismatches", async () => {
    const pool = createPool();
    pools.push(pool);

    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const tasks = new PostgresScheduledTaskStore({pool});
    await ensurePostgresScheduledTaskSchema(pool);

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
        'pending'
      )
    `, [task.id])).rejects.toThrow();

    const scheduledRunId = "00000000-0000-4000-8000-000000000002";
    const claimToken = "00000000-0000-4000-8000-000000000003";
    await pool.query(`
      INSERT INTO "runtime"."scheduled_task_runs" (
        id,
        task_id,
        session_id,
        scheduled_for,
        status,
        claim_token,
        claimed_at,
        claimed_by,
        claim_expires_at
      ) VALUES ($1, $2, 'session-a', NOW(), 'claimed', $3, NOW(), 'runner', NOW() + INTERVAL '1 minute')
    `, [scheduledRunId, task.id, claimToken]);
    const unrelatedInputId = await seedPendingThreadInput(pool, {
      threadId: "thread-a",
      source: "scheduled_task",
      message: stringToUserMessage("unrelated stable input"),
    });
    await expect(pool.query(`
      UPDATE "runtime"."scheduled_task_runs"
      SET status = 'running',
          resolved_thread_id = 'thread-a',
          resolved_thread_session_id = 'session-a',
          thread_input_id = $2,
          thread_input_thread_id = 'thread-a',
          lineage_recorded_at = NOW(),
          started_at = NOW()
      WHERE id = $1
    `, [scheduledRunId, unrelatedInputId])).rejects.toThrow();

    const wrongInputId = await seedPendingThreadInput(pool, {
      id: scheduledRunId,
      threadId: "thread-b",
      source: "scheduled_task",
      message: stringToUserMessage("wrong thread"),
    });

    await expect(pool.query(`
      UPDATE "runtime"."scheduled_task_runs"
      SET status = 'running',
          resolved_thread_id = 'thread-a',
          resolved_thread_session_id = 'session-a',
          thread_input_id = $2,
          thread_input_thread_id = 'thread-b',
          lineage_recorded_at = NOW(),
          started_at = NOW()
      WHERE id = $1
    `, [scheduledRunId, wrongInputId])).rejects.toThrow();
    await pool.query(`DELETE FROM "runtime"."inputs" WHERE id = $1`, [wrongInputId]);

    const correctInputId = await seedPendingThreadInput(pool, {
      id: scheduledRunId,
      threadId: "thread-a",
      source: "scheduled_task",
      message: stringToUserMessage("correct thread"),
    });
    await pool.query(`
      UPDATE "runtime"."scheduled_task_runs"
      SET status = 'running',
          resolved_thread_id = 'thread-a',
          resolved_thread_session_id = 'session-a',
          thread_input_id = $2,
          thread_input_thread_id = 'thread-a',
          lineage_recorded_at = NOW(),
          started_at = NOW()
      WHERE id = $1
    `, [scheduledRunId, correctInputId]);
    const threadRunId = "00000000-0000-4000-8000-000000000004";
    await pool.query(`
      INSERT INTO "runtime"."runs" (id, thread_id, status, started_at, finished_at)
      VALUES ($1, 'thread-b', 'completed', NOW(), NOW())
    `, [threadRunId]);
    await expect(pool.query(`
      UPDATE "runtime"."scheduled_task_runs"
      SET status = 'succeeded',
          thread_run_id = $2,
          thread_run_thread_id = 'thread-b',
          finished_at = NOW(),
          claim_token = NULL,
          claim_expires_at = NULL
      WHERE id = $1
    `, [scheduledRunId, threadRunId])).rejects.toThrow();
  });

  it("rejects watch scope mismatches and nulls audit links on delete", async () => {
    const pool = createPool();
    pools.push(pool);

    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const watches = new PostgresWatchStore({pool});
    await ensurePostgresWatchSchema(pool);

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

    const running = await watches.startWatchRun({runId: claim!.run.id});
    expect(running?.resolvedThreadId).toBe("thread-a");
    await expect(pool.query(`UPDATE runtime.watch_runs SET resolved_thread_id = 'thread-b'
      WHERE id = $1`, [claim!.run.id])).rejects.toThrow();
    const eventId = "00000000-0000-4000-8000-000000000004";
    await expect(pool.query(`INSERT INTO runtime.watch_events
      (id, watch_id, session_id, resolved_thread_id, resolved_thread_session_id, event_kind, summary, dedupe_key)
      VALUES ($1, $2, 'session-a', 'thread-b', 'session-a', 'new_items', 'Wrong thread', 'wrong-thread')`,
      [eventId, watch.id])).rejects.toThrow();
    await pool.query(`INSERT INTO runtime.watch_events
      (id, watch_id, session_id, resolved_thread_id, resolved_thread_session_id, event_kind, summary, dedupe_key)
      VALUES ($1, $2, 'session-a', 'thread-a', 'session-a', 'new_items', 'Other watch', 'other-watch')`,
      [eventId, otherWatch.id]);
    await expect(pool.query(`UPDATE runtime.watch_runs SET emitted_event_id = $2, emitted_event_watch_id = watch_id
      WHERE id = $1`, [claim!.run.id, eventId])).rejects.toThrow();
    await pool.query(`UPDATE runtime.watch_events SET watch_id = $2 WHERE id = $1`, [eventId, watch.id]);
    await pool.query(`UPDATE runtime.watch_runs SET emitted_event_id = $2, emitted_event_watch_id = watch_id
      WHERE id = $1`, [claim!.run.id, eventId]);
    await pool.query(`DELETE FROM "runtime"."watch_events" WHERE id = $1`, [eventId]);
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
    await ensurePostgresOutboundDeliverySchema(pool);

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
