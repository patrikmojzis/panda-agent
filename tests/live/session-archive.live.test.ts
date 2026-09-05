import {randomUUID} from "node:crypto";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresChannelActionStore} from "../../src/domain/channels/actions/postgres.js";
import {PostgresOutboundDeliveryStore} from "../../src/domain/channels/deliveries/postgres.js";
import {PostgresScheduledTaskStore} from "../../src/domain/scheduling/tasks/postgres.js";
import {PostgresSessionArchive} from "../../src/domain/sessions/archive.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {SessionArchivedError} from "../../src/domain/threads/runtime/store.js";
import {PostgresWatchStore} from "../../src/domain/watches/postgres.js";
import {stringToUserMessage} from "../../src/kernel/agent/helpers/input.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

describe("session archive lifecycle with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/session-archive-live-test",
      max: 4,
    });
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
  });

  afterAll(async () => {
    await pool?.end();
  });

  liveIt("archives one branch atomically and restores clocks without replay", async () => {
    const agents = new PostgresAgentStore({pool});
    const sessions = new PostgresSessionStore({pool});
    const threads = new PostgresThreadRuntimeStore({pool});
    const tasks = new PostgresScheduledTaskStore({pool});
    const watches = new PostgresWatchStore({pool});
    const deliveries = new PostgresOutboundDeliveryStore({pool});
    const actions = new PostgresChannelActionStore({pool});
    const lifecycle = new PostgresSessionArchive({pool, sessions, threads});
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await sessions.createSession({
      id: "archive-branch",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "archive-thread",
    });
    await sessions.updateHeartbeatConfig({
      sessionId: "archive-branch",
      enabled: true,
      everyMinutes: 5,
      asOf: Date.parse("2099-08-25T00:00:00.000Z"),
    });
    const once = await tasks.createTask({
      sessionId: "archive-branch",
      title: "Missed once",
      instruction: "Do not replay this after restore.",
      schedule: {kind: "once", runAt: "2099-08-26T00:00:00.000Z"},
    });
    const recurring = await tasks.createTask({
      sessionId: "archive-branch",
      title: "Future recurring",
      instruction: "Resume at the next future occurrence.",
      schedule: {kind: "recurring", cron: "0 * * * *", timezone: "UTC"},
    });
    const pendingTaskRunId = randomUUID();
    await pool.query(`
      INSERT INTO "runtime"."scheduled_task_runs" (
        id, task_id, session_id, scheduled_for, status
      ) VALUES ($1, $2, 'archive-branch', '2099-08-26T00:00:00.000Z', 'pending')
    `, [pendingTaskRunId, once.id]);
    const watch = await watches.createWatch({
      sessionId: "archive-branch",
      title: "Archived watch",
      intervalMinutes: 5,
      source: {
        kind: "http_json",
        url: "https://example.test/status",
        result: {observation: "scalar", valuePath: "value"},
      },
      detector: {kind: "percent_change", percent: 10},
    });
    const watchClaim = await watches.claimWatch({
      watchId: watch.id,
      claimedBy: "watch-runner",
      claimExpiresAt: Date.now() + 60_000,
      nextPollAt: Date.now() + 300_000,
    });
    expect(watchClaim).not.toBeNull();
    const pendingDelivery = await deliveries.enqueueDelivery({
      sessionId: "archive-branch",
      threadId: "archive-thread",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{type: "text", text: "pending delivery"}],
    });
    const pendingAction = await actions.enqueueAction({
      sessionId: "archive-branch",
      threadId: "archive-thread",
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
    const pendingInput = await threads.enqueueSessionInput("archive-branch", {
      source: "test",
      externalMessageId: "pending-before-archive",
      message: stringToUserMessage("discard me"),
    });
    const owner = {source: "daemon", connectorKey: "primary", holderId: randomUUID()};
    await pool.query(`
      INSERT INTO "runtime"."connector_leases" (
        source, connector_key, holder_id, leased_until
      ) VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
    `, [owner.source, owner.connectorKey, owner.holderId]);
    await pool.query(`
      UPDATE "runtime"."threads"
      SET run_claims_blocked_at = NOW()
      WHERE id = 'archive-thread'
    `);

    const archived = await lifecycle.archive({
      sessionId: "archive-branch",
      expectedThreadId: "archive-thread",
      owner,
    });
    expect(archived).toMatchObject({
      discardedInputs: 1,
      cancelledTaskRuns: 1,
      failedWatchRuns: 1,
      failedDeliveries: 1,
      failedActions: 1,
      session: {id: "archive-branch", archivedAt: expect.any(Number)},
    });
    await expect(threads.getInput(pendingInput.input.id)).resolves.toMatchObject({status: "discarded"});
    await expect(tasks.listTaskRuns({taskId: once.id, sessionId: "archive-branch"}))
      .resolves.toMatchObject([{id: pendingTaskRunId, status: "cancelled"}]);
    await expect(watches.getLatestWatchRun(watch.id)).resolves.toMatchObject({status: "failed"});
    await expect(deliveries.getDelivery(pendingDelivery.id)).resolves.toMatchObject({status: "failed"});
    await expect(pool.query(
      `SELECT status FROM "runtime"."channel_actions" WHERE id = $1`,
      [pendingAction.id],
    )).resolves.toMatchObject({rows: [{status: "failed"}]});
    await expect(threads.enqueueSessionInput("archive-branch", {
      source: "test",
      message: stringToUserMessage("blocked"),
    })).rejects.toBeInstanceOf(SessionArchivedError);

    const restoredAt = Date.parse("2100-08-27T00:00:00.000Z");
    const restored = await lifecycle.restore({
      sessionId: "archive-branch",
      expectedThreadId: "archive-thread",
      owner,
      restoredAt,
    });
    expect(restored.archivedAt).toBeUndefined();
    await expect(pool.query(`
      SELECT run_claims_blocked_at
      FROM "runtime"."threads"
      WHERE id = 'archive-thread'
    `)).resolves.toMatchObject({rows: [{run_claims_blocked_at: null}]});
    await expect(tasks.getTask(once.id)).resolves.toMatchObject({
      cancelledAt: expect.any(Number),
      nextFireAt: undefined,
    });
    const restoredRecurring = await tasks.getTask(recurring.id);
    expect(restoredRecurring.nextFireAt).toBeGreaterThan(restoredAt);
    await expect(watches.getWatch(watch.id)).resolves.toMatchObject({
      nextPollAt: restoredAt + 5 * 60_000,
      claimedAt: undefined,
    });
    await expect(sessions.getHeartbeat("archive-branch")).resolves.toMatchObject({
      nextFireAt: restoredAt + 5 * 60_000,
      claimedAt: undefined,
    });
    await expect(threads.enqueueSessionInput("archive-branch", {
      source: "test",
      externalMessageId: "accepted-after-restore",
      message: stringToUserMessage("accepted"),
    })).resolves.toMatchObject({disposition: "inserted"});
    await expect(deliveries.getDelivery(pendingDelivery.id)).resolves.toMatchObject({status: "failed"});
  });
});
