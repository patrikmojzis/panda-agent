import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";
import {DataType, newDb} from "pg-mem";

import {Agent} from "../src/index.js";
import {PostgresHomeThreadStore} from "../src/domain/threads/home/index.js";
import {PostgresThreadRuntimeStore, ThreadRuntimeCoordinator} from "../src/domain/threads/runtime/index.js";
import {PostgresWatchStore, WatchRunner, type WatchSourceResolver} from "../src/domain/watches/index.js";

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

async function createHarness(sourceResolvers: Partial<Record<string, WatchSourceResolver>>) {
  const db = newDb();
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();

  const threadStore = new PostgresThreadRuntimeStore({pool});
  await threadStore.ensureSchema();
  const homeThreads = new PostgresHomeThreadStore({pool});
  await homeThreads.ensureSchema();
  const watchStore = new PostgresWatchStore({pool});
  await watchStore.ensureSchema();

  const alice = await threadStore.identityStore.createIdentity({
    id: "alice-id",
    handle: "alice",
    displayName: "Alice",
  });
  await threadStore.createThread({
    id: "home-thread",
    identityId: alice.id,
    agentKey: "panda",
  });
  await homeThreads.bindHomeThread({
    identityId: alice.id,
    threadId: "home-thread",
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
    homeThreads,
    coordinator,
    credentialResolver: {
      resolveCredential: vi.fn(async (envKey: string) => ({
        id: envKey,
        envKey,
        value: `${envKey}-value`,
        scope: "relationship",
        agentKey: "panda",
        identityId: alice.id,
        keyVersion: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
    } as any,
    sourceResolvers: sourceResolvers as any,
  });

  return {
    alice,
    pool,
    runtime,
    threadStore,
    homeThreads,
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
    const resolver = vi.fn()
      .mockResolvedValueOnce({
        identityToken: "mongo-stream",
        observation: {
          kind: "collection",
          items: [
            {id: "reg-1", cursor: "2026-04-11T10:00:00.000Z", summary: "Alice"},
          ],
        },
      })
      .mockResolvedValueOnce({
        identityToken: "mongo-stream",
        observation: {
          kind: "collection",
          items: [
            {id: "reg-1", cursor: "2026-04-11T10:00:00.000Z", summary: "Alice"},
            {id: "reg-2", cursor: "2026-04-11T10:05:00.000Z", summary: "Bob"},
          ],
        },
      });
    const harness = await createHarness({
      mongodb_query: resolver as WatchSourceResolver,
    });
    pools.push(harness.pool);

    const watch = await harness.watchStore.createWatch({
      identityId: harness.alice.id,
      agentKey: "panda",
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
    await harness.coordinator.waitForIdle("home-thread");
    await harness.watchRunner.stop();

    const latestRun = await harness.watchStore.getLatestWatchRun(watch.id);
    expect(latestRun?.status).toBe("changed");
    expect(resolver).toHaveBeenCalledTimes(2);

    const transcript = await harness.threadStore.loadTranscript("home-thread");
    const input = transcript.find((entry) => entry.origin === "input" && entry.source === "watch_event");
    expect(input?.message.role).toBe("user");
    expect(JSON.stringify(input?.message)).toContain("[Watch Event] Registrations");
  });

  it("wakes Panda for an IMAP-style new email event only after bootstrap", async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce({
        identityToken: "uidvalidity-1",
        observation: {
          kind: "collection",
          items: [
            {id: "101", cursor: 101, summary: "First mail"},
          ],
        },
      })
      .mockResolvedValueOnce({
        identityToken: "uidvalidity-1",
        observation: {
          kind: "collection",
          items: [
            {id: "101", cursor: 101, summary: "First mail"},
            {id: "102", cursor: 102, summary: "Second mail"},
          ],
        },
      });
    const harness = await createHarness({
      imap_mailbox: resolver as WatchSourceResolver,
    });
    pools.push(harness.pool);

    const watch = await harness.watchStore.createWatch({
      identityId: harness.alice.id,
      agentKey: "panda",
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
    await harness.coordinator.waitForIdle("home-thread");
    await harness.watchRunner.stop();

    const eventRows = await harness.pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM "thread_runtime_watch_events" WHERE watch_id = $1`,
      [watch.id],
    );
    expect(eventRows.rows[0]).toMatchObject({count: 1});
  });

  it("wakes Panda for a BTC percent-move watch", async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce({
        observation: {
          kind: "scalar",
          value: 100,
          label: "BTC",
        },
      })
      .mockResolvedValueOnce({
        observation: {
          kind: "scalar",
          value: 112,
          label: "BTC",
        },
      });
    const harness = await createHarness({
      http_json: resolver as WatchSourceResolver,
    });
    pools.push(harness.pool);

    const watch = await harness.watchStore.createWatch({
      identityId: harness.alice.id,
      agentKey: "panda",
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
    await harness.coordinator.waitForIdle("home-thread");
    await harness.watchRunner.stop();

    const latestRun = await harness.watchStore.getLatestWatchRun(watch.id);
    expect(latestRun?.status).toBe("changed");
  });

  it("wakes Panda for a property-listing HTML snapshot change", async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce({
        observation: {
          kind: "snapshot",
          text: "Listing A\nListing B",
        },
      })
      .mockResolvedValueOnce({
        observation: {
          kind: "snapshot",
          text: "Listing A\nListing B\nListing C",
        },
      });
    const harness = await createHarness({
      http_html: resolver as WatchSourceResolver,
    });
    pools.push(harness.pool);

    const watch = await harness.watchStore.createWatch({
      identityId: harness.alice.id,
      agentKey: "panda",
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
    await harness.coordinator.waitForIdle("home-thread");
    await harness.watchRunner.stop();

    const latestRun = await harness.watchStore.getLatestWatchRun(watch.id);
    expect(latestRun?.status).toBe("changed");
  });
});
