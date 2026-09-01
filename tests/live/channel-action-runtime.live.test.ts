import {randomUUID} from "node:crypto";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {PANDA_SCHEMA_MIGRATIONS} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresChannelActionStore} from "../../src/domain/channels/actions/postgres.js";
import {ChannelActionWorker} from "../../src/domain/channels/actions/worker.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {startConnectorDaemonRuntime} from "../../src/integrations/channels/worker-runtime.js";
import {createPostgresMigrator} from "../../src/lib/postgres-migrations.js";
import {waitFor} from "../helpers/wait-for.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;
const channelActionExpiryMigrationIndex = PANDA_SCHEMA_MIGRATIONS.findIndex(
  ({id}) => id === "0017_channel_action_expiry",
);
if (channelActionExpiryMigrationIndex < 0) {
  throw new Error("Channel-action expiry migration is missing from the catalog.");
}

describe.sequential("channel-action runtime with PostgreSQL", () => {
  let producerPool: ReturnType<typeof createPostgresPool>;
  const historicalTypingId = randomUUID();
  const historicalReactionId = randomUUID();

  const migrator = (count: number) => createPostgresMigrator({
    pool: producerPool,
    migrations: PANDA_SCHEMA_MIGRATIONS.slice(0, count),
    schemaName: "runtime",
    tableName: "schema_migrations",
    lockName: "panda:channel-action-runtime-live-test",
  });

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    producerPool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/channel-action-runtime-live-producer",
      max: 2,
    });
    await migrator(channelActionExpiryMigrationIndex).migrate();
    await producerPool.query(`
      INSERT INTO "runtime"."channel_actions" (
        id, channel, connector_key, kind, payload, status
      ) VALUES
        ($1, 'telegram', 'bot-one', 'typing', $3::jsonb, 'pending'),
        ($2, 'telegram', 'bot-one', 'telegram_reaction', $4::jsonb, 'pending')
    `, [
      historicalTypingId,
      historicalReactionId,
      JSON.stringify({
        channel: "telegram",
        target: {
          source: "telegram",
          connectorKey: "bot-one",
          externalConversationId: "historical-chat",
        },
        phase: "start",
      }),
      JSON.stringify({
        conversationId: "historical-chat",
        messageId: "historical-message",
        emoji: "👍",
      }),
    ]);
    await migrator(PANDA_SCHEMA_MIGRATIONS.length).migrate();
  });

  liveIt("terminalizes historical typing while preserving durable pending actions", async () => {
    await expect(producerPool.query(`
      SELECT id, status, attempt_count, last_error, completed_at IS NOT NULL AS completed
      FROM "runtime"."channel_actions"
      WHERE id = ANY($1::uuid[])
      ORDER BY id
    `, [[historicalTypingId, historicalReactionId]])).resolves.toMatchObject({
      rows: expect.arrayContaining([
        {
          id: historicalTypingId,
          status: "expired",
          attempt_count: 0,
          last_error: "Action expired before dispatch.",
          completed: true,
        },
        {
          id: historicalReactionId,
          status: "pending",
          attempt_count: 0,
          last_error: null,
          completed: false,
        },
      ]),
    });
  });

  liveIt("continues past an archived-session action to later valid work", async () => {
    const agents = new PostgresAgentStore({pool: producerPool});
    const sessions = new PostgresSessionStore({pool: producerPool});
    const threads = new PostgresThreadRuntimeStore({pool: producerPool});
    const actions = new PostgresChannelActionStore({pool: producerPool});
    await agents.bootstrapAgent({agentKey: "channel-action-test", displayName: "Channel Action Test"});
    await sessions.createSession({
      id: "archived-action-session",
      agentKey: "channel-action-test",
      kind: "branch",
      currentThreadId: "archived-action-thread",
    });
    await threads.createThread({
      id: "archived-action-thread",
      sessionId: "archived-action-session",
    });
    const archived = await actions.enqueueAction({
      sessionId: "archived-action-session",
      threadId: "archived-action-thread",
      channel: "telegram",
      connectorKey: "bot-archive",
      kind: "telegram_reaction",
      payload: {conversationId: "archived-chat", messageId: "archived-message", emoji: "👍"},
    });
    await producerPool.query(`
      UPDATE "runtime"."agent_sessions"
      SET archived_at = NOW()
      WHERE id = 'archived-action-session'
    `);
    const valid = await actions.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-archive",
      kind: "telegram_reaction",
      payload: {conversationId: "valid-chat", messageId: "valid-message", emoji: "✅"},
    });

    await expect(actions.claimNextPendingAction({
      channel: "telegram",
      connectorKey: "bot-archive",
    })).resolves.toMatchObject({id: valid.id, status: "sending"});
    await expect(producerPool.query(`
      SELECT status, last_error
      FROM "runtime"."channel_actions"
      WHERE id = $1
    `, [archived.id])).resolves.toMatchObject({
      rows: [{status: "failed", last_error: "Session archived."}],
    });
    await actions.markActionSent(valid.id);
  });

  liveIt("allows only one concurrent claimer to take a pending action", async () => {
    const firstStore = new PostgresChannelActionStore({pool: producerPool});
    const secondStore = new PostgresChannelActionStore({pool: producerPool});
    const action = await firstStore.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-concurrent",
      kind: "telegram_reaction",
      payload: {conversationId: "concurrent-chat", messageId: "concurrent-message", emoji: "1️⃣"},
    });

    const claims = await Promise.all([
      firstStore.claimNextPendingAction({channel: "telegram", connectorKey: "bot-concurrent"}),
      secondStore.claimNextPendingAction({channel: "telegram", connectorKey: "bot-concurrent"}),
    ]);
    expect(claims.filter((claim) => claim?.id === action.id)).toHaveLength(1);
    await firstStore.markActionSent(action.id);
  });

  liveIt("routes real notifications to the matching account and resumes after LISTEN reconnect", async () => {
    const runtime = await startConnectorDaemonRuntime({
      source: "telegram",
      dbUrl: databaseUrl,
      poolMaxEnvKey: "PANDA_CHANNEL_ACTION_LIVE_TEST_POOL_MAX",
      reconnectDelayMs: 100,
      log: () => {},
    });
    const store = new PostgresChannelActionStore({pool: runtime.pool});
    const producer = new PostgresChannelActionStore({pool: producerPool});
    const dispatched: string[] = [];
    const createWorker = (connectorKey: string) => new ChannelActionWorker({
      store,
      lookup: {channel: "telegram", connectorKey},
      dispatch: async (action) => {
        dispatched.push(`${connectorKey}:${action.id}`);
      },
    });
    const first = createWorker("bot-one");
    const second = createWorker("bot-two");
    const pollingDispatched: string[] = [];
    const pollingWorker = new ChannelActionWorker({
      store,
      lookup: {channel: "telegram", connectorKey: "bot-poll"},
      dispatch: async (action) => {
        pollingDispatched.push(action.id);
      },
      pollIntervalMs: 20,
    });
    const expiredDispatched: string[] = [];
    const expiredWorker = new ChannelActionWorker({
      store,
      lookup: {channel: "telegram", connectorKey: "bot-expired"},
      dispatch: async (action) => {
        expiredDispatched.push(action.id);
      },
      pollIntervalMs: 20,
    });
    const idleTarget = {triggerDrain: async () => {}};
    let firstRegistration: ReturnType<typeof runtime.notifications.register> | undefined;
    let secondRegistration: ReturnType<typeof runtime.notifications.register> | undefined;

    try {
      await first.start({subscribeToNotifications: false});
      await second.start({subscribeToNotifications: false});
      await pollingWorker.start({subscribeToNotifications: false});
      await pollingWorker.triggerDrain("startup");
      firstRegistration = runtime.notifications.register({
        connectorKey: "bot-one",
        actionWorker: first,
        outboundWorker: idleTarget,
      });
      secondRegistration = runtime.notifications.register({
        connectorKey: "bot-two",
        actionWorker: second,
        outboundWorker: idleTarget,
      });

      const firstAction = await producer.enqueueAction({
        channel: "telegram",
        connectorKey: "bot-one",
        kind: "telegram_reaction",
        payload: {conversationId: "chat-one", messageId: "message-one", emoji: "👍"},
      });
      const secondAction = await producer.enqueueAction({
        channel: "telegram",
        connectorKey: "bot-two",
        kind: "telegram_reaction",
        payload: {conversationId: "chat-two", messageId: "message-two", emoji: "👍"},
      });

      await waitFor(() => {
        expect(dispatched).toEqual(expect.arrayContaining([
          `bot-one:${firstAction.id}`,
          `bot-two:${secondAction.id}`,
        ]));
      });

      const missedNotification = await producer.enqueueAction({
        channel: "telegram",
        connectorKey: "bot-poll",
        kind: "telegram_reaction",
        payload: {conversationId: "chat-poll", messageId: "message-poll", emoji: "🔁"},
      });
      await waitFor(() => {
        expect(pollingDispatched).toEqual([missedNotification.id]);
      });

      const expiresBeforeRestart = await producer.enqueueAction({
        channel: "telegram",
        connectorKey: "bot-expired",
        kind: "typing",
        payload: {
          channel: "telegram",
          target: {
            source: "telegram",
            connectorKey: "bot-expired",
            externalConversationId: "chat-expired",
          },
          phase: "start",
        },
        expiresAt: Date.now() + 30,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expiredWorker.start({subscribeToNotifications: false});
      await expiredWorker.triggerDrain("startup");
      expect(expiredDispatched).toEqual([]);
      await expect(producerPool.query(`
        SELECT status, attempt_count
        FROM "runtime"."channel_actions"
        WHERE id = $1
      `, [expiresBeforeRestart.id])).resolves.toMatchObject({
        rows: [{status: "expired", attempt_count: 0}],
      });

      const listener = await producerPool.query(`
        SELECT pid
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = 'panda/telegram'
          AND query LIKE 'LISTEN %'
        LIMIT 1
      `);
      const listenerPid = listener.rows[0]?.pid;
      expect(typeof listenerPid).toBe("number");
      await producerPool.query("SELECT pg_terminate_backend($1)", [listenerPid]);
      await waitFor(() => {
        expect(runtime.getNotificationSnapshot()).toMatchObject({
          status: "reconnecting",
          listening: false,
          lastErrorAt: expect.any(Number),
        });
      });
      const duringReconnect = await producer.enqueueAction({
        channel: "telegram",
        connectorKey: "bot-one",
        kind: "telegram_reaction",
        payload: {conversationId: "chat-one", messageId: "message-three", emoji: "✅"},
      });
      await waitFor(() => {
        expect(runtime.getNotificationSnapshot()).toMatchObject({
          status: "listening",
          listening: true,
          lastErrorAt: expect.any(Number),
        });
      });
      await waitFor(() => {
        expect(dispatched).toContain(`bot-one:${duringReconnect.id}`);
      });
    } finally {
      firstRegistration?.unregister();
      secondRegistration?.unregister();
      await first.stop();
      await second.stop();
      await pollingWorker.stop();
      await expiredWorker.stop();
      await runtime.close();
    }
  });

  afterAll(async () => {
    await producerPool?.end();
  });
});
