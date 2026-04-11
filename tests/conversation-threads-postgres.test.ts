import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {ConversationThreadRepo} from "../src/domain/threads/conversations/repo.js";

describe("ConversationThreadRepo", () => {
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

  it("binds and rebinds conversation thread pointers", async () => {
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

    const store = new ConversationThreadRepo({ pool });
    await store.ensureSchema();

    await expect(store.resolveConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
    })).resolves.toBeNull();

    const firstBind = await store.bindConversationThread({
      source: " telegram ",
      connectorKey: " bot-main ",
      externalConversationId: " chat-1 ",
      threadId: "thread-a",
      metadata: {
        paired: true,
      },
    });
    expect(firstBind.previousThreadId).toBeUndefined();
    expect(firstBind.binding).toMatchObject({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      threadId: "thread-a",
      metadata: {
        paired: true,
      },
    });

    await expect(store.resolveConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
    })).resolves.toMatchObject({
      threadId: "thread-a",
    });

    const rebound = await store.bindConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      threadId: "thread-b",
    });
    expect(rebound.previousThreadId).toBe("thread-a");
    expect(rebound.binding.threadId).toBe("thread-b");

    const sameThread = await store.bindConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      threadId: "thread-b",
    });
    expect(sameThread.previousThreadId).toBeUndefined();
    expect(sameThread.binding.threadId).toBe("thread-b");
  });

  it("preserves metadata when rebinding without new metadata", async () => {
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

    const store = new ConversationThreadRepo({ pool });
    await store.ensureSchema();

    await store.bindConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-keep-meta",
      threadId: "thread-a",
      metadata: {
        paired: true,
      },
    });

    const rebound = await store.bindConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-keep-meta",
      threadId: "thread-b",
    });

    expect(rebound.previousThreadId).toBe("thread-a");
    expect(rebound.binding).toMatchObject({
      threadId: "thread-b",
      metadata: {
        paired: true,
      },
    });
  });

  it("isolates bindings by source and connector key", async () => {
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

    const store = new ConversationThreadRepo({ pool });
    await store.ensureSchema();

    await store.bindConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "42",
      threadId: "thread-telegram",
    });
    await store.bindConversationThread({
      source: "telegram",
      connectorKey: "bot-sidecar",
      externalConversationId: "42",
      threadId: "thread-sidecar",
    });
    await store.bindConversationThread({
      source: "whatsapp",
      connectorKey: "session-main",
      externalConversationId: "42",
      threadId: "thread-whatsapp",
    });

    await expect(store.resolveConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "42",
    })).resolves.toMatchObject({
      threadId: "thread-telegram",
    });
    await expect(store.resolveConversationThread({
      source: "telegram",
      connectorKey: "bot-sidecar",
      externalConversationId: "42",
    })).resolves.toMatchObject({
      threadId: "thread-sidecar",
    });
    await expect(store.resolveConversationThread({
      source: "whatsapp",
      connectorKey: "session-main",
      externalConversationId: "42",
    })).resolves.toMatchObject({
      threadId: "thread-whatsapp",
    });
  });

  it("validates required lookup fields", async () => {
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

    const store = new ConversationThreadRepo({ pool });
    await store.ensureSchema();

    await expect(store.bindConversationThread({
      source: "   ",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      threadId: "thread-a",
    })).rejects.toThrow("Conversation thread source must not be empty.");
    await expect(store.resolveConversationThread({
      source: "telegram",
      connectorKey: "   ",
      externalConversationId: "chat-1",
    })).rejects.toThrow("Conversation thread connector key must not be empty.");
    await expect(store.bindConversationThread({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      threadId: "   ",
    })).rejects.toThrow("Conversation thread thread id must not be empty.");
  });
});
