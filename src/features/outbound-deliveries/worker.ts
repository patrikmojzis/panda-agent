import type {ChannelOutboundAdapter, OutboundRequest} from "../channels/core/index.js";
import type {OutboundDeliveryStore} from "./store.js";
import type {OutboundDeliveryNotification, OutboundDeliveryWorkerLookup} from "./types.js";

export interface ChannelOutboundDeliveryWorkerOptions {
  store: OutboundDeliveryStore;
  adapter: ChannelOutboundAdapter;
  connectorKey: string;
  canSend?: () => boolean;
  onError?: (error: unknown, deliveryId?: string) => Promise<void> | void;
}

function isMatchingNotification(
  lookup: OutboundDeliveryWorkerLookup,
  notification: OutboundDeliveryNotification,
): boolean {
  return notification.channel === lookup.channel
    && notification.connectorKey === lookup.connectorKey;
}

function toRequest(delivery: Awaited<ReturnType<OutboundDeliveryStore["claimNextPendingDelivery"]>> extends infer T
  ? Exclude<T, null>
  : never): OutboundRequest {
  return {
    channel: delivery.channel,
    target: delivery.target,
    items: delivery.items,
  };
}

export class ChannelOutboundDeliveryWorker {
  private readonly store: OutboundDeliveryStore;
  private readonly adapter: ChannelOutboundAdapter;
  private readonly lookup: OutboundDeliveryWorkerLookup;
  private readonly canSend?: () => boolean;
  private readonly onError?: (error: unknown, deliveryId?: string) => Promise<void> | void;
  private unsubscribe: (() => Promise<void>) | null = null;
  private drainPromise: Promise<void> | null = null;
  private stopped = false;
  private pendingDrain = false;

  constructor(options: ChannelOutboundDeliveryWorkerOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.lookup = {
      channel: options.adapter.channel,
      connectorKey: options.connectorKey,
    };
    this.canSend = options.canSend;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.store.failSendingDeliveries(this.lookup, "Delivery worker stopped before completion.");
    this.unsubscribe = await this.store.listenPendingDeliveries(async (notification) => {
      if (!isMatchingNotification(this.lookup, notification)) {
        return;
      }

      await this.triggerDrain();
    });
    await this.triggerDrain();
  }

  async stop(): Promise<void> {
    this.stopped = true;

    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    if (unsubscribe) {
      await unsubscribe();
    }

    if (this.drainPromise) {
      await this.drainPromise;
    }
  }

  async triggerDrain(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.drainPromise) {
      this.pendingDrain = true;
      return;
    }

    this.drainPromise = this.drain();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
      if (this.pendingDrain && !this.stopped) {
        this.pendingDrain = false;
        await this.triggerDrain();
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.canSend && !this.canSend()) {
      return;
    }

    while (!this.stopped) {
      if (this.canSend && !this.canSend()) {
        return;
      }

      const delivery = await this.store.claimNextPendingDelivery(this.lookup);
      if (!delivery) {
        return;
      }

      try {
        const result = await this.adapter.send(toRequest(delivery));
        await this.store.markDeliverySent({
          id: delivery.id,
          sent: result.sent,
        });
      } catch (error) {
        await this.store.markDeliveryFailed({
          id: delivery.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.onError?.(error, delivery.id);
      }
    }
  }
}
