import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresThreadRouteRepo} from "../src/domain/threads/routes/repo.js";

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

describe("PostgresThreadRouteRepo", () => {
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

  it("remembers routes per channel and returns the newest by default", async () => {
    const pool = createPool();
    pools.push(pool);

    const store = new PostgresThreadRouteRepo({pool});
    await store.ensureSchema();

    await store.rememberLastRoute({
      threadId: "thread-a",
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        externalActorId: "actor-1",
        externalMessageId: "msg-1",
        capturedAt: 100,
      },
    });
    await store.rememberLastRoute({
      threadId: "thread-a",
      route: {
        source: "whatsapp",
        connectorKey: "wa-1",
        externalConversationId: "jid-1",
        capturedAt: 200,
      },
    });

    await expect(store.resolveLastRoute({
      threadId: "thread-a",
    })).resolves.toMatchObject({
      source: "whatsapp",
      externalConversationId: "jid-1",
    });
    await expect(store.resolveLastRoute({
      threadId: "thread-a",
      channel: "telegram",
    })).resolves.toMatchObject({
      source: "telegram",
      externalConversationId: "chat-1",
    });
  });

  it("updates the remembered route for the same channel", async () => {
    const pool = createPool();
    pools.push(pool);

    const store = new PostgresThreadRouteRepo({pool});
    await store.ensureSchema();

    await store.rememberLastRoute({
      threadId: "thread-a",
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        capturedAt: 100,
      },
    });

    const updated = await store.rememberLastRoute({
      threadId: "thread-a",
      route: {
        source: "telegram",
        connectorKey: "bot-2",
        externalConversationId: "chat-2",
        externalMessageId: "msg-2",
        capturedAt: 200,
      },
    });

    expect(updated).toMatchObject({
      threadId: "thread-a",
      channel: "telegram",
      route: {
        source: "telegram",
        connectorKey: "bot-2",
        externalConversationId: "chat-2",
        externalMessageId: "msg-2",
        capturedAt: 200,
      },
    });
  });

  it("validates required fields", async () => {
    const pool = createPool();
    pools.push(pool);

    const store = new PostgresThreadRouteRepo({pool});
    await store.ensureSchema();

    await expect(store.rememberLastRoute({
      threadId: "   ",
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        capturedAt: 100,
      },
    })).rejects.toThrow("Thread route thread id must not be empty.");
    await expect(store.rememberLastRoute({
      threadId: "thread-a",
      route: {
        source: "   ",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        capturedAt: 100,
      },
    })).rejects.toThrow("Thread route source must not be empty.");
    await expect(store.resolveLastRoute({
      threadId: "   ",
    })).rejects.toThrow("Thread route thread id must not be empty.");
  });
});
