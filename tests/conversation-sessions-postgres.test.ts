import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {ConversationRepo} from "../src/domain/sessions/conversations/repo.js";

describe("ConversationRepo", () => {
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

  it("binds and rebinds conversation session pointers", async () => {
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

    const {sessionStore} = await createRuntimeStores(pool);
    const store = new ConversationRepo({ pool });
    await store.ensureSchema();
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

    await expect(store.getConversationBinding({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
    })).resolves.toBeNull();

    const firstBind = await store.bindConversation({
      source: " telegram ",
      connectorKey: " bot-main ",
      externalConversationId: " chat-1 ",
      sessionId: "session-a",
      metadata: {
        paired: true,
      },
    });
    expect(firstBind.previousSessionId).toBeUndefined();
    expect(firstBind.binding).toMatchObject({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      sessionId: "session-a",
      metadata: {
        paired: true,
      },
    });

    await expect(store.getConversationBinding({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
    })).resolves.toMatchObject({
      sessionId: "session-a",
    });

    const rebound = await store.bindConversation({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      sessionId: "session-b",
    });
    expect(rebound.previousSessionId).toBe("session-a");
    expect(rebound.binding.sessionId).toBe("session-b");

    const sameSession = await store.bindConversation({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      sessionId: "session-b",
    });
    expect(sameSession.previousSessionId).toBeUndefined();
    expect(sameSession.binding.sessionId).toBe("session-b");
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

    const {sessionStore} = await createRuntimeStores(pool);
    const store = new ConversationRepo({ pool });
    await store.ensureSchema();
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

    await store.bindConversation({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-keep-meta",
      sessionId: "session-a",
      metadata: {
        paired: true,
      },
    });

    const rebound = await store.bindConversation({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-keep-meta",
      sessionId: "session-b",
    });

    expect(rebound.previousSessionId).toBe("session-a");
    expect(rebound.binding).toMatchObject({
      sessionId: "session-b",
      metadata: {
        paired: true,
      },
    });
  });

  it("rejects non-json conversation metadata before persistence", async () => {
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

    const {sessionStore} = await createRuntimeStores(pool);
    const store = new ConversationRepo({ pool });
    await store.ensureSchema();
    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
    });

    await expect(store.bindConversation({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-bad-meta",
      sessionId: "session-a",
      metadata: Number.NaN,
    })).rejects.toThrow("Conversation binding metadata must be JSON-serializable.");
  });

  it("rejects malformed persisted conversation binding rows", async () => {
    const store = new ConversationRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            source: "telegram",
            connector_key: "bot-main",
            external_conversation_id: "chat-1",
            session_id: "session-a",
            metadata: Number.NaN,
            created_at: new Date(),
            updated_at: new Date(),
          }],
        })),
      },
    });

    await expect(store.getConversationBinding({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
    })).rejects.toThrow("Conversation binding metadata must be JSON-serializable.");
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

    const {sessionStore} = await createRuntimeStores(pool);
    const store = new ConversationRepo({ pool });
    await store.ensureSchema();
    await sessionStore.createSession({
      id: "session-telegram",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-telegram",
    });
    await sessionStore.createSession({
      id: "session-secondary",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-secondary",
    });
    await sessionStore.createSession({
      id: "session-whatsapp",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-whatsapp",
    });

    await store.bindConversation({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "42",
      sessionId: "session-telegram",
    });
    await store.bindConversation({
      source: "telegram",
      connectorKey: "bot-secondary",
      externalConversationId: "42",
      sessionId: "session-secondary",
    });
    await store.bindConversation({
      source: "whatsapp",
      connectorKey: "session-main",
      externalConversationId: "42",
      sessionId: "session-whatsapp",
    });

    await expect(store.getConversationBinding({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "42",
    })).resolves.toMatchObject({
      sessionId: "session-telegram",
    });
    await expect(store.getConversationBinding({
      source: "telegram",
      connectorKey: "bot-secondary",
      externalConversationId: "42",
    })).resolves.toMatchObject({
      sessionId: "session-secondary",
    });
    await expect(store.getConversationBinding({
      source: "whatsapp",
      connectorKey: "session-main",
      externalConversationId: "42",
    })).resolves.toMatchObject({
      sessionId: "session-whatsapp",
    });
  });

  it("lists, create-only inserts, and deletes scoped conversation bindings", async () => {
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

    const {sessionStore} = await createRuntimeStores(pool);
    const store = new ConversationRepo({ pool });
    await store.ensureSchema();
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

    const created = await store.createConversationBinding({
      source: "discord",
      connectorKey: "bot-main",
      externalConversationId: "channel-2",
      sessionId: "session-a",
      metadata: {
        boundVia: "discord-cli",
      },
    });
    expect(created).toMatchObject({
      source: "discord",
      connectorKey: "bot-main",
      externalConversationId: "channel-2",
      sessionId: "session-a",
    });
    await expect(store.createConversationBinding({
      source: "discord",
      connectorKey: "bot-main",
      externalConversationId: "channel-2",
      sessionId: "session-b",
    })).resolves.toBeNull();

    await store.bindConversation({
      source: "discord",
      connectorKey: "bot-main",
      externalConversationId: "channel-1",
      sessionId: "session-b",
    });
    await store.bindConversation({
      source: "discord",
      connectorKey: "bot-secondary",
      externalConversationId: "channel-1",
      sessionId: "session-a",
    });

    await expect(store.listConversationBindings({
      source: "discord",
      connectorKey: "bot-main",
    })).resolves.toMatchObject([
      {
        externalConversationId: "channel-1",
        sessionId: "session-b",
      },
      {
        externalConversationId: "channel-2",
        sessionId: "session-a",
      },
    ]);

    await expect(store.deleteConversationBinding({
      source: "discord",
      connectorKey: "bot-main",
      externalConversationId: "channel-2",
    })).resolves.toBe(true);
    await expect(store.deleteConversationBinding({
      source: "discord",
      connectorKey: "bot-main",
      externalConversationId: "channel-2",
    })).resolves.toBe(false);
    await expect(store.getConversationBinding({
      source: "discord",
      connectorKey: "bot-main",
      externalConversationId: "channel-2",
    })).resolves.toBeNull();
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

    await createRuntimeStores(pool);
    const store = new ConversationRepo({ pool });
    await store.ensureSchema();

    await expect(store.bindConversation({
      source: "   ",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      sessionId: "session-a",
    })).rejects.toThrow("Conversation binding source must not be empty.");
    await expect(store.getConversationBinding({
      source: "telegram",
      connectorKey: "   ",
      externalConversationId: "chat-1",
    })).rejects.toThrow("Conversation binding connector key must not be empty.");
    await expect(store.bindConversation({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-1",
      sessionId: "   ",
    })).rejects.toThrow("Conversation binding session id must not be empty.");
  });
});
