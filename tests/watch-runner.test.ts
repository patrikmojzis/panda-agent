import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";
import {DataType, newDb} from "pg-mem";

import {Agent} from "../src/index.js";
import {ThreadRuntimeCoordinator} from "../src/domain/threads/runtime/index.js";
import {
    PostgresWatchStore,
    type WatchEvaluationResult,
    type WatchEvaluator,
    WatchRunner,
} from "../src/domain/watches/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

function createAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{type: "text", text}],
    api: "openai-responses",
    model: "openai/gpt-5.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createMockRuntime(...responses: AssistantMessage[]) {
  return {
    complete: vi.fn().mockImplementation(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("No more runtime responses queued.");
      }

      return response;
    }),
    stream: vi.fn(() => {
      throw new Error("Streaming was not expected in this test.");
    }),
  };
}

class LeaseManager {
  async tryAcquire(threadId: string) {
    return {
      threadId,
      release: async () => {},
    };
  }
}

async function createHarness(evaluateWatch: WatchEvaluator) {
  const db = newDb();
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();

  const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);
  const watchStore = new PostgresWatchStore({pool});
  await watchStore.ensureSchema();

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

  const runtime = createMockRuntime(
    createAssistantMessage("Handled watch event."),
    createAssistantMessage("Handled watch event."),
    createAssistantMessage("Handled watch event."),
    createAssistantMessage("Handled watch event."),
  );
  const coordinator = new ThreadRuntimeCoordinator({
    store: threadStore,
    leaseManager: new LeaseManager(),
    resolveDefinition: async () => ({
      agent: new Agent({
        name: "panda",
        instructions: "Reply briefly.",
      }),
      runtime,
    }),
  });

  const watchRunner = new WatchRunner({
    watches: watchStore,
    sessions: sessionStore,
    coordinator,
    evaluateWatch,
  });

  return {
    alice,
    pool,
    runtime,
    threadStore,
    sessionStore,
    watchStore,
    coordinator,
    watchRunner,
  };
}

async function forceWatchDue(pool: {query(text: string, values?: unknown[]): Promise<unknown>}, watchId: string): Promise<void> {
  await pool.query(
    `UPDATE "thread_runtime_watches" SET next_poll_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
    [watchId],
  );
}

describe("WatchRunner", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("wakes Panda for a Mongo-style new registration event after bootstrap", async () => {
    const evaluateWatch = vi.fn<WatchEvaluator>()
      .mockResolvedValueOnce({
        changed: false,
        nextState: {
          kind: "new_items",
          identityToken: "mongo-stream",
          bootstrapped: true,
          lastCursor: "2026-04-11T10:00:00.000Z",
          lastIds: ["reg-1"],
        },
      } satisfies WatchEvaluationResult)
      .mockResolvedValueOnce({
        changed: true,
        nextState: {
          kind: "new_items",
          identityToken: "mongo-stream",
          bootstrapped: true,
          lastCursor: "2026-04-11T10:05:00.000Z",
          lastIds: ["reg-2"],
        },
        event: {
          eventKind: "new_items",
          summary: "Detected 1 new item.",
          dedupeKey: "reg-2",
          payload: {
            totalNewItems: 1,
          },
        },
      });
    const harness = await createHarness(evaluateWatch);
    pools.push(harness.pool);

    const watch = await harness.watchStore.createWatch({
      sessionId: "session-main",
      createdByIdentityId: harness.alice.id,
      title: "Registrations",
      intervalMinutes: 5,
      source: {
        kind: "mongodb_query",
        credentialEnvKey: "MONGO_URI",
        database: "app",
        collection: "registrations",
        operation: "find",
        result: {
          observation: "collection",
          itemIdField: "id",
          itemCursorField: "createdAt",
        },
      },
      detector: {
        kind: "new_items",
      },
    });

    await harness.watchRunner.start();
    await harness.watchRunner.stop();

    await forceWatchDue(harness.pool, watch.id);
    await harness.watchRunner.start();
    await harness.coordinator.waitForIdle("session-thread");
    await harness.watchRunner.stop();

    const latestRun = await harness.watchStore.getLatestWatchRun(watch.id);
    expect(latestRun?.status).toBe("changed");
    expect(evaluateWatch).toHaveBeenCalledTimes(2);
    expect(evaluateWatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({id: watch.id}),
      {
        agentKey: "panda",
        identityId: harness.alice.id,
      },
    );

    const transcript = await harness.threadStore.loadTranscript("session-thread");
    const input = transcript.find((entry) => entry.origin === "input" && entry.source === "watch_event");
    expect(input?.message.role).toBe("user");
    expect(JSON.stringify(input?.message)).toContain("[Watch Event] Registrations");
    expect(JSON.stringify(input?.message)).toContain("If this session is connected to an external channel");
  });

  it("wakes Panda for an IMAP-style new email event only after bootstrap", async () => {
    const evaluateWatch = vi.fn<WatchEvaluator>()
      .mockResolvedValueOnce({
        changed: false,
        nextState: {
          kind: "new_items",
          identityToken: "uidvalidity-1",
          bootstrapped: true,
          lastCursor: 101,
          lastIds: ["101"],
        },
      } satisfies WatchEvaluationResult)
      .mockResolvedValueOnce({
        changed: true,
        nextState: {
          kind: "new_items",
          identityToken: "uidvalidity-1",
          bootstrapped: true,
          lastCursor: 102,
          lastIds: ["102"],
        },
        event: {
          eventKind: "new_items",
          summary: "Detected 1 new item.",
          dedupeKey: "imap-102",
        },
      });
    const harness = await createHarness(evaluateWatch);
    pools.push(harness.pool);

    const watch = await harness.watchStore.createWatch({
      sessionId: "session-main",
      createdByIdentityId: harness.alice.id,
      title: "Inbox",
      intervalMinutes: 5,
      source: {
        kind: "imap_mailbox",
        host: "imap.example.com",
        username: "alice@example.com",
        passwordCredentialEnvKey: "IMAP_PASSWORD",
      },
      detector: {
        kind: "new_items",
      },
    });

    await harness.watchRunner.start();
    await harness.watchRunner.stop();
    await forceWatchDue(harness.pool, watch.id);
    await harness.watchRunner.start();
    await harness.coordinator.waitForIdle("session-thread");
    await harness.watchRunner.stop();

    const eventRows = await harness.pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM "thread_runtime_watch_events" WHERE watch_id = $1`,
      [watch.id],
    );
    expect(eventRows.rows[0]).toMatchObject({count: 1});
  });

  it("wakes Panda for a BTC percent-move watch", async () => {
    const evaluateWatch = vi.fn<WatchEvaluator>()
      .mockResolvedValueOnce({
        changed: false,
        nextState: {
          kind: "percent_change",
          baseline: 100,
          lastValue: 100,
        },
      } satisfies WatchEvaluationResult)
      .mockResolvedValueOnce({
        changed: true,
        nextState: {
          kind: "percent_change",
          baseline: 112,
          lastValue: 112,
        },
        event: {
          eventKind: "percent_change",
          summary: "BTC moved +12.00% (from 100 to 112).",
          dedupeKey: "btc-112",
        },
      });
    const harness = await createHarness(evaluateWatch);
    pools.push(harness.pool);

    const watch = await harness.watchStore.createWatch({
      sessionId: "session-main",
      createdByIdentityId: harness.alice.id,
      title: "BTC move",
      intervalMinutes: 5,
      source: {
        kind: "http_json",
        url: "https://example.com/btc.json",
        result: {
          observation: "scalar",
          valuePath: "price",
          label: "BTC",
        },
      },
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    });

    await harness.watchRunner.start();
    await harness.watchRunner.stop();
    await forceWatchDue(harness.pool, watch.id);
    await harness.watchRunner.start();
    await harness.coordinator.waitForIdle("session-thread");
    await harness.watchRunner.stop();

    const latestRun = await harness.watchStore.getLatestWatchRun(watch.id);
    expect(latestRun?.status).toBe("changed");
  });

  it("wakes Panda for a property-listing HTML snapshot change", async () => {
    const evaluateWatch = vi.fn<WatchEvaluator>()
      .mockResolvedValueOnce({
        changed: false,
        nextState: {
          kind: "snapshot_changed",
          fingerprint: "listing-a-b",
          excerpt: "Listing A Listing B",
        },
      } satisfies WatchEvaluationResult)
      .mockResolvedValueOnce({
        changed: true,
        nextState: {
          kind: "snapshot_changed",
          fingerprint: "listing-a-b-c",
          excerpt: "Listing A Listing B Listing C",
        },
        event: {
          eventKind: "snapshot_changed",
          summary: "Observed content changed.",
          dedupeKey: "listing-c",
        },
      });
    const harness = await createHarness(evaluateWatch);
    pools.push(harness.pool);

    const watch = await harness.watchStore.createWatch({
      sessionId: "session-main",
      createdByIdentityId: harness.alice.id,
      title: "Property listings",
      intervalMinutes: 5,
      source: {
        kind: "http_html",
        url: "https://example.com/listings",
        result: {
          observation: "snapshot",
          mode: "selector_text",
          selector: "body",
        },
      },
      detector: {
        kind: "snapshot_changed",
      },
    });

    await harness.watchRunner.start();
    await harness.watchRunner.stop();
    await forceWatchDue(harness.pool, watch.id);
    await harness.watchRunner.start();
    await harness.coordinator.waitForIdle("session-thread");
    await harness.watchRunner.stop();

    const latestRun = await harness.watchStore.getLatestWatchRun(watch.id);
    expect(latestRun?.status).toBe("changed");
  });
});
