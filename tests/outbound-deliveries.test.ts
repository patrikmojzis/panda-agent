import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import type {ChannelOutboundAdapter, OutboundRequest, OutboundResult} from "../src/domain/channels/index.js";
import {
    ChannelOutboundDeliveryWorker,
    PostgresOutboundDeliveryStore,
} from "../src/domain/channels/deliveries/index.js";
import type {OutboundDeliveryStore} from "../src/domain/channels/deliveries/store.js";
import type {
    CompleteDeliveryInput,
    DeliveryNotification,
    DeliveryWorkerLookup,
    FailDeliveryInput,
    OutboundDeliveryInput,
    OutboundDeliveryRecord,
} from "../src/domain/channels/deliveries/types.js";

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

    const store = new PostgresOutboundDeliveryStore({ pool });
    await store.ensureSchema();

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

    const store = new PostgresOutboundDeliveryStore({ pool });
    await store.ensureSchema();

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

class MemoryDeliveryStore implements OutboundDeliveryStore {
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
    await worker.stop();

    expect(send).toHaveBeenCalledTimes(1);
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
    await worker.stop();

    expect(send).toHaveBeenCalledTimes(1);
    expect(store.deliveries[0]).toMatchObject({
      status: "failed",
      lastError: "socket unavailable",
      attemptCount: 1,
    });
  });
});
