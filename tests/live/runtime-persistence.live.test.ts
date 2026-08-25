import {randomUUID} from "node:crypto";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresConnectorLeaseRepo} from "../../src/domain/connector-leases/repo.js";
import {PostgresIdentityStore} from "../../src/domain/identity/postgres.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {LiveVoiceRepo} from "../../src/domain/live-voice/repo.js";
import {resetSessionCurrentThread} from "../../src/domain/sessions/lifecycle.js";
import {RuntimeRequestRepo} from "../../src/domain/threads/requests/repo.js";
import {buildRuntimeRequestTableNames} from "../../src/domain/threads/requests/postgres-shared.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {ThreadInputAdmissionBlockedError} from "../../src/domain/threads/runtime/store.js";
import {buildThreadRuntimeTableNames} from "../../src/domain/threads/runtime/postgres-shared.js";
import type {ThreadInputPayload, ThreadRunOwner} from "../../src/domain/threads/runtime/types.js";
import type {PgListenClient, PgPoolLike, PgQueryResult} from "../../src/lib/postgres-query.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

class StatementCountingPool implements PgPoolLike<PgListenClient> {
  queryCount = 0;
  checkoutCount = 0;

  constructor(private readonly pool: PgPoolLike<PgListenClient>) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    this.queryCount += 1;
    return this.pool.query(sql, params);
  }

  async connect(): Promise<PgListenClient> {
    this.checkoutCount += 1;
    return this.pool.connect();
  }

  reset(): void {
    this.queryCount = 0;
    this.checkoutCount = 0;
  }
}

async function withinStatementBudget<T>(
  pool: StatementCountingPool,
  expectedQueries: number,
  operation: () => Promise<T>,
): Promise<T> {
  pool.reset();
  const result = await operation();
  expect(pool.queryCount).toBe(expectedQueries);
  expect(pool.checkoutCount).toBe(0);
  return result;
}

async function waitForNotification(
  notifications: readonly {channel: string; payload?: string}[],
  predicate: (notification: {channel: string; payload?: string}) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (notifications.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForBackendLock(pool: ReturnType<typeof createPostgresPool>, pid: number): Promise<void> {
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
  throw new Error("Timed out waiting for wake admission to block on its generation fence.");
}

async function waitForLockWaiters(
  pool: ReturnType<typeof createPostgresPool>,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query(`
      SELECT COUNT(*)::integer AS waiter_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    if (Number(result.rows[0]?.waiter_count) >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const observed = await pool.query(`
    SELECT wait_event_type, LEFT(query, 240) AS query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND state = 'active'
  `);
  throw new Error(
    `Timed out waiting for ${expected} thread-lock waiters: ${JSON.stringify(observed.rows)}`,
  );
}

function inputPayload(externalMessageId: string, connectorKey = "bot-1"): ThreadInputPayload {
  return {
    source: "telegram",
    channelId: "chat-1",
    externalMessageId,
    actorId: "user-1",
    message: {
      role: "user",
      content: [{type: "text", text: `message ${externalMessageId}`}],
      timestamp: Date.now(),
    },
    metadata: {
      route: {
        source: "telegram",
        connectorKey,
        externalConversationId: "chat-1",
      },
    },
  };
}

describe("atomic runtime persistence on PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let sessionStore: PostgresSessionStore;
  let threadStore: PostgresThreadRuntimeStore;
  let connectorLeases: PostgresConnectorLeaseRepo;
  let requests: RuntimeRequestRepo;
  const owner: ThreadRunOwner = {
    source: "panda-core",
    connectorKey: "primary",
    holderId: "runtime-persistence-test",
  };

  beforeAll(async () => {
    if (!databaseUrl) {
      return;
    }
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/runtime-persistence-live-test",
      max: 12,
    });
    const agentStore = new PostgresAgentStore({pool});
    sessionStore = new PostgresSessionStore({pool});
    connectorLeases = new PostgresConnectorLeaseRepo({pool});
    threadStore = new PostgresThreadRuntimeStore({pool});
    requests = new RuntimeRequestRepo({pool, claimLeaseMs: 30_000});
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    await agentStore.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await agentStore.bootstrapAgent({agentKey: "panda-replacement", displayName: "Panda Replacement"});
    await sessionStore.createSession({
      id: "atomic-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "atomic-thread",
    });
    await threadStore.createThread({id: "atomic-thread", sessionId: "atomic-session"});
    await sessionStore.createSession({
      id: "replacement-session",
      agentKey: "panda-replacement",
      kind: "main",
      currentThreadId: "replacement-thread",
    });
    await threadStore.createThread({id: "replacement-thread", sessionId: "replacement-session"});
    await connectorLeases.tryAcquire({...owner, ttlMs: 120_000});
  });

  afterAll(async () => {
    await pool?.end();
  });

  liveIt("keeps the durable request lifecycle inside its statement budget", async () => {
    const countedPool = new StatementCountingPool(pool);
    const countedRequests = new RuntimeRequestRepo({pool: countedPool, claimLeaseMs: 30_000});
    const suffix = randomUUID();
    const idempotencyKey = `statement-budget:${suffix}`;
    const input = {
      kind: "tui_input" as const,
      payload: {
        threadId: "atomic-thread",
        actorId: "operator",
        externalMessageId: suffix,
        text: "statement budget",
      },
    };

    const enqueued = await withinStatementBudget(countedPool, 1, () => {
      return countedRequests.enqueueRequest(input, {idempotencyKey});
    });
    const duplicate = await withinStatementBudget(countedPool, 2, () => {
      return countedRequests.enqueueRequest(input, {idempotencyKey});
    });
    expect(duplicate.id).toBe(enqueued.id);

    const claimed = await withinStatementBudget(countedPool, 1, () => {
      return countedRequests.claimNextPendingRequest();
    });
    expect(claimed?.id).toBe(enqueued.id);
    await withinStatementBudget(countedPool, 1, () => {
      return countedRequests.completeRequest(enqueued.id, claimed!.claimToken!, {accepted: true});
    });
  });

  liveIt("materializes an input batch without retouching activity and stays inside its statement budget", async () => {
    const suffix = randomUUID();
    const sessionId = `statement-budget-session-${suffix}`;
    const threadId = `statement-budget-thread-${suffix}`;
    const countedPool = new StatementCountingPool(pool);
    const countedThreads = new PostgresThreadRuntimeStore({pool: countedPool});
    const listener = await pool.connect();
    const notifications: Array<{channel: string; payload?: string}> = [];
    listener.on("notification", (notification) => {
      notifications.push({
        channel: notification.channel,
        ...(notification.payload === undefined ? {} : {payload: notification.payload}),
      });
    });

    try {
      await listener.query("LISTEN runtime_events; LISTEN runtime_persistence_budget_sync");
      await sessionStore.createSession({
        id: sessionId,
        agentKey: "panda",
        kind: "branch",
        currentThreadId: threadId,
      });
      await threadStore.createThread({id: threadId, sessionId});

      const firstExternalMessageId = `statement-budget-input-1-${suffix}`;
      const first = await withinStatementBudget(countedPool, 1, () => {
        return countedThreads.enqueueInput(threadId, inputPayload(firstExternalMessageId));
      });
      const duplicate = await withinStatementBudget(countedPool, 2, () => {
        return countedThreads.enqueueInput(threadId, inputPayload(firstExternalMessageId));
      });
      expect(duplicate.input.id).toBe(first.input.id);
      await withinStatementBudget(countedPool, 1, () => {
        return countedThreads.enqueueInput(threadId, inputPayload(`statement-budget-input-2-${suffix}`));
      });
      await withinStatementBudget(countedPool, 1, () => {
        return countedThreads.enqueueInput(threadId, inputPayload(`statement-budget-input-3-${suffix}`));
      });
      const remainingInputIds = Array.from({length: 497}, () => randomUUID());
      await pool.query(`
        INSERT INTO "runtime"."inputs" (
          id, thread_id, delivery_mode, source, connector_key, channel_id,
          external_message_id, actor_id, created_at, metadata, message
        )
        SELECT input_id, $1, 'wake', 'telegram', 'bot-1', 'chat-1',
               external_message_id, 'user-1', NOW(), $4::jsonb, $5::jsonb
        FROM UNNEST($2::uuid[], $3::text[]) AS input(input_id, external_message_id)
      `, [
        threadId,
        remainingInputIds,
        remainingInputIds.map((id) => `statement-budget-bulk-${id}`),
        JSON.stringify(inputPayload(`statement-budget-bulk-${suffix}`).metadata),
        JSON.stringify(inputPayload(`statement-budget-bulk-${suffix}`).message),
      ]);

      const run = await threadStore.tryStartRun(threadId, owner);
      expect(run).not.toBeNull();
      const before = await pool.query(`
        SELECT updated_at::text AS updated_at, xmin::text AS xmin
        FROM "runtime"."threads"
        WHERE id = $1
      `, [threadId]);

      const beforeBarrier = `before-${suffix}`;
      await pool.query("SELECT pg_notify('runtime_persistence_budget_sync', $1)", [beforeBarrier]);
      await waitForNotification(
        notifications,
        (notification) => notification.channel === "runtime_persistence_budget_sync"
          && notification.payload === beforeBarrier,
        "the pre-apply notification barrier",
      );
      notifications.length = 0;

      const applied = await withinStatementBudget(countedPool, 1, () => {
        return countedThreads.applyPendingInputs(threadId, run!.id);
      });
      expect(applied).toHaveLength(500);
      const after = await pool.query(`
        SELECT updated_at::text AS updated_at, xmin::text AS xmin
        FROM "runtime"."threads"
        WHERE id = $1
      `, [threadId]);
      expect(after.rows).toEqual(before.rows);

      const afterBarrier = `after-${suffix}`;
      await pool.query("SELECT pg_notify('runtime_persistence_budget_sync', $1)", [afterBarrier]);
      await waitForNotification(
        notifications,
        (notification) => notification.channel === "runtime_persistence_budget_sync"
          && notification.payload === afterBarrier,
        "the post-apply notification barrier",
      );
      const threadNotifications = notifications
        .filter((notification) => notification.channel === "runtime_events" && notification.payload)
        .map((notification) => JSON.parse(notification.payload!) as {kind?: unknown; threadId?: unknown})
        .filter((notification) => notification.threadId === threadId);
      expect(threadNotifications).toEqual([{kind: "thread_changed", threadId}]);

      await expect(withinStatementBudget(countedPool, 1, () => {
        return countedThreads.applyPendingInputs(threadId, run!.id);
      })).resolves.toEqual([]);
      await withinStatementBudget(countedPool, 1, () => {
        return countedThreads.appendRuntimeMessage(threadId, {
          source: "runtime",
          runId: run!.id,
          message: {
            role: "user",
            content: "continue",
            timestamp: Date.now(),
          },
        });
      });
      await threadStore.completeRun(run!.id);
    } finally {
      listener.release();
    }
  });

  liveIt("deduplicates concurrent enqueue, preserves connector scope, and atomically applies lineage", async () => {
    const concurrent = await Promise.all(Array.from({length: 20}, () => {
      return threadStore.enqueueInput("atomic-thread", inputPayload("same-message"));
    }));
    expect(concurrent.filter((result) => result.disposition === "inserted")).toHaveLength(1);
    expect(new Set(concurrent.map((result) => result.input.id))).toHaveLength(1);

    const otherConnector = await threadStore.enqueueInput(
      "atomic-thread",
      inputPayload("same-message", "bot-2"),
    );
    expect(otherConnector.disposition).toBe("inserted");

    const queued = await threadStore.enqueueInput(
      "atomic-thread",
      inputPayload("promoted-message"),
      "queue",
    );
    const wokenDuplicate = await threadStore.enqueueInput(
      "atomic-thread",
      inputPayload("promoted-message"),
      "wake",
    );
    expect(wokenDuplicate).toMatchObject({
      disposition: "duplicate_pending",
      input: {id: queued.input.id, deliveryMode: "queue"},
    });

    const run = await threadStore.tryStartRun("atomic-thread", owner);
    expect(run).not.toBeNull();
    const concurrentApply = await Promise.all([
      threadStore.applyPendingInputs("atomic-thread", run!.id),
      threadStore.applyPendingInputs("atomic-thread", run!.id),
    ]);
    const applied = concurrentApply.flat();
    expect(applied).toHaveLength(3);
    expect(new Set(applied.map((message) => message.id))).toHaveLength(3);
    expect(applied.every((message) => message.inputId && message.runId === run!.id)).toBe(true);

    const firstInput = concurrent[0]!.input;
    await expect(threadStore.getInput(firstInput.id)).resolves.toMatchObject({
      status: "applied",
      appliedRunId: run!.id,
    });
    const tables = buildThreadRuntimeTableNames();
    const scrubbed = await pool.query(
      `SELECT message, metadata FROM ${tables.inputs} WHERE id = $1`,
      [firstInput.id],
    );
    expect(scrubbed.rows[0]).toEqual({message: null, metadata: null});

    const duplicateApplied = await threadStore.enqueueInput("atomic-thread", inputPayload("same-message"));
    expect(duplicateApplied).toMatchObject({
      disposition: "duplicate_applied",
      input: {id: firstInput.id, appliedRunId: run!.id},
    });

    const runtimeMessage = await threadStore.appendRuntimeMessage("atomic-thread", {
      source: "runtime",
      runId: run!.id,
      message: {
        role: "user",
        content: "continue",
        timestamp: Date.now(),
      },
    });
    expect(runtimeMessage).toMatchObject({threadId: "atomic-thread", runId: run!.id});
    await threadStore.completeRun(run!.id);

    const rejected = await threadStore.enqueueInput("atomic-thread", inputPayload("finished-run"));
    await expect(threadStore.applyPendingInputs("atomic-thread", run!.id)).rejects.toThrow(
      "is no longer owned by this daemon",
    );
    await expect(threadStore.getInput(rejected.input.id)).resolves.toMatchObject({status: "pending"});
  });

  liveIt("atomically creates one live voice turn with one replay-safe request", async () => {
    const voice = new LiveVoiceRepo({pool});
    const liveVoiceSessionId = randomUUID();
    const sourceUtteranceId = randomUUID();
    await voice.upsertSession({
      id: liveVoiceSessionId,
      source: "discord",
      connectorKey: "bot-1",
      scopeKey: "guild-1",
      roomKey: "voice-1",
      sessionId: "atomic-session",
      agentKey: "panda",
      provider: "openai-live",
      model: "gpt-live-1-codex",
      state: "connected",
    });
    const input = {
      id: randomUUID(),
      liveVoiceSessionId,
      providerDelegationId: "delegation-atomic-1",
      sourceUtteranceId,
      sessionId: "atomic-session",
      agentKey: "panda",
      externalActorId: "user-1",
      prompt: "check atomic status",
    };

    const first = await voice.createOrGetTurnAndEnqueueDelegation(input);
    const replay = await voice.createOrGetTurnAndEnqueueDelegation({
      ...input,
      id: randomUUID(),
      providerDelegationId: "delegation-atomic-2",
    });
    expect(replay.id).toBe(first.id);
    await expect(pool.query(`
      SELECT payload, idempotency_key
      FROM runtime.runtime_requests
      WHERE idempotency_key = $1
    `, [`live_voice_delegation:${first.id}`])).resolves.toMatchObject({
      rows: [{
        payload: {liveVoiceTurnId: first.id, sessionId: "atomic-session"},
        idempotency_key: `live_voice_delegation:${first.id}`,
      }],
    });
  });

  liveIt("persists input and monotonic outbound route in one session-targeted mutation", async () => {
    const suffix = randomUUID();
    const sessionId = `route-session-${suffix}`;
    const threadId = `route-thread-${suffix}`;
    const identityId = `route-identity-${suffix}`;
    const inputId = randomUUID();
    await new PostgresIdentityStore({pool}).createIdentity({
      id: identityId,
      handle: `route-${suffix}`,
      displayName: "Route Test",
    });
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: threadId,
    });
    await threadStore.createThread({id: threadId, sessionId});
    const route = {
      source: "telegram",
      connectorKey: "bot-1",
      externalConversationId: "route-chat",
      externalActorId: "route-user",
      externalMessageId: "route-message",
      capturedAt: 200,
    } as const;

    await expect(threadStore.enqueueSessionInput(
      sessionId,
      inputPayload(`route-input-${suffix}`),
      "wake",
      {inputId, rememberedRoute: {identityId, route}},
    )).resolves.toMatchObject({disposition: "inserted", input: {id: inputId, threadId}});
    const persisted = await pool.query(`
      SELECT input.id AS input_id,
             route.captured_at_ms::integer AS captured_at,
             route.external_conversation_id
      FROM "runtime"."inputs" AS input
      INNER JOIN "runtime"."session_routes" AS route
        ON route.session_id = $1
       AND route.identity_id = $3
       AND route.channel = 'telegram'
      WHERE input.id = $2
    `, [sessionId, inputId, identityId]);
    expect(persisted.rows).toEqual([{
      input_id: inputId,
      captured_at: 200,
      external_conversation_id: "route-chat",
    }]);

    await expect(threadStore.enqueueSessionInput(
      sessionId,
      inputPayload(`route-input-${suffix}`),
      "wake",
      {inputId, rememberedRoute: {identityId, route: {...route, capturedAt: 100}}},
    )).resolves.toMatchObject({disposition: "duplicate_pending"});
    await expect(pool.query(`
      SELECT captured_at_ms::integer AS captured_at
      FROM "runtime"."session_routes"
      WHERE session_id = $1 AND identity_id = $2 AND channel = 'telegram'
    `, [sessionId, identityId])).resolves.toMatchObject({rows: [{captured_at: 200}]});

    const collisionSessionId = `route-collision-session-${suffix}`;
    const collisionThreadId = `route-collision-thread-${suffix}`;
    await sessionStore.createSession({
      id: collisionSessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: collisionThreadId,
    });
    await threadStore.createThread({id: collisionThreadId, sessionId: collisionSessionId});
    await expect(threadStore.enqueueSessionInput(
      collisionSessionId,
      inputPayload(`route-collision-${suffix}`),
      "wake",
      {
        inputId,
        rememberedRoute: {
          route: {
            ...route,
            externalConversationId: "rejected-route",
            capturedAt: 300,
          },
        },
      },
    )).rejects.toThrow(`Thread input conflict for ${inputId}`);
    await expect(pool.query(`
      SELECT COUNT(*)::integer AS count
      FROM "runtime"."session_routes"
      WHERE session_id = $1
    `, [collisionSessionId])).resolves.toMatchObject({rows: [{count: 0}]});

    await expect(threadStore.enqueueSessionInput(
      `missing-${sessionId}`,
      inputPayload(`missing-route-input-${suffix}`),
      "wake",
      {rememberedRoute: {route}},
    )).rejects.toThrow(`Unknown session missing-${sessionId}`);
    await expect(pool.query(`
      SELECT COUNT(*)::integer AS count
      FROM "runtime"."session_routes"
      WHERE session_id = $1
    `, [`missing-${sessionId}`])).resolves.toMatchObject({rows: [{count: 0}]});
  });

  liveIt("keeps queue-only input outside an active run until a durable wake", async () => {
    const suffix = randomUUID();
    const sessionId = `queue-boundary-session-${suffix}`;
    const threadId = `queue-boundary-thread-${suffix}`;
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: threadId,
    });
    await threadStore.createThread({id: threadId, sessionId});
    await threadStore.enqueueInput(threadId, inputPayload(`queue-boundary-start-${suffix}`));
    const run = await threadStore.tryStartRun(threadId, owner);
    expect(run).not.toBeNull();
    await threadStore.applyPendingInputs(threadId, run!.id);

    const queued = await threadStore.enqueueInput(
      threadId,
      inputPayload(`queue-boundary-late-${suffix}`),
      "queue",
    );
    await expect(threadStore.takeRunBoundary(threadId, run!.id)).resolves.toEqual({
      hasAdmittedInputs: false,
      hadPendingWake: false,
    });
    await expect(threadStore.completeRun(run!.id)).resolves.toMatchObject({status: "completed"});
    await expect(threadStore.hasPendingWake(threadId)).resolves.toBe(false);
    await expect(threadStore.getInput(queued.input.id)).resolves.toMatchObject({status: "pending"});

    await threadStore.requestWake(threadId);
    await expect(threadStore.hasPendingWake(threadId)).resolves.toBe(true);
    const nextRun = await threadStore.tryStartRun(threadId, owner);
    expect(nextRun).not.toBeNull();
    await expect(threadStore.applyPendingInputs(threadId, nextRun!.id)).resolves.toHaveLength(1);
    await expect(threadStore.getInput(queued.input.id)).resolves.toMatchObject({status: "applied"});
    await threadStore.completeRun(nextRun!.id);
  });

  liveIt("binds an abort replay to its original run instead of a later run", async () => {
    const suffix = randomUUID();
    const sessionId = `abort-replay-session-${suffix}`;
    const threadId = `abort-replay-thread-${suffix}`;
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: threadId,
    });
    await threadStore.createThread({id: threadId, sessionId});
    const operationId = (await requests.enqueueRequest({
      kind: "abort_thread",
      payload: {threadId, reason: "stop once"},
    }, {idempotencyKey: `test:abort-replay:${suffix}`})).id;
    await threadStore.enqueueInput(threadId, inputPayload(`abort-first-${suffix}`));
    const firstRun = await threadStore.tryStartRun(threadId, owner);
    expect(firstRun).not.toBeNull();

    const concurrentAbort = await Promise.all([
      threadStore.requestRunAbort(threadId, "stop once", operationId),
      threadStore.requestRunAbort(threadId, "stop once", operationId),
    ]);
    expect(concurrentAbort).toEqual([
      expect.objectContaining({id: firstRun!.id, abortReason: "stop once"}),
      expect.objectContaining({id: firstRun!.id, abortReason: "stop once"}),
    ]);
    await threadStore.completeRun(firstRun!.id);
    await threadStore.enqueueInput(threadId, inputPayload(`abort-second-${suffix}`));
    const secondRun = await threadStore.tryStartRun(threadId, owner);
    expect(secondRun).not.toBeNull();

    await expect(threadStore.requestRunAbort(threadId, "stop once", operationId))
      .resolves.toMatchObject({id: firstRun!.id});
    await expect(threadStore.getRun(secondRun!.id)).resolves.toMatchObject({
      status: "running",
      abortRequestedAt: undefined,
    });
    const conflictSessionId = `abort-conflict-session-${suffix}`;
    const conflictThreadId = `abort-conflict-thread-${suffix}`;
    await sessionStore.createSession({
      id: conflictSessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: conflictThreadId,
    });
    await threadStore.createThread({id: conflictThreadId, sessionId: conflictSessionId});
    await expect(threadStore.requestRunAbort(conflictThreadId, "stop once", operationId))
      .rejects.toThrow("conflicts with another request");
    await expect(pool.query(`
      SELECT COUNT(*)::integer AS count
      FROM ${buildThreadRuntimeTableNames().abortOperations}
      WHERE operation_id = $1
    `, [operationId])).resolves.toMatchObject({rows: [{count: 1}]});
    await threadStore.completeRun(secondRun!.id);
  });

  liveIt("keeps a reset-aborted current thread durably ineligible for another run", async () => {
    const suffix = randomUUID();
    const sessionId = `reset-fence-session-${suffix}`;
    const threadId = `reset-fence-thread-${suffix}`;
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: threadId,
    });
    await threadStore.createThread({id: threadId, sessionId});
    await threadStore.enqueueInput(threadId, inputPayload(`reset-fence-${suffix}`));
    const operationId = (await requests.enqueueRequest({
      kind: "reset_session",
      payload: {source: "operator", sessionId},
    }, {idempotencyKey: `test:reset-fence:${suffix}`})).id;

    await expect(threadStore.requestRunAbort(
      threadId,
      "Reset requested from operator.",
      operationId,
      {blocksNewRuns: true},
    )).resolves.toBeNull();

    await expect(threadStore.hasPendingWake(threadId)).resolves.toBe(true);
    await expect(threadStore.isThreadRunnable(threadId)).resolves.toBe(false);
    await expect(threadStore.listRunnableThreadIds(100)).resolves.not.toContain(threadId);
    await expect(threadStore.tryStartRun(threadId, owner)).resolves.toBeNull();
  });

  liveIt("waits on the run before touching the thread during abort", async () => {
    const suffix = randomUUID();
    const sessionId = `abort-lock-session-${suffix}`;
    const threadId = `abort-lock-thread-${suffix}`;
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: threadId,
    });
    await threadStore.createThread({id: threadId, sessionId});
    await threadStore.enqueueInput(threadId, inputPayload(`abort-lock-${suffix}`));
    const run = await threadStore.tryStartRun(threadId, owner);
    expect(run).not.toBeNull();

    const blocker = await pool.connect();
    const consumer = await pool.connect();
    const probe = await pool.connect();
    const pinnedStore = new PostgresThreadRuntimeStore({
      pool: {
        query: async (sql, params) => consumer.query(sql, params ? [...params] : []),
        connect: async () => {
          throw new Error("Pinned abort lock-order store does not acquire another connection.");
        },
      },
    });
    const consumerPid = Number((await consumer.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
    const operationId = (await requests.enqueueRequest({
      kind: "abort_thread",
      payload: {threadId, reason: "lock-order abort"},
    }, {idempotencyKey: `test:abort-lock:${suffix}`})).id;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id FROM ${buildThreadRuntimeTableNames().runs} WHERE id = $1 FOR UPDATE`,
        [run!.id],
      );
      const abort = pinnedStore.requestRunAbort(threadId, "lock-order abort", operationId);
      await waitForBackendLock(pool, consumerPid);

      await probe.query("BEGIN");
      await expect(probe.query(
        `SELECT id FROM ${buildThreadRuntimeTableNames().threads} WHERE id = $1 FOR UPDATE NOWAIT`,
        [threadId],
      )).resolves.toMatchObject({rowCount: 1});
      await probe.query("ROLLBACK");
      await blocker.query("COMMIT");
      await expect(abort).resolves.toMatchObject({id: run!.id});

      // A committed replay is a read of the receipt, not another abort
      // mutation. It must not wait behind a run-owned writer or lock thread.
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id FROM ${buildThreadRuntimeTableNames().runs} WHERE id = $1 FOR UPDATE`,
        [run!.id],
      );
      const replay = pinnedStore.requestRunAbort(threadId, "lock-order abort", operationId);
      await expect(Promise.race([
        replay,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Abort replay waited on its already-bound run.")), 500);
          timer.unref?.();
        }),
      ])).resolves.toMatchObject({id: run!.id});
      await probe.query("BEGIN");
      await expect(probe.query(
        `SELECT id FROM ${buildThreadRuntimeTableNames().threads} WHERE id = $1 FOR UPDATE NOWAIT`,
        [threadId],
      )).resolves.toMatchObject({rowCount: 1});
      await probe.query("ROLLBACK");
      await blocker.query("ROLLBACK");
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await probe.query("ROLLBACK").catch(() => {});
      blocker.release();
      consumer.release();
      probe.release();
      await threadStore.completeRun(run!.id).catch(() => {});
    }
  });

  liveIt("rejects a stale claim whose snapshot predates the committed reset fence", async () => {
    const suffix = randomUUID();
    const sessionId = `reset-fence-snapshot-session-${suffix}`;
    const threadId = `reset-fence-snapshot-thread-${suffix}`;
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: threadId,
    });
    await threadStore.createThread({id: threadId, sessionId});
    await threadStore.enqueueInput(threadId, inputPayload(`reset-fence-snapshot-${suffix}`));
    const operationId = (await requests.enqueueRequest({
      kind: "reset_session",
      payload: {source: "operator", sessionId},
    }, {idempotencyKey: `test:reset-fence-snapshot:${suffix}`})).id;

    const blocker = await pool.connect();
    const claimant = await pool.connect();
    const pinnedStore = new PostgresThreadRuntimeStore({
      pool: {
        query: async (sql, params) => claimant.query(sql, params ? [...params] : []),
        connect: async () => {
          throw new Error("Pinned reset-fence snapshot store does not acquire another connection.");
        },
      },
    });
    const claimantPid = Number((await claimant.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
    try {
      await blocker.query("BEGIN");
      await blocker.query(`
        SELECT id FROM "runtime"."agent_sessions" WHERE id = $1 FOR UPDATE
      `, [sessionId]);
      const staleClaim = pinnedStore.tryStartRun(threadId, owner);
      await waitForBackendLock(pool, claimantPid);

      await expect(threadStore.requestRunAbort(
        threadId,
        "Reset requested from operator.",
        operationId,
        {blocksNewRuns: true},
      )).resolves.toBeNull();
      await blocker.query("COMMIT");
      await expect(staleClaim).resolves.toBeNull();
      await expect(threadStore.tryStartRun(threadId, owner)).resolves.toBeNull();
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      claimant.release();
    }
  });

  liveIt("aborts a run that commits while its reset fence waits on the thread", async () => {
    const suffix = randomUUID();
    const sessionId = `reset-fence-raced-run-session-${suffix}`;
    const threadId = `reset-fence-raced-run-thread-${suffix}`;
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: threadId,
    });
    await threadStore.createThread({id: threadId, sessionId});
    await threadStore.enqueueInput(threadId, inputPayload(`reset-fence-raced-run-${suffix}`));
    const operationId = (await requests.enqueueRequest({
      kind: "reset_session",
      payload: {source: "operator", sessionId},
    }, {idempotencyKey: `test:reset-fence-raced-run:${suffix}`})).id;

    const claimant = await pool.connect();
    const aborter = await pool.connect();
    const claimStore = new PostgresThreadRuntimeStore({
      pool: {
        query: async (sql, params) => claimant.query(sql, params ? [...params] : []),
        connect: async () => {
          throw new Error("Pinned raced-claim store does not acquire another connection.");
        },
      },
    });
    const abortStore = new PostgresThreadRuntimeStore({
      pool: {
        query: async (sql, params) => aborter.query(sql, params ? [...params] : []),
        connect: async () => {
          throw new Error("Pinned raced-abort store does not acquire another connection.");
        },
      },
    });
    const aborterPid = Number((await aborter.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
    try {
      await claimant.query("BEGIN");
      const claimed = await claimStore.tryStartRun(threadId, owner);
      expect(claimed).not.toBeNull();

      const abort = abortStore.requestRunAbort(
        threadId,
        "Reset requested from operator.",
        operationId,
        {blocksNewRuns: true},
      );
      await waitForBackendLock(pool, aborterPid);
      await claimant.query("COMMIT");

      await expect(abort).resolves.toMatchObject({
        id: claimed!.id,
        abortReason: "Reset requested from operator.",
      });
      await expect(threadStore.getRun(claimed!.id)).resolves.toMatchObject({
        abortReason: "Reset requested from operator.",
        abortRequestedAt: expect.any(Number),
      });
      await expect(threadStore.requestRunAbort(
        threadId,
        "Reset requested from operator.",
        operationId,
        {blocksNewRuns: true},
      )).resolves.toMatchObject({id: claimed!.id});
    } finally {
      await claimant.query("ROLLBACK").catch(() => {});
      claimant.release();
      aborter.release();
      const running = await threadStore.getRun(
        (await pool.query(`
          SELECT id FROM ${buildThreadRuntimeTableNames().runs}
          WHERE thread_id = $1 AND status = 'running'
          LIMIT 1
        `, [threadId])).rows[0]?.id ?? randomUUID(),
      ).catch(() => null);
      if (running) await threadStore.completeRun(running.id).catch(() => {});
    }
  });

  liveIt("never consumes a newer wake from an older PostgreSQL snapshot", async () => {
    const suffix = randomUUID();
    const sessionId = `wake-generation-session-${suffix}`;
    const threadId = `wake-generation-thread-${suffix}`;
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: threadId,
    });
    await threadStore.createThread({id: threadId, sessionId});
    await threadStore.enqueueInput(threadId, inputPayload(`initial-${suffix}`));
    const run = await threadStore.tryStartRun(threadId, owner);
    expect(run).not.toBeNull();
    await threadStore.applyPendingInputs(threadId, run!.id);

    const blocker = await pool.connect();
    const consumer = await pool.connect();
    const pinnedStore = new PostgresThreadRuntimeStore({
      pool: {
        query: async (sql, params) => consumer.query(sql, params ? [...params] : []),
        connect: async () => {
          throw new Error("Pinned wake-generation test store does not acquire another connection.");
        },
      },
    });
    const consumerPid = Number((await consumer.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
    const configTable = '"runtime"."session_runtime_config"';
    const inputTable = buildThreadRuntimeTableNames().inputs;

    try {
      // Input-less wakes are durable work too. The first boundary observes A;
      // B advances the row while holding its lock. The old snapshot must not
      // clear B after it wakes from that lock wait.
      await threadStore.requestWake(threadId);
      const beforeBoundary = await pool.query(`
        SELECT pending_wake_generation
        FROM ${configTable}
        WHERE session_id = $1
      `, [sessionId]);
      const boundaryGeneration = Number(beforeBoundary.rows[0]?.pending_wake_generation);
      await blocker.query("BEGIN");
      await blocker.query(`
        UPDATE ${configTable}
        SET pending_wake_at = COALESCE(pending_wake_at, NOW()),
            pending_wake_generation = pending_wake_generation + 1
        WHERE session_id = $1
      `, [sessionId]);
      const firstBoundary = pinnedStore.takeRunBoundary(threadId, run!.id);
      await waitForBackendLock(pool, consumerPid);
      await blocker.query("COMMIT");
      await expect(firstBoundary).resolves.toMatchObject({hadPendingWake: true});
      await expect(pool.query(`
        SELECT pending_wake_at IS NOT NULL AS pending,
               pending_wake_generation::integer AS generation
        FROM ${configTable}
        WHERE session_id = $1
      `, [sessionId])).resolves.toMatchObject({
        rows: [{pending: true, generation: boundaryGeneration + 1}],
      });
      await expect(pinnedStore.takeRunBoundary(threadId, run!.id)).resolves.toMatchObject({
        hadPendingWake: true,
      });
      await expect(pinnedStore.takeRunBoundary(threadId, run!.id)).resolves.toEqual({
        hasAdmittedInputs: false,
        hadPendingWake: false,
      });

      // Repeat at the apply fence with an input committed in B. The first
      // apply can see only A; B remains wake+armed and is applied exactly once
      // by the next fresh statement instead of causing empty provider turns.
      const visible = await threadStore.enqueueInput(
        threadId,
        inputPayload(`visible-${suffix}`),
        "queue",
      );
      await threadStore.requestWake(threadId);
      const hiddenInputId = randomUUID();
      await blocker.query("BEGIN");
      await blocker.query(`
        INSERT INTO ${inputTable} (
          id, thread_id, delivery_mode, source, connector_key, created_at, message
        ) VALUES ($1, $2, 'wake', 'test', '', NOW(), $3::jsonb)
      `, [hiddenInputId, threadId, JSON.stringify(inputPayload(`hidden-${suffix}`).message)]);
      await blocker.query(`
        UPDATE ${configTable}
        SET pending_wake_at = COALESCE(pending_wake_at, NOW()),
            pending_wake_generation = pending_wake_generation + 1
        WHERE session_id = $1
      `, [sessionId]);
      const firstApply = pinnedStore.applyPendingInputs(threadId, run!.id);
      await waitForBackendLock(pool, consumerPid);
      await blocker.query("COMMIT");
      await expect(firstApply).resolves.toEqual([
        expect.objectContaining({inputId: visible.input.id}),
      ]);
      await expect(pool.query(`
        SELECT pending_wake_at IS NOT NULL AS pending
        FROM ${configTable}
        WHERE session_id = $1
      `, [sessionId])).resolves.toMatchObject({rows: [{pending: true}]});
      await expect(pinnedStore.applyPendingInputs(threadId, run!.id)).resolves.toEqual([
        expect.objectContaining({inputId: hiddenInputId}),
      ]);
      await expect(pinnedStore.applyPendingInputs(threadId, run!.id)).resolves.toEqual([]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      consumer.release();
      await threadStore.completeRun(run!.id).catch(() => {});
    }
  });

  liveIt("fences stale runs and retains discarded idempotency tombstones across thread changes", async () => {
    const sessionInput = await threadStore.enqueueSessionInput(
      "atomic-session",
      inputPayload("session-target"),
    );
    expect(sessionInput).toMatchObject({
      disposition: "inserted",
      input: {threadId: "atomic-thread"},
    });
    const pending = await threadStore.enqueueInput("atomic-thread", inputPayload("stale-run"));
    await expect(threadStore.applyPendingInputs("atomic-thread", randomUUID())).rejects.toThrow(
      "is no longer owned by this daemon",
    );
    await expect(threadStore.getInput(pending.input.id)).resolves.toMatchObject({status: "pending"});

    const stableInputId = randomUUID();
    const queued = await threadStore.enqueueInput(
      "atomic-thread",
      inputPayload("discarded"),
      "queue",
      {inputId: stableInputId},
    );
    expect(queued.disposition).toBe("inserted");
    await expect(threadStore.discardPendingInputs("atomic-thread")).resolves.toBeGreaterThan(0);
    await expect(threadStore.getInput(stableInputId)).resolves.toMatchObject({status: "discarded"});
    await expect(threadStore.listThreadSummaries(undefined, "atomic-session")).resolves.toEqual([
      expect.objectContaining({pendingInputCount: 0}),
    ]);

    await threadStore.createThread({id: "atomic-thread-after-reset", sessionId: "atomic-session"});
    await sessionStore.updateCurrentThread({
      sessionId: "atomic-session",
      currentThreadId: "atomic-thread-after-reset",
    });
    const retry = await threadStore.enqueueSessionInput(
      "atomic-session",
      inputPayload("discarded"),
      "wake",
      {inputId: stableInputId},
    );
    expect(retry).toMatchObject({
      disposition: "duplicate_discarded",
      input: {id: stableInputId, threadId: "atomic-thread"},
    });
    await expect(threadStore.enqueueSessionInput(
      "replacement-session",
      inputPayload("cross-session-collision"),
      "wake",
      {inputId: stableInputId},
    )).rejects.toThrow("did not resolve to a durable input");
  });

  liveIt("locks thread before input and wake config during concurrent apply and duplicate enqueue", async () => {
    const suffix = randomUUID();
    const sessionId = `lock-order-session-${suffix}`;
    const threadId = `lock-order-thread-${suffix}`;
    const inputId = randomUUID();
    const blocker = await pool.connect();
    let run: Awaited<ReturnType<typeof threadStore.tryStartRun>>;
    let apply: Promise<readonly unknown[]> | undefined;
    let duplicate: ReturnType<typeof threadStore.enqueueInput> | undefined;
    try {
      await sessionStore.createSession({
        id: sessionId,
        agentKey: "panda",
        kind: "branch",
        currentThreadId: threadId,
      });
      await threadStore.createThread({id: threadId, sessionId});
      await threadStore.enqueueInput(
        threadId,
        inputPayload(`lock-order-${suffix}`),
        "queue",
        {inputId},
      );
      await expect(threadStore.wakePendingInputs(threadId)).resolves.toEqual([threadId]);
      run = await threadStore.tryStartRun(threadId, owner);
      expect(run).not.toBeNull();

      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id FROM ${buildThreadRuntimeTableNames().threads} WHERE id = $1 FOR UPDATE`,
        [threadId],
      );
      apply = threadStore.applyPendingInputs(threadId, run!.id);
      duplicate = threadStore.enqueueInput(
        threadId,
        inputPayload(`lock-order-${suffix}`),
        "wake",
        {inputId},
      );
      await waitForLockWaiters(pool, 2);

      // If either mutation skipped the thread-first protocol, one of these
      // NOWAIT probes would find an input/config row already held downstream.
      await blocker.query(`
        SELECT id FROM ${buildThreadRuntimeTableNames().inputs}
        WHERE id = $1
        FOR UPDATE NOWAIT
      `, [inputId]);
      await blocker.query(`
        SELECT session_id FROM "runtime"."session_runtime_config"
        WHERE session_id = $1
        FOR UPDATE NOWAIT
      `, [sessionId]);
      await blocker.query("COMMIT");

      const [applied, duplicateResult] = await Promise.all([apply, duplicate]);
      expect(applied).toHaveLength(1);
      expect(duplicateResult.input.id).toBe(inputId);
      await threadStore.enqueueInput(
        threadId,
        inputPayload(`global-promotion-${suffix}`),
        "queue",
      );
      await expect(threadStore.wakePendingInputs(threadId)).resolves.toContain(threadId);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await Promise.allSettled([apply, duplicate].filter((value) => value !== undefined));
      if (run) {
        await threadStore.completeRun(run.id).catch(() => {});
      }
    }
  });

  liveIt("defers session ingress across a reset fence and routes retry to the replacement", async () => {
    const suffix = randomUUID();
    const sessionId = `fenced-ingress-session-${suffix}`;
    const previousThreadId = `fenced-ingress-before-${suffix}`;
    const nextThreadId = `fenced-ingress-after-${suffix}`;
    const inputId = randomUUID();
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: previousThreadId,
    });
    await threadStore.createThread({id: previousThreadId, sessionId});
    const operationId = (await requests.enqueueRequest({
      kind: "reset_session",
      payload: {source: "operator", sessionId},
    }, {idempotencyKey: `test:fenced-ingress:${suffix}`})).id;
    await threadStore.requestRunAbort(
      previousThreadId,
      "Reset requested from operator.",
      operationId,
      {blocksNewRuns: true},
    );

    await expect(threadStore.enqueueSessionInput(
      sessionId,
      inputPayload(`fenced-ingress-${suffix}`),
      "wake",
      {inputId},
    )).rejects.toBeInstanceOf(ThreadInputAdmissionBlockedError);
    await resetSessionCurrentThread({
      pool,
      sessionStore,
      threadStore,
      previousThreadId,
      owner,
      thread: {id: nextThreadId, sessionId, replacesThreadId: previousThreadId},
      session: {sessionId, currentThreadId: nextThreadId},
    });

    await expect(threadStore.enqueueSessionInput(
      sessionId,
      inputPayload(`fenced-ingress-${suffix}`),
      "wake",
      {inputId},
    )).resolves.toMatchObject({input: {id: inputId, threadId: nextThreadId}});
    await expect(threadStore.getInput(inputId)).resolves.toMatchObject({
      status: "pending",
      threadId: nextThreadId,
    });
  });

  liveIt("serializes reset and session-targeted enqueue without a lock-order deadlock", async () => {
    const suffix = randomUUID();
    const sessionId = `atomic-reset-session-${suffix}`;
    const previousThreadId = `atomic-reset-before-${suffix}`;
    const nextThreadId = `atomic-reset-after-${suffix}`;
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: previousThreadId,
    });
    await threadStore.createThread({id: previousThreadId, sessionId});
    await threadStore.requestWake(previousThreadId);
    const blocker = await pool.connect();
    const originalAssertExclusive = threadStore.assertExclusiveAccessAfterOwnerLockRecord.bind(threadStore);
    let signalAssertEntered!: () => void;
    const assertEntered = new Promise<void>((resolve) => { signalAssertEntered = resolve; });
    let releaseAssert!: () => void;
    const assertRelease = new Promise<void>((resolve) => { releaseAssert = resolve; });
    threadStore.assertExclusiveAccessAfterOwnerLockRecord = async (...args) => {
      signalAssertEntered();
      await assertRelease;
      return originalAssertExclusive(...args);
    };
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id FROM ${buildThreadRuntimeTableNames().threads} WHERE id = $1 FOR UPDATE`,
        [previousThreadId],
      );

      const reset = resetSessionCurrentThread({
        pool,
        sessionStore,
        threadStore,
        previousThreadId,
        owner,
        thread: {
          id: nextThreadId,
          sessionId,
          replacesThreadId: previousThreadId,
        },
        session: {sessionId, currentThreadId: nextThreadId},
      });
      // This hook is reached only after reset owns the session row. It makes
      // the lock ordering deterministic instead of relying on scheduler time.
      await assertEntered;
      const enqueue = threadStore.enqueueSessionInput(
        sessionId,
        inputPayload("reset-race"),
        "queue",
      );
      const staleWake = threadStore.requestWake(previousThreadId)
        .then(() => null, (error: unknown) => error);
      const staleEnqueue = threadStore.enqueueInput(
        previousThreadId,
        inputPayload("stale-reset-race"),
      ).then(() => null, (error: unknown) => error);
      await waitForLockWaiters(pool, 3);
      releaseAssert();
      await blocker.query("COMMIT");

      const [resetThread, enqueued] = await Promise.all([reset, enqueue]);
      expect(resetThread.id).toBe(nextThreadId);
      expect(enqueued.input.threadId).toBe(nextThreadId);
      expect(await staleWake).toMatchObject({message: `Unknown thread ${previousThreadId}`});
      expect(await staleEnqueue).toMatchObject({message: `Unknown thread ${previousThreadId}.`});
      await expect(threadStore.hasPendingWake(nextThreadId)).resolves.toBe(false);
      await expect(threadStore.isThreadRunnable(nextThreadId)).resolves.toBe(false);
    } finally {
      releaseAssert();
      threadStore.assertExclusiveAccessAfterOwnerLockRecord = originalAssertExclusive;
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
  });

  liveIt("locks daemon owner before reset session so queued renewal cannot deadlock a claim", async () => {
    const suffix = randomUUID();
    const sessionId = `lease-order-session-${suffix}`;
    const previousThreadId = `lease-order-before-${suffix}`;
    const nextThreadId = `lease-order-after-${suffix}`;
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: previousThreadId,
    });
    await threadStore.createThread({id: previousThreadId, sessionId});
    await threadStore.enqueueInput(previousThreadId, inputPayload(`lease-order-${suffix}`));

    const originalAssertExclusive = threadStore.assertExclusiveAccessAfterOwnerLockRecord.bind(threadStore);
    let signalSessionLocked!: () => void;
    const sessionLocked = new Promise<void>((resolve) => { signalSessionLocked = resolve; });
    let releaseReset!: () => void;
    const resetRelease = new Promise<void>((resolve) => { releaseReset = resolve; });
    threadStore.assertExclusiveAccessAfterOwnerLockRecord = async (...args) => {
      signalSessionLocked();
      await resetRelease;
      return originalAssertExclusive(...args);
    };

    let reset: ReturnType<typeof resetSessionCurrentThread> | undefined;
    let claim: ReturnType<typeof threadStore.tryStartRun> | undefined;
    let renewal: ReturnType<typeof connectorLeases.renew> | undefined;
    try {
      reset = resetSessionCurrentThread({
        pool,
        sessionStore,
        threadStore,
        previousThreadId,
        owner,
        thread: {
          id: nextThreadId,
          sessionId,
          replacesThreadId: previousThreadId,
        },
        session: {sessionId, currentThreadId: nextThreadId},
      });
      await sessionLocked;

      claim = threadStore.tryStartRun(previousThreadId, owner);
      await waitForLockWaiters(pool, 1);
      renewal = connectorLeases.renew({...owner, ttlMs: 120_000});
      await waitForLockWaiters(pool, 2);

      releaseReset();
      const [replacement, claimed, renewed] = await Promise.all([reset, claim, renewal]);
      expect(replacement.id).toBe(nextThreadId);
      expect(claimed).toBeNull();
      expect(renewed).toMatchObject(owner);
    } finally {
      releaseReset();
      threadStore.assertExclusiveAccessAfterOwnerLockRecord = originalAssertExclusive;
      await Promise.allSettled([reset, claim, renewal].filter((value) => value !== undefined));
    }
  });

  liveIt("claims requests once under concurrency and fences settlement by claim token", async () => {
    const key = `atomic-request:${randomUUID()}`;
    const externalMessageId = randomUUID();
    const enqueued = await Promise.all(Array.from({length: 20}, () => requests.enqueueRequest({
      kind: "tui_input",
      payload: {
        actorId: "operator",
        externalMessageId,
        text: "hello",
      },
    }, {idempotencyKey: key})));
    expect(new Set(enqueued.map((request) => request.id))).toHaveLength(1);
    await expect(requests.enqueueRequest({
      kind: "tui_input",
      payload: {
        actorId: "operator",
        externalMessageId,
        text: "different payload",
      },
    }, {idempotencyKey: key})).rejects.toThrow("already bound to a different request");

    const claims = await Promise.all(Array.from({length: 10}, () => requests.claimNextPendingRequest()));
    const claimed = claims.filter((request) => request?.id === enqueued[0]!.id);
    expect(claimed).toHaveLength(1);
    const request = claimed[0]!;
    expect(enqueued[0]!.executionAttempts).toBe(0);
    expect(request.executionAttempts).toBe(1);
    await expect(requests.completeRequest(request.id, randomUUID(), {wrong: true})).rejects.toThrow("claim was lost");
    await expect(requests.renewRequestClaim(request.id, request.claimToken!)).resolves.toBe(true);
    await expect(requests.completeRequest(request.id, request.claimToken!, {ok: true})).resolves.toMatchObject({
      status: "completed",
      result: {ok: true},
    });

    const expired = await requests.enqueueRequest({
      kind: "tui_input",
      payload: {actorId: "operator", externalMessageId: randomUUID(), text: "expire"},
    });
    const originalClaim = await requests.claimNextPendingRequest();
    expect(originalClaim?.id).toBe(expired.id);
    const requestTables = buildRuntimeRequestTableNames();
    await pool.query(`
      UPDATE ${requestTables.runtimeRequests}
      SET claim_expires_at = NOW() - INTERVAL '1 second'
      WHERE id = $1
    `, [expired.id]);
    const reclaimed = await requests.claimNextPendingRequest();
    expect(reclaimed).toMatchObject({id: expired.id, status: "running"});
    expect(reclaimed!.executionAttempts).toBe(2);
    expect(reclaimed!.claimToken).not.toBe(originalClaim!.claimToken);
    await expect(requests.completeRequest(expired.id, originalClaim!.claimToken!, {stale: true})).rejects.toThrow(
      "claim was lost",
    );
    await expect(requests.completeRequest(expired.id, reclaimed!.claimToken!, {reclaimed: true})).resolves.toMatchObject({
      status: "completed",
      result: {reclaimed: true},
    });

    const renewable = await requests.enqueueRequest({
      kind: "tui_input",
      payload: {actorId: "operator", externalMessageId: randomUUID(), text: "renew"},
    });
    const renewableClaim = await requests.claimNextPendingRequest();
    expect(renewableClaim?.id).toBe(renewable.id);
    await expect(requests.renewRequestClaim(renewable.id, renewableClaim!.claimToken!)).resolves.toBe(true);
    await expect(requests.claimNextPendingRequest()).resolves.toBeNull();
    await requests.completeRequest(renewable.id, renewableClaim!.claimToken!, {renewed: true});
  });

  liveIt("does not let a stale update request overwrite a later session config", async () => {
    const first = await requests.enqueueRequest({
      kind: "update_thread",
      payload: {
        threadId: "atomic-thread",
        update: {model: "openai/gpt-5.1"},
      },
    });
    const second = await requests.enqueueRequest({
      kind: "update_thread",
      payload: {
        threadId: "atomic-thread",
        update: {model: "openai/gpt-5.2"},
      },
    });

    await expect(sessionStore.updateSessionRuntimeConfigOnce(first.id, "atomic-thread", {
      sessionId: "atomic-session",
      model: "openai/gpt-5.1",
    })).resolves.toMatchObject({replayed: false});
    await expect(sessionStore.updateSessionRuntimeConfigOnce(second.id, "atomic-thread", {
      sessionId: "atomic-session",
      model: "openai/gpt-5.2",
    })).resolves.toMatchObject({replayed: false});
    await expect(sessionStore.updateSessionRuntimeConfigOnce(first.id, "atomic-thread", {
      sessionId: "atomic-session",
      model: "openai/gpt-5.1",
    })).resolves.toMatchObject({
      replayed: true,
      config: {model: "openai/gpt-5.2"},
    });
    await expect(sessionStore.getSessionRuntimeConfig("atomic-session"))
      .resolves.toMatchObject({model: "openai/gpt-5.2"});
    await pool.query(`
      UPDATE ${buildRuntimeRequestTableNames().runtimeRequests}
      SET status = 'completed', finished_at = NOW()
      WHERE id = ANY($1::uuid[])
    `, [[first.id, second.id]]);
  });

  liveIt("orders reset and update settings by request acceptance across ordering keys", async () => {
    const suffix = randomUUID();
    const sessionId = `config-order-session-${suffix}`;
    const previousThreadId = `config-order-before-${suffix}`;
    const nextThreadId = `config-order-after-${suffix}`;
    await sessionStore.createSession({
      id: sessionId,
      agentKey: "panda",
      kind: "branch",
      currentThreadId: previousThreadId,
    });
    await threadStore.createThread({id: previousThreadId, sessionId});
    const resetRequest = await requests.enqueueRequest({
      kind: "reset_session",
      payload: {source: "operator", sessionId, model: "openai/gpt-5.1"},
    });
    const updateRequest = await requests.enqueueRequest({
      kind: "update_thread",
      payload: {threadId: previousThreadId, update: {thinking: "high"}},
    });
    const requestTable = buildRuntimeRequestTableNames().runtimeRequests;
    await pool.query(`
      UPDATE ${requestTable}
      SET created_at = CASE id
        WHEN $1 THEN NOW() + INTERVAL '1 second'
        WHEN $2 THEN NOW() + INTERVAL '2 seconds'
      END
      WHERE id = ANY($3::uuid[])
    `, [resetRequest.id, updateRequest.id, [resetRequest.id, updateRequest.id]]);
    await threadStore.requestWake(previousThreadId);

    await sessionStore.updateSessionRuntimeConfigOnce(updateRequest.id, previousThreadId, {
      sessionId,
      thinking: "high",
    });
    await resetSessionCurrentThread({
      pool,
      sessionStore,
      threadStore,
      previousThreadId,
      owner,
      thread: {id: nextThreadId, sessionId, replacesThreadId: previousThreadId},
      session: {sessionId, currentThreadId: nextThreadId},
      runtimeConfig: {model: "openai/gpt-5.1"},
      runtimeConfigOperationId: resetRequest.id,
    });

    await expect(sessionStore.getSessionRuntimeConfig(sessionId))
      .resolves.toMatchObject({model: "openai/gpt-5.1", thinking: "high"});
    await pool.query(`
      UPDATE ${requestTable}
      SET status = 'completed', finished_at = NOW()
      WHERE id = ANY($1::uuid[])
    `, [[resetRequest.id, updateRequest.id]]);
  });

  liveIt("runs independent request streams concurrently while preserving FIFO within a stream", async () => {
    const first = await requests.enqueueRequest({
      kind: "tui_input",
      payload: {threadId: "stream-a", actorId: "operator", externalMessageId: randomUUID(), text: "a1"},
    });
    const second = await requests.enqueueRequest({
      kind: "tui_input",
      payload: {threadId: "stream-a", actorId: "operator", externalMessageId: randomUUID(), text: "a2"},
    });
    const independent = await requests.enqueueRequest({
      kind: "tui_input",
      payload: {threadId: "stream-b", actorId: "operator", externalMessageId: randomUUID(), text: "b1"},
    });
    expect(first.orderingKey).toBe(second.orderingKey);
    expect(independent.orderingKey).not.toBe(first.orderingKey);

    const tables = buildRuntimeRequestTableNames();
    await pool.query(`
      UPDATE ${tables.runtimeRequests}
      SET created_at = CASE id
        WHEN $1 THEN TIMESTAMPTZ '2026-01-01 00:00:01+00'
        WHEN $2 THEN TIMESTAMPTZ '2026-01-01 00:00:02+00'
        WHEN $3 THEN TIMESTAMPTZ '2026-01-01 00:00:03+00'
      END
      WHERE id = ANY($4::uuid[])
    `, [first.id, second.id, independent.id, [first.id, second.id, independent.id]]);

    const concurrentClaims = await Promise.all(Array.from({length: 4}, () => {
      return requests.claimNextPendingRequest();
    }));
    const firstClaim = concurrentClaims.find((claim) => claim?.id === first.id);
    const independentClaim = concurrentClaims.find((claim) => claim?.id === independent.id);
    expect(firstClaim?.id).toBe(first.id);
    expect(independentClaim?.id).toBe(independent.id);
    expect(concurrentClaims.filter(Boolean)).toHaveLength(2);

    await requests.completeRequest(first.id, firstClaim!.claimToken!, {ok: true});
    const secondClaim = await requests.claimNextPendingRequest();
    expect(secondClaim?.id).toBe(second.id);
    await requests.completeRequest(second.id, secondClaim!.claimToken!, {ok: true});
    await requests.completeRequest(independent.id, independentClaim!.claimToken!, {ok: true});
  });

  liveIt("prunes settled requests in bounded retention batches without touching live work", async () => {
    const requestTables = buildRuntimeRequestTableNames();
    const settled = await Promise.all(["old-complete", "old-failed", "recent-complete", "pending"].map((text) => {
      return requests.enqueueRequest({
        kind: "tui_input",
        payload: {actorId: "operator", externalMessageId: randomUUID(), text},
      });
    }));
    await pool.query(`
      UPDATE ${requestTables.runtimeRequests}
      SET status = 'completed', finished_at = NOW() - INTERVAL '40 days'
      WHERE id = $1
    `, [settled[0]!.id]);
    await pool.query(`
      UPDATE ${requestTables.runtimeRequests}
      SET status = 'failed', error = 'old failure', finished_at = NOW() - INTERVAL '40 days'
      WHERE id = $1
    `, [settled[1]!.id]);
    await pool.query(`
      UPDATE ${requestTables.runtimeRequests}
      SET status = 'completed', finished_at = NOW()
      WHERE id = $1
    `, [settled[2]!.id]);
    await sessionStore.updateSessionRuntimeConfigOnce(settled[0]!.id, "atomic-thread", {
      sessionId: "atomic-session",
      thinking: "medium",
    });
    await sessionStore.recordSessionCreationOperation({
      operationId: settled[1]!.id,
      identityId: "retained-request-identity",
      agentKey: "panda",
      sessionId: "atomic-session",
      threadId: "atomic-thread",
      kind: "main",
    });

    await expect(requests.pruneSettledRequests({
      completedBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000),
      failedBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000),
      limit: 1,
    })).resolves.toBe(1);
    await expect(requests.pruneSettledRequests({
      completedBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000),
      failedBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000),
      limit: 10,
    })).resolves.toBe(1);

    const remaining = await pool.query(`
      SELECT id, status
      FROM ${requestTables.runtimeRequests}
      WHERE id = ANY($1::uuid[])
    `, [settled.map((request) => request.id)]);
    expect(remaining.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({id: settled[2]!.id, status: "completed"}),
      expect.objectContaining({id: settled[3]!.id, status: "pending"}),
    ]));
    expect(remaining.rows).toHaveLength(2);
    const receipts = await pool.query(`
      SELECT operation_id FROM "runtime"."session_runtime_config_operations"
      WHERE operation_id = ANY($1::uuid[])
      UNION ALL
      SELECT operation_id FROM "runtime"."session_creation_operations"
      WHERE operation_id = ANY($1::uuid[])
    `, [[settled[0]!.id, settled[1]!.id]]);
    expect(receipts.rows).toHaveLength(0);
  });
});
