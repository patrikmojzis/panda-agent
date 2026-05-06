import type {ChannelOutboundAdapter} from "../outbound.js";
import type {OutboundRequest} from "../types.js";
import {runInBackground} from "../../../lib/async.js";
import type {
    CompleteDeliveryInput,
    DeliveryNotification,
    DeliveryWorkerLookup,
    FailDeliveryInput,
    OutboundDeliveryRecord
} from "./types.js";
import {isMatchingChannelNotification} from "../worker-shared.js";

type ChannelOutboundDeliveryWorkerStore = {
  failSendingDeliveries(lookup: DeliveryWorkerLookup, error: string): Promise<number>;
  listenPendingDeliveries?(
    listener: (notification: DeliveryNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
  claimNextPendingDelivery(lookup: DeliveryWorkerLookup): Promise<OutboundDeliveryRecord | null>;
  markDeliverySent(input: CompleteDeliveryInput): Promise<OutboundDeliveryRecord>;
  markDeliveryFailed(input: FailDeliveryInput): Promise<OutboundDeliveryRecord>;
};

export interface ChannelOutboundDeliveryWorkerStartOptions {
  subscribeToNotifications?: boolean;
}

export interface ChannelOutboundDeliveryWorkerOptions {
  store: ChannelOutboundDeliveryWorkerStore;
  adapter: ChannelOutboundAdapter;
  connectorKey: string;
  canSend?: () => boolean;
  onError?: (error: unknown, deliveryId?: string) => Promise<void> | void;
}

function toRequest(delivery: OutboundDeliveryRecord): OutboundRequest {
  return {
    deliveryId: delivery.id,
    threadId: delivery.threadId,
    channel: delivery.channel,
    target: delivery.target,
    items: delivery.items,
    metadata: delivery.metadata,
  };
}

export class ChannelOutboundDeliveryWorker {
  private readonly store: ChannelOutboundDeliveryWorkerStore;
  private readonly adapter: ChannelOutboundAdapter;
  private readonly lookup: DeliveryWorkerLookup;
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

  async start(options: ChannelOutboundDeliveryWorkerStartOptions = {}): Promise<void> {
    this.stopped = false;
    // Callers must already hold connector ownership before starting the worker.
    // start() recovers stale `sending` rows, then lets pending work drain in the background.
    await this.store.failSendingDeliveries(this.lookup, "Delivery worker stopped before completion.");
    if (options.subscribeToNotifications ?? true) {
      if (!this.store.listenPendingDeliveries) {
        throw new Error("Outbound delivery worker store does not support pending-delivery subscriptions.");
      }

      this.unsubscribe = await this.store.listenPendingDeliveries(async (notification) => {
        if (!isMatchingChannelNotification(this.lookup, notification)) {
          return;
        }

        this.kickDrain();
      });
    }
    this.kickDrain();
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

  private kickDrain(): void {
    runInBackground(() => this.triggerDrain(), {
      label: "Outbound delivery worker drain",
      onError: this.onError ? (error) => this.onError?.(error) : undefined,
    });
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
