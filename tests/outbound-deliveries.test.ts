import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import type {ChannelOutboundAdapter, OutboundRequest, OutboundResult} from "../src/domain/channels/index.js";
import {
    ChannelOutboundDeliveryWorker,
    PostgresOutboundDeliveryStore,
} from "../src/domain/channels/deliveries/index.js";
import {ensurePostgresOutboundDeliverySchema} from "../src/domain/channels/deliveries/postgres-schema.js";
import type {
    CompleteDeliveryInput,
    DeliveryNotification,
    DeliveryWorkerLookup,
    FailDeliveryInput,
    OutboundDeliveryInput,
    OutboundDeliveryRecord,
} from "../src/domain/channels/deliveries/types.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {waitFor} from "./helpers/wait-for.js";

describe("PostgresOutboundDeliveryStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (pool) {
        await pool.end();
      }
    }
  });

  function persistedDeliveryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "delivery-1",
      thread_id: "thread-1",
      channel: "telegram",
      connector_key: "bot-1",
      external_conversation_id: "chat-1",
      external_actor_id: null,
      reply_to_message_id: null,
      items: [{type: "text", text: "hello"}],
      metadata: null,
      status: "pending",
      attempt_count: 0,
      last_error: null,
      sent_items: null,
      claimed_at: null,
      completed_at: null,
      created_at: new Date(1),
      updated_at: new Date(1),
      ...overrides,
    };
  }

  it("uses the notification pool for LISTEN clients", async () => {
    const queryPool = {
      connect: vi.fn(async () => {
        throw new Error("query pool should not be used for LISTEN");
      }),
      query: vi.fn(async () => ({rows: []})),
    };
    const client = {
      off: vi.fn(),
      on: vi.fn(),
      query: vi.fn(async () => ({rows: []})),
      release: vi.fn(),
    };
    const notificationPool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({rows: []})),
    };
    const store = new PostgresOutboundDeliveryStore({
      pool: queryPool,
      notificationPool,
    });

    const unsubscribe = await store.listenPendingDeliveries(() => {});
    await unsubscribe();

    expect(queryPool.connect).not.toHaveBeenCalled();
    expect(notificationPool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "LISTEN runtime_outbound_delivery_events");
    expect(client.query).toHaveBeenNthCalledWith(2, "UNLISTEN runtime_outbound_delivery_events");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("releases the notification client when LISTEN setup fails", async () => {
    const queryPool = {
      connect: vi.fn(async () => {
        throw new Error("query pool should not be used for LISTEN");
      }),
      query: vi.fn(async () => ({rows: []})),
    };
    const client = {
      off: vi.fn(),
      on: vi.fn(),
      query: vi.fn(async () => ({rows: []})),
      release: vi.fn(),
    };
    client.query.mockRejectedValueOnce(new Error("listen blew up"));
    const store = new PostgresOutboundDeliveryStore({
      pool: queryPool,
      notificationPool: {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => ({rows: []})),
      },
    });

    await expect(store.listenPendingDeliveries(() => {})).rejects.toThrow("listen blew up");

    expect(client.off).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("enqueues, claims, and completes deliveries", async () => {
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

    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const store = new PostgresOutboundDeliveryStore({ pool });
    await ensurePostgresOutboundDeliverySchema(pool);
    await sessionStore.createSession({
      id: "session-1",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-1",
    });
    await threadStore.createThread({
      id: "thread-1",
      sessionId: "session-1",
    });

    const input = {
      idempotencyKey: "runtime-request:request-1:system-reply",
      threadId: "thread-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{type: "text" as const, text: "hello"}],
    };
    const delivery = await store.enqueueDelivery(input);

    expect(delivery.status).toBe("pending");

    const claimed = await store.claimNextPendingDelivery({
      channel: "telegram",
      connectorKey: "bot-1",
    });
    expect(claimed).not.toBeNull();
    expect(claimed).toMatchObject({
      id: delivery.id,
      status: "sending",
      attemptCount: 1,
    });

    const sent = await store.markDeliverySent({
      id: delivery.id,
      claimToken: claimed!.claimToken!,
      sent: [{ type: "text", externalMessageId: "101" }],
    });
    expect(sent).toMatchObject({
      id: delivery.id,
      status: "sent",
      sent: [{ type: "text", externalMessageId: "101" }],
    });
    await expect(store.enqueueDelivery(input)).resolves.toMatchObject({
      id: delivery.id,
      idempotencyKey: input.idempotencyKey,
      status: "sent",
    });
    await expect(store.enqueueDelivery({
      ...input,
      items: [{type: "text", text: "different"}],
    })).rejects.toThrow("already bound to a different delivery");
    await expect(pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."outbound_deliveries"`))
      .resolves.toMatchObject({rows: [{count: 1}]});
  });

  it("lists target deliveries scoped to one session", async () => {
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

    const {agentStore, sessionStore, threadStore} = await createRuntimeStores(pool);
    const store = new PostgresOutboundDeliveryStore({ pool });
    await ensurePostgresOutboundDeliverySchema(pool);
    await agentStore.bootstrapAgent({
      agentKey: "other-agent",
      displayName: "Other Agent",
    });
    await sessionStore.createSession({
      id: "session-1",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-1",
    });
    await sessionStore.createSession({
      id: "session-2",
      agentKey: "other-agent",
      kind: "main",
      currentThreadId: "thread-2",
    });
    await threadStore.createThread({
      id: "thread-1",
      sessionId: "session-1",
    });
    await threadStore.createThread({
      id: "thread-2",
      sessionId: "session-2",
    });

    const visible = await store.enqueueDelivery({
      threadId: "thread-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{ type: "text", text: "visible" }],
    });
    await store.enqueueDelivery({
      threadId: "thread-2",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{ type: "text", text: "other session" }],
    });
    await store.enqueueDelivery({
      threadId: "thread-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-2",
      },
      items: [{ type: "text", text: "other chat" }],
    });

    await expect(store.listDeliveriesForTarget({
      sessionId: "session-1",
      channel: "telegram",
      connectorKey: "bot-1",
      externalConversationId: "chat-1",
      limit: 10,
    })).resolves.toEqual([
      expect.objectContaining({
        id: visible.id,
        threadId: "thread-1",
        target: expect.objectContaining({
          externalConversationId: "chat-1",
        }),
      }),
    ]);
  });

  it("round-trips target delivery context through reserved metadata", async () => {
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
    const store = new PostgresOutboundDeliveryStore({ pool });
    await ensurePostgresOutboundDeliverySchema(pool);
    const deliveryContext = {
      discord: {
        channelId: "thread-1",
        parentChannelId: "channel-1",
        threadId: "thread-1",
      },
    };

    const delivery = await store.enqueueDelivery({
      channel: "discord",
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        deliveryContext,
      },
      items: [{ type: "text", text: "hello thread" }],
      metadata: {custom: true},
    });

    expect(delivery).toMatchObject({
      target: {deliveryContext},
      metadata: {custom: true, deliveryContext},
    });
    await expect(store.getDelivery(delivery.id)).resolves.toMatchObject({
      target: {deliveryContext},
      metadata: {custom: true, deliveryContext},
    });
    const claimed = await store.claimNextPendingDelivery({
      channel: "discord",
      connectorKey: "bot-1",
    });
    expect(claimed).toMatchObject({
      target: {deliveryContext},
      metadata: {custom: true, deliveryContext},
    });
  });

  it("rejects malformed delivery context before enqueueing", async () => {
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
    const store = new PostgresOutboundDeliveryStore({ pool });
    await ensurePostgresOutboundDeliverySchema(pool);

    await expect(store.enqueueDelivery({
      channel: "discord",
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        deliveryContext: [] as never,
      },
      items: [{ type: "text", text: "hello" }],
    })).rejects.toThrow("Outbound delivery target delivery context must be a JSON object.");

    await expect(store.enqueueDelivery({
      channel: "discord",
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        deliveryContext: {discord: {channelId: "channel-1"}},
      },
      items: [{ type: "text", text: "hello" }],
      metadata: "legacy metadata",
    })).rejects.toThrow("Outbound delivery metadata must be a JSON object when target deliveryContext is provided.");
  });

  it("rejects non-json delivery metadata before enqueueing", async () => {
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
    const store = new PostgresOutboundDeliveryStore({ pool });
    await ensurePostgresOutboundDeliverySchema(pool);

    await expect(store.enqueueDelivery({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{ type: "text", text: "hello" }],
      metadata: Number.NaN,
    })).rejects.toThrow("Outbound delivery metadata must be JSON-serializable.");
  });

  it("rejects malformed persisted delivery items before claiming them", async () => {
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
    const store = new PostgresOutboundDeliveryStore({ pool });
    await ensurePostgresOutboundDeliverySchema(pool);
    await pool.query(`
      INSERT INTO "runtime"."outbound_deliveries" (
        id,
        channel,
        connector_key,
        external_conversation_id,
        items,
        status
      ) VALUES (
        '00000000-0000-0000-0000-000000000002',
        'telegram',
        'bot-1',
        'chat-1',
        $1::jsonb,
        'pending'
      )
    `, [
      JSON.stringify([{type: "image"}]),
    ]);

    await expect(store.claimNextPendingDelivery({
      channel: "telegram",
      connectorKey: "bot-1",
    })).rejects.toThrow("Outbound delivery image item path must not be empty.");

    const rows = await pool.query(
      `SELECT status, attempt_count FROM "runtime"."outbound_deliveries" WHERE id = '00000000-0000-0000-0000-000000000002'`,
    );
    expect(rows.rows[0]).toMatchObject({
      status: "pending",
      attempt_count: 0,
    });
  });

  it("rejects malformed persisted delivery identity fields", async () => {
    const store = new PostgresOutboundDeliveryStore({
      pool: {
        query: vi.fn(async () => ({
          rows: [persistedDeliveryRow({connector_key: ""})],
        })),
        connect: vi.fn(),
      },
    });

    await expect(store.getDelivery("delivery-1")).rejects.toThrow(
      "Outbound delivery target connector key must not be empty.",
    );
  });

  it("rejects malformed persisted delivery counters and timestamps", async () => {
    const badCount = new PostgresOutboundDeliveryStore({
      pool: {
        query: vi.fn(async () => ({
          rows: [persistedDeliveryRow({attempt_count: "many"})],
        })),
        connect: vi.fn(),
      },
    });
    await expect(badCount.getDelivery("delivery-1")).rejects.toThrow(
      "Outbound delivery attempt count must be a non-negative integer.",
    );

    const badTimestamp = new PostgresOutboundDeliveryStore({
      pool: {
        query: vi.fn(async () => ({
          rows: [persistedDeliveryRow({created_at: "eventually"})],
        })),
        connect: vi.fn(),
      },
    });
    await expect(badTimestamp.getDelivery("delivery-1")).rejects.toThrow(
      "Outbound delivery created_at must be a finite timestamp.",
    );
  });

  it("preserves abandoned sending deliveries as unknown outcomes", async () => {
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

    const {sessionStore, threadStore} = await createRuntimeStores(pool);
    const store = new PostgresOutboundDeliveryStore({ pool });
    await ensurePostgresOutboundDeliverySchema(pool);
    await sessionStore.createSession({
      id: "session-1",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-1",
    });
    await threadStore.createThread({
      id: "thread-1",
      sessionId: "session-1",
    });

    const delivery = await store.enqueueDelivery({
      threadId: "thread-1",
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "wa-1",
        externalConversationId: "jid-1",
      },
      items: [{ type: "text", text: "hello" }],
    });

    await store.claimNextPendingDelivery({
      channel: "whatsapp",
      connectorKey: "wa-1",
    });
    const recovered = await store.markSendingDeliveriesUnknown({
      channel: "whatsapp",
      connectorKey: "wa-1",
    }, "worker died");

    expect(recovered).toBe(1);
    await expect(store.getDelivery(delivery.id)).resolves.toMatchObject({
      status: "unknown",
      lastError: "worker died",
    });
  });
});

class MemoryDeliveryStore {
  deliveries: OutboundDeliveryRecord[] = [];
  listener: ((notification: DeliveryNotification) => Promise<void> | void) | null = null;
  counter = 0;

  async enqueueDelivery(input: OutboundDeliveryInput): Promise<OutboundDeliveryRecord> {
    this.counter += 1;
    const delivery: OutboundDeliveryRecord = {
      id: `delivery-${this.counter}`,
      status: "pending",
      attemptCount: 0,
      createdAt: this.counter,
      updatedAt: this.counter,
      ...input,
    };
    this.deliveries.push(delivery);
    await this.listener?.({
      channel: input.channel,
      connectorKey: input.target.connectorKey,
    });
    return delivery;
  }

  async getDelivery(id: string): Promise<OutboundDeliveryRecord> {
    const delivery = this.deliveries.find((candidate) => candidate.id === id);
    if (!delivery) {
      throw new Error(`Unknown outbound delivery ${id}`);
    }

    return delivery;
  }

  async claimNextPendingDelivery(lookup: DeliveryWorkerLookup): Promise<OutboundDeliveryRecord | null> {
    const delivery = this.deliveries.find((candidate) =>
      candidate.status === "pending"
      && candidate.channel === lookup.channel
      && candidate.target.connectorKey === lookup.connectorKey);
    if (!delivery) {
      return null;
    }

    delivery.status = "sending";
    delivery.claimToken = `claim-${delivery.id}`;
    delivery.attemptCount += 1;
    return delivery;
  }

  async markDeliverySent(input: CompleteDeliveryInput): Promise<OutboundDeliveryRecord> {
    const delivery = await this.getDelivery(input.id);
    delivery.status = "sent";
    delivery.sent = input.sent;
    return delivery;
  }

  async markDeliveryFailed(input: FailDeliveryInput): Promise<OutboundDeliveryRecord> {
    const delivery = await this.getDelivery(input.id);
    delivery.status = "failed";
    delivery.lastError = input.error;
    return delivery;
  }

  async markDeliveryUnknown(input: FailDeliveryInput): Promise<OutboundDeliveryRecord> {
    const delivery = await this.getDelivery(input.id);
    if (delivery.status === "sending" && delivery.claimToken === input.claimToken) {
      delivery.status = "unknown";
      delivery.lastError = input.error;
    }
    return delivery;
  }

  async markSendingDeliveriesUnknown(lookup: DeliveryWorkerLookup, error: string): Promise<number> {
    let count = 0;
    for (const delivery of this.deliveries) {
      if (
        delivery.status === "sending"
        && delivery.channel === lookup.channel
        && delivery.target.connectorKey === lookup.connectorKey
      ) {
        delivery.status = "unknown";
        delivery.lastError = error;
        count += 1;
      }
    }

    return count;
  }

  async listenPendingDeliveries(
    listener: (notification: DeliveryNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    this.listener = listener;
    return async () => {
      this.listener = null;
    };
  }
}

describe("ChannelOutboundDeliveryWorker", () => {
  it("drains pending backlog on startup", async () => {
    const store = new MemoryDeliveryStore();
    await store.enqueueDelivery({
      threadId: "thread-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{ type: "text", text: "hello" }],
    });

    const send = vi.fn(async (request: OutboundRequest): Promise<OutboundResult> => ({
      ok: true,
      channel: request.channel,
      target: request.target,
      sent: [{ type: "text", externalMessageId: "101" }],
    }));
    const adapter: ChannelOutboundAdapter = {
      channel: "telegram",
      send,
    };

    const worker = new ChannelOutboundDeliveryWorker({
      store,
      adapter,
      connectorKey: "bot-1",
    });

    await worker.start();
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    await worker.stop();

    expect(store.deliveries[0]).toMatchObject({
      status: "sent",
      sent: [{ type: "text", externalMessageId: "101" }],
    });
  });

  it("marks failures without retrying automatically", async () => {
    const store = new MemoryDeliveryStore();
    await store.enqueueDelivery({
      threadId: "thread-1",
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "wa-1",
        externalConversationId: "jid-1",
      },
      items: [{ type: "text", text: "hello" }],
    });

    const send = vi.fn(async () => {
      throw new Error("socket unavailable");
    });
    const adapter: ChannelOutboundAdapter = {
      channel: "whatsapp",
      send,
    };

    const worker = new ChannelOutboundDeliveryWorker({
      store,
      adapter,
      connectorKey: "wa-1",
    });

    await worker.start();
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    await worker.stop();

    expect(store.deliveries[0]).toMatchObject({
      status: "failed",
      lastError: "socket unavailable",
      attemptCount: 1,
    });
  });

  it("polls as a fallback when delivery notifications are not subscribed", async () => {
    const store = new MemoryDeliveryStore();
    const send = vi.fn(async (request: OutboundRequest): Promise<OutboundResult> => ({
      ok: true,
      channel: request.channel,
      target: request.target,
      sent: [{ type: "text", externalMessageId: "101" }],
    }));
    const worker = new ChannelOutboundDeliveryWorker({
      store,
      adapter: {
        channel: "telegram",
        send,
      },
      connectorKey: "bot-1",
      pollIntervalMs: 1,
    });

    await worker.start({
      subscribeToNotifications: false,
    });
    await store.enqueueDelivery({
      threadId: "thread-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{ type: "text", text: "hello" }],
    });

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    await worker.stop();

    expect(store.deliveries[0]).toMatchObject({
      status: "sent",
      sent: [{ type: "text", externalMessageId: "101" }],
    });
    expect(store.listener).toBeNull();
  });

  it("can start without owning the notification subscription", async () => {
    const store = new MemoryDeliveryStore();
    await store.enqueueDelivery({
      threadId: "thread-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{ type: "text", text: "hello" }],
    });

    const send = vi.fn(async (request: OutboundRequest): Promise<OutboundResult> => ({
      ok: true,
      channel: request.channel,
      target: request.target,
      sent: [{ type: "text", externalMessageId: "101" }],
    }));
    const worker = new ChannelOutboundDeliveryWorker({
      store,
      adapter: {
        channel: "telegram",
        send,
      },
      connectorKey: "bot-1",
    });

    await worker.start({
      subscribeToNotifications: false,
    });
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    await worker.stop();

    expect(store.listener).toBeNull();
  });
});

describe("outbound receipt settlement", () => {
  async function prepare() {
    const store = new MemoryDeliveryStore();
    const delivery = await store.enqueueDelivery({
      channel: "telegram",
      target: {source: "telegram", connectorKey: "bot", externalConversationId: "chat"},
      items: [{type: "text", text: "hello"}],
    });
    const send = vi.fn(async (request: OutboundRequest): Promise<OutboundResult> => ({
      ok: true, channel: request.channel, target: request.target,
      sent: [{type: "text", externalMessageId: "receipt"}],
    }));
    const onTerminalFailure = vi.fn(async () => {});
    const onError = vi.fn();
    const options = {store, adapter: {channel: "telegram", send, onTerminalFailure}, connectorKey: "bot", onError};
    return {store, delivery, send, onTerminalFailure, onError, options};
  }

  it.each(["write rejected", "acknowledgement lost"] as const)("settles one send when its receipt %s", async (mode) => {
    const h = await prepare();
    const write = h.store.markDeliverySent.bind(h.store);
    vi.spyOn(h.store, "markDeliverySent").mockImplementationOnce(async (input) => {
      if (mode === "acknowledgement lost") await write(input);
      throw new Error("database response lost");
    });
    const worker = new ChannelOutboundDeliveryWorker(h.options);
    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain();
    await worker.stop();
    expect(await h.store.getDelivery(h.delivery.id)).toMatchObject({
      status: "sent", sent: [{type: "text", externalMessageId: "receipt"}], attemptCount: 1,
    });
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.onTerminalFailure).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("keeps exhausted success-receipt failures unknown through startup without cleanup or resend", async () => {
    const h = await prepare();
    vi.spyOn(h.store, "markDeliverySent").mockRejectedValue(new Error("receipt write unavailable"));
    const worker = new ChannelOutboundDeliveryWorker(h.options);
    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain();
    await worker.stop();
    const restarted = new ChannelOutboundDeliveryWorker(h.options);
    await restarted.start({subscribeToNotifications: false});
    await restarted.triggerDrain();
    await restarted.stop();
    expect(await h.store.getDelivery(h.delivery.id)).toMatchObject({status: "unknown", attemptCount: 1});
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.onTerminalFailure).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining("sent receipt could not be confirmed")}), h.delivery.id);
  });

  it("preserves ambiguity after database outage prevents both receipt and unknown-state writes", async () => {
    const h = await prepare();
    vi.spyOn(h.store, "markDeliverySent").mockRejectedValue(new Error("database unavailable"));
    const markUnknown = vi.spyOn(h.store, "markDeliveryUnknown").mockRejectedValue(new Error("database unavailable"));
    const worker = new ChannelOutboundDeliveryWorker(h.options);
    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain();
    await worker.stop();
    expect(h.delivery.status).toBe("sending");
    markUnknown.mockRestore();
    const restarted = new ChannelOutboundDeliveryWorker(h.options);
    await restarted.start({subscribeToNotifications: false});
    await restarted.triggerDrain();
    await restarted.stop();
    expect(h.delivery.status).toBe("unknown");
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.onTerminalFailure).not.toHaveBeenCalled();
  });

  it("reports failure-receipt errors without treating them as a second transport attempt", async () => {
    const h = await prepare();
    h.send.mockRejectedValue(new Error("transport rejected"));
    vi.spyOn(h.store, "markDeliveryFailed").mockRejectedValue(new Error("failure receipt unavailable"));
    const worker = new ChannelOutboundDeliveryWorker(h.options);
    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain();
    await worker.stop();
    expect(h.delivery.status).toBe("unknown");
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.onTerminalFailure).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining("failed receipt could not be confirmed")}), h.delivery.id);
  });
});
