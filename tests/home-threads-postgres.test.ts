import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresHomeThreadStore} from "../src/index.js";

describe("PostgresHomeThreadStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("binds and rebinds home thread pointers", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresHomeThreadStore({ pool });
    await store.ensureSchema();

    await expect(store.resolveHomeThread({
      identityId: "identity-1",
      agentKey: "panda",
    })).resolves.toBeNull();

    const firstBind = await store.bindHomeThread({
      identityId: " identity-1 ",
      agentKey: " panda ",
      threadId: "thread-a",
      metadata: {
        lastRoutes: {
          telegram: {
            source: "telegram",
            connectorKey: "bot-1",
            externalConversationId: "chat-1",
            capturedAt: 123,
          },
        },
      },
    });
    expect(firstBind.previousThreadId).toBeUndefined();
    expect(firstBind.binding).toMatchObject({
      identityId: "identity-1",
      agentKey: "panda",
      threadId: "thread-a",
      metadata: {
        lastRoutes: {
          telegram: {
            source: "telegram",
            connectorKey: "bot-1",
            externalConversationId: "chat-1",
            capturedAt: 123,
          },
        },
      },
    });

    const rebound = await store.bindHomeThread({
      identityId: "identity-1",
      agentKey: "panda",
      threadId: "thread-b",
    });
    expect(rebound.previousThreadId).toBe("thread-a");
    expect(rebound.binding.threadId).toBe("thread-b");
    expect(rebound.binding.metadata).toEqual({
      lastRoutes: {
        telegram: {
          source: "telegram",
          connectorKey: "bot-1",
          externalConversationId: "chat-1",
          capturedAt: 123,
        },
      },
    });
    await expect(store.resolveLastRoute({
      identityId: "identity-1",
      agentKey: "panda",
    })).resolves.toMatchObject({
      source: "telegram",
      externalConversationId: "chat-1",
    });
    await expect(store.resolveLastRoute({
      identityId: "identity-1",
      agentKey: "panda",
    }, "telegram")).resolves.toMatchObject({
      source: "telegram",
      externalConversationId: "chat-1",
    });
  });

  it("isolates homes by identity and agent key", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresHomeThreadStore({ pool });
    await store.ensureSchema();

    await store.bindHomeThread({
      identityId: "identity-1",
      agentKey: "panda",
      threadId: "thread-a",
    });
    await store.bindHomeThread({
      identityId: "identity-1",
      agentKey: "ops",
      threadId: "thread-b",
    });
    await store.bindHomeThread({
      identityId: "identity-2",
      agentKey: "panda",
      threadId: "thread-c",
    });

    await expect(store.resolveHomeThread({
      identityId: "identity-1",
      agentKey: "panda",
    })).resolves.toMatchObject({ threadId: "thread-a" });
    await expect(store.resolveHomeThread({
      identityId: "identity-1",
      agentKey: "ops",
    })).resolves.toMatchObject({ threadId: "thread-b" });
    await expect(store.resolveHomeThread({
      identityId: "identity-2",
      agentKey: "panda",
    })).resolves.toMatchObject({ threadId: "thread-c" });
  });

  it("validates required fields", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresHomeThreadStore({ pool });
    await store.ensureSchema();

    await expect(store.bindHomeThread({
      identityId: "   ",
      agentKey: "panda",
      threadId: "thread-a",
    })).rejects.toThrow("Home thread identity id must not be empty.");
    await expect(store.resolveHomeThread({
      identityId: "identity-1",
      agentKey: "   ",
    })).rejects.toThrow("Home thread agent key must not be empty.");
  });

  it("remembers the last route without replacing the home thread pointer", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresHomeThreadStore({ pool });
    await store.ensureSchema();

    await store.bindHomeThread({
      identityId: "identity-1",
      agentKey: "panda",
      threadId: "thread-a",
      metadata: {
        homeDir: "/tmp/panda",
      },
    });

    const binding = await store.rememberLastRoute({
      identityId: "identity-1",
      agentKey: "panda",
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        externalActorId: "actor-1",
        externalMessageId: "msg-1",
        capturedAt: 123,
      },
    });

    expect(binding.threadId).toBe("thread-a");
    expect(binding.metadata).toEqual({
      homeDir: "/tmp/panda",
      lastRoutes: {
        telegram: {
          source: "telegram",
          connectorKey: "bot-1",
          externalConversationId: "chat-1",
          externalActorId: "actor-1",
          externalMessageId: "msg-1",
          capturedAt: 123,
        },
      },
    });
  });

  it("keeps independent remembered routes per channel and returns the newest by default", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresHomeThreadStore({ pool });
    await store.ensureSchema();

    await store.bindHomeThread({
      identityId: "identity-1",
      agentKey: "panda",
      threadId: "thread-a",
    });
    await store.rememberLastRoute({
      identityId: "identity-1",
      agentKey: "panda",
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        capturedAt: 100,
      },
    });
    await store.rememberLastRoute({
      identityId: "identity-1",
      agentKey: "panda",
      route: {
        source: "whatsapp",
        connectorKey: "wa-1",
        externalConversationId: "jid-1",
        capturedAt: 200,
      },
    });

    await expect(store.resolveLastRoute({
      identityId: "identity-1",
      agentKey: "panda",
    })).resolves.toMatchObject({
      source: "whatsapp",
      externalConversationId: "jid-1",
    });
    await expect(store.resolveLastRoute({
      identityId: "identity-1",
      agentKey: "panda",
    }, "telegram")).resolves.toMatchObject({
      source: "telegram",
      externalConversationId: "chat-1",
    });
  });
});
