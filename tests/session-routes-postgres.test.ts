import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {SessionRouteRepo} from "../src/domain/sessions/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

function createPool() {
  const db = newDb();
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  db.public.registerFunction({
    name: "btrim",
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value: string) => value.trim(),
  });
  db.public.registerFunction({
    name: "nullif",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (left: string, right: string) => left === right ? null : left,
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

    const {sessionStore} = await createRuntimeStores(pool);
    const store = new SessionRouteRepo({pool});
    await store.ensureSchema();
    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
    });

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

    const {sessionStore} = await createRuntimeStores(pool);
    const store = new SessionRouteRepo({pool});
    await store.ensureSchema();
    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
    });

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

  it("round-trips delivery context for global and identity-scoped routes and replaces stale generic context", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore} = await createRuntimeStores(pool);
    const identity = await identityStore.createIdentity({
      id: "identity-patrik",
      handle: "patrik",
      displayName: "Patrik",
    });
    const store = new SessionRouteRepo({pool});
    await store.ensureSchema();
    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
      createdByIdentityId: identity.id,
    });

    await store.saveLastRoute({
      sessionId: "session-a",
      route: {
        source: "custom",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        capturedAt: 100,
        deliveryContext: {
          custom: {
            channelId: "thread-old",
            parentChannelId: "channel-1",
            threadId: "thread-old",
          },
        },
      },
    });
    await store.saveLastRoute({
      sessionId: "session-a",
      route: {
        source: "custom",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        capturedAt: 200,
        deliveryContext: {
          custom: {
            channelId: "thread-new",
            parentChannelId: "channel-1",
            threadId: "thread-new",
            guildId: "guild-1",
          },
        },
      },
    });
    await store.saveLastRoute({
      sessionId: "session-a",
      identityId: identity.id,
      route: {
        source: "custom",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        externalActorId: "user-1",
        capturedAt: 150,
        deliveryContext: {
          custom: {
            channelId: "channel-1",
            parentChannelId: "channel-1",
          },
        },
      },
    });

    await expect(store.getLastRoute({
      sessionId: "session-a",
      channel: "custom",
    })).resolves.toMatchObject({
      deliveryContext: {
        custom: {
          channelId: "thread-new",
          parentChannelId: "channel-1",
          threadId: "thread-new",
          guildId: "guild-1",
        },
      },
    });
    await expect(store.getLastRoute({
      sessionId: "session-a",
      identityId: identity.id,
      channel: "custom",
    })).resolves.toMatchObject({
      externalActorId: "user-1",
      deliveryContext: {
        custom: {
          channelId: "channel-1",
          parentChannelId: "channel-1",
        },
      },
    });
  });

  it("rejects non-object delivery context before writing session routes", async () => {
    const pool = createPool();
    pools.push(pool);

    await createRuntimeStores(pool);
    const store = new SessionRouteRepo({pool});
    await store.ensureSchema();

    await expect(store.saveLastRoute({
      sessionId: "session-a",
      route: {
        source: "custom",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        capturedAt: 100,
        deliveryContext: [] as never,
      },
    })).rejects.toThrow("Session route delivery context must be a JSON object.");
  });

  it("migrates legacy routes without surrogate ids", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore} = await createRuntimeStores(pool);
    const identity = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await sessionStore.createSession({
      id: "session-a",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-a",
      createdByIdentityId: identity.id,
    });
    await pool.query(`
      CREATE TABLE "runtime"."session_routes" (
        session_id TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        external_actor_id TEXT,
        external_message_id TEXT,
        captured_at_ms BIGINT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      INSERT INTO "runtime"."session_routes" (
        session_id,
        identity_id,
        channel,
        connector_key,
        external_conversation_id,
        captured_at_ms
      ) VALUES
        ('session-a', '   ', 'telegram', 'bot-1', 'chat-global', 10),
        ('session-a', 'alice-id', 'telegram', 'bot-1', 'chat-alice', 20)
    `);

    const store = new SessionRouteRepo({pool});
    await store.ensureSchema();

    await expect(pool.query(`
      SELECT id
      FROM "runtime"."session_routes"
      LIMIT 1
    `)).resolves.toBeDefined();

    const rows = await pool.query(`
      SELECT identity_id, external_conversation_id
      FROM "runtime"."session_routes"
      ORDER BY external_conversation_id
    `);
    expect(rows.rows).toEqual([
      {
        identity_id: "alice-id",
        external_conversation_id: "chat-alice",
      },
      {
        identity_id: null,
        external_conversation_id: "chat-global",
      },
    ]);
    await expect(store.getLastRoute({
      sessionId: "session-a",
    })).resolves.toMatchObject({
      externalConversationId: "chat-global",
    });
    await expect(store.getLastRoute({
      sessionId: "session-a",
      identityId: "alice-id",
    })).resolves.toMatchObject({
      externalConversationId: "chat-alice",
    });
  });

  it("validates required fields", async () => {
    const pool = createPool();
    pools.push(pool);

    await createRuntimeStores(pool);
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
    await expect(store.saveLastRoute({
      sessionId: "session-a",
      route: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
        capturedAt: Number.NaN,
      },
    })).rejects.toThrow("Session route capturedAt must be a safe integer.");
  });

  it("rejects malformed persisted session route rows", async () => {
    const store = new SessionRouteRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            session_id: "session-a",
            identity_id: null,
            channel: "telegram",
            connector_key: "bot-main",
            external_conversation_id: "chat-1",
            external_actor_id: null,
            external_message_id: null,
            captured_at_ms: "soon",
            created_at: new Date(),
            updated_at: new Date(),
          }],
        })),
      },
    });

    await expect(store.getLastRoute({
      sessionId: "session-a",
      channel: "telegram",
    })).rejects.toThrow("Session route capturedAt must be a safe integer.");
  });

  it("accepts postgres bigint-shaped persisted session route timestamps", async () => {
    const store = new SessionRouteRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            session_id: "session-a",
            identity_id: null,
            channel: "telegram",
            connector_key: "bot-main",
            external_conversation_id: "chat-1",
            external_actor_id: null,
            external_message_id: null,
            captured_at_ms: "200",
            metadata: {route: "legacy-without-context"},
            created_at: new Date(),
            updated_at: new Date(),
          }],
        })),
      },
    });

    await expect(store.getLastRoute({
      sessionId: "session-a",
      channel: "telegram",
    })).resolves.toMatchObject({
      capturedAt: 200,
    });
    await expect(store.getLastRoute({
      sessionId: "session-a",
      channel: "telegram",
    })).resolves.not.toHaveProperty("deliveryContext");
  });

  it("rejects non-integral persisted session route timestamps", async () => {
    const store = new SessionRouteRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            session_id: "session-a",
            identity_id: null,
            channel: "telegram",
            connector_key: "bot-main",
            external_conversation_id: "chat-1",
            external_actor_id: null,
            external_message_id: null,
            captured_at_ms: "200.5",
            created_at: new Date(),
            updated_at: new Date(),
          }],
        })),
      },
    });

    await expect(store.getLastRoute({
      sessionId: "session-a",
      channel: "telegram",
    })).rejects.toThrow("Session route capturedAt must be a safe integer.");
  });
});
