import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import type {ChannelOutboundAdapter, OutboundRequest, OutboundResult} from "../src/domain/channels/index.js";
import {
    ChannelOutboundDeliveryWorker,
    PostgresOutboundDeliveryStore,
} from "../src/domain/channels/deliveries/index.js";
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
    await store.ensureSchema();
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
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{ type: "text", text: "hello" }],
    });

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
      sent: [{ type: "text", externalMessageId: "101" }],
    });
    expect(sent).toMatchObject({
      id: delivery.id,
      status: "sent",
      sent: [{ type: "text", externalMessageId: "101" }],
    });
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
    await store.ensureSchema();
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
    await store.ensureSchema();

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
    await store.ensureSchema();

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
    await store.ensureSchema();
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

  it("marks abandoned sending deliveries as failed", async () => {
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
    await store.ensureSchema();
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
    const recovered = await store.failSendingDeliveries({
      channel: "whatsapp",
      connectorKey: "wa-1",
    }, "worker died");

    expect(recovered).toBe(1);
    await expect(store.getDelivery(delivery.id)).resolves.toMatchObject({
      status: "failed",
      lastError: "worker died",
    });
  });
});

class MemoryDeliveryStore {
  deliveries: OutboundDeliveryRecord[] = [];
  listener: ((notification: DeliveryNotification) => Promise<void> | void) | null = null;
  counter = 0;

  async ensureSchema(): Promise<void> {}

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

  async failSendingDeliveries(lookup: DeliveryWorkerLookup, error: string): Promise<number> {
    let count = 0;
    for (const delivery of this.deliveries) {
      if (
        delivery.status === "sending"
        && delivery.channel === lookup.channel
        && delivery.target.connectorKey === lookup.connectorKey
      ) {
        delivery.status = "failed";
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
