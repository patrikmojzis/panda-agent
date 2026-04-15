import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {SessionRouteRepo} from "../src/domain/sessions/index.js";

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

describe("SessionRouteRepo", () => {
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

    const store = new SessionRouteRepo({pool});
    await store.ensureSchema();

    await store.saveLastRoute({
      sessionId: "session-a",
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        externalActorId: "actor-1",
        externalMessageId: "msg-1",
        capturedAt: 100,
      },
    });
    await store.saveLastRoute({
      sessionId: "session-a",
      route: {
        source: "whatsapp",
        connectorKey: "wa-1",
        externalConversationId: "jid-1",
        capturedAt: 200,
      },
    });

    await expect(store.getLastRoute({
      sessionId: "session-a",
    })).resolves.toMatchObject({
      source: "whatsapp",
      externalConversationId: "jid-1",
    });
    await expect(store.getLastRoute({
      sessionId: "session-a",
      channel: "telegram",
    })).resolves.toMatchObject({
      source: "telegram",
      externalConversationId: "chat-1",
    });
  });

  it("updates the remembered route for the same channel", async () => {
    const pool = createPool();
    pools.push(pool);

    const store = new SessionRouteRepo({pool});
    await store.ensureSchema();

    await store.saveLastRoute({
      sessionId: "session-a",
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        capturedAt: 100,
      },
    });

    const updated = await store.saveLastRoute({
      sessionId: "session-a",
      route: {
        source: "telegram",
        connectorKey: "bot-2",
        externalConversationId: "chat-2",
        externalMessageId: "msg-2",
        capturedAt: 200,
      },
    });

    expect(updated).toMatchObject({
      sessionId: "session-a",
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

    const store = new SessionRouteRepo({pool});
    await store.ensureSchema();

    await expect(store.saveLastRoute({
      sessionId: "   ",
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        capturedAt: 100,
      },
    })).rejects.toThrow("Session route session id must not be empty.");
    await expect(store.saveLastRoute({
      sessionId: "session-a",
      route: {
        source: "   ",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        capturedAt: 100,
      },
    })).rejects.toThrow("Session route source must not be empty.");
    await expect(store.getLastRoute({
      sessionId: "   ",
    })).rejects.toThrow("Session route session id must not be empty.");
  });

  it("does not accept thread-era route aliases", async () => {
    const pool = createPool();
    pools.push(pool);

    const store = new SessionRouteRepo({pool});
    await store.ensureSchema();

    await expect(store.getLastRoute({
      sessionId: undefined as unknown as string,
    })).rejects.toThrow("Session route session id must not be empty.");
    await expect(store.saveLastRoute({
      sessionId: undefined as unknown as string,
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        capturedAt: 100,
      },
    })).rejects.toThrow("Session route session id must not be empty.");
  });
});
