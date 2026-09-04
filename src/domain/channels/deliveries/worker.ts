import type {ChannelOutboundAdapter} from "../outbound.js";
import type {OutboundRequest} from "../types.js";
import {DrainLoop} from "../../../lib/drain-loop.js";
import type {
    CompleteDeliveryInput,
    DeliveryNotification,
    DeliveryWorkerLookup,
    FailDeliveryInput,
    OutboundDeliveryRecord
} from "./types.js";
import {isMatchingChannelNotification} from "../worker-shared.js";
import {settleChannelReceipt} from "../receipt-settlement.js";

export const DEFAULT_CHANNEL_OUTBOUND_DELIVERY_POLL_INTERVAL_MS = 15_000;

type ChannelOutboundDeliveryWorkerStore = {
  markSendingDeliveriesUnknown(lookup: DeliveryWorkerLookup, error: string): Promise<number>;
  getDelivery(id: string): Promise<OutboundDeliveryRecord>;
  listenPendingDeliveries?(
    listener: (notification: DeliveryNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
  claimNextPendingDelivery(lookup: DeliveryWorkerLookup): Promise<OutboundDeliveryRecord | null>;
  markDeliverySent(input: CompleteDeliveryInput): Promise<OutboundDeliveryRecord>;
  markDeliveryFailed(input: FailDeliveryInput): Promise<OutboundDeliveryRecord>;
  markDeliveryUnknown(input: FailDeliveryInput): Promise<OutboundDeliveryRecord>;
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
  pollIntervalMs?: number;
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
  private readonly drainLoop: DrainLoop;

  constructor(options: ChannelOutboundDeliveryWorkerOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.lookup = {
      channel: options.adapter.channel,
      connectorKey: options.connectorKey,
    };
    this.canSend = options.canSend;
    this.onError = options.onError;
    this.drainLoop = new DrainLoop({
      label: "Outbound delivery worker drain",
      drain: () => this.drain(),
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_CHANNEL_OUTBOUND_DELIVERY_POLL_INTERVAL_MS,
      onError: this.onError ? (error) => this.onError?.(error) : undefined,
    });
  }

  async start(options: ChannelOutboundDeliveryWorkerStartOptions = {}): Promise<void> {
    // Callers must already hold connector ownership before starting the worker.
    // An interrupted send has an unknown external outcome and must never replay.
    await this.store.markSendingDeliveriesUnknown(this.lookup, "Delivery worker stopped before its outcome was recorded.");
    if (options.subscribeToNotifications ?? true) {
      if (!this.store.listenPendingDeliveries) {
        throw new Error("Outbound delivery worker store does not support pending-delivery subscriptions.");
      }

      this.unsubscribe = await this.store.listenPendingDeliveries(async (notification) => {
        if (!isMatchingChannelNotification(this.lookup, notification)) {
          return;
        }

        this.drainLoop.kick();
      });
    }
    this.drainLoop.start();
  }

  async stop(): Promise<void> {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    if (unsubscribe) {
      await unsubscribe();
    }

    await this.drainLoop.stop();
  }

  async triggerDrain(): Promise<void> {
    await this.drainLoop.trigger();
  }

  private async drain(): Promise<void> {
    if (this.canSend && !this.canSend()) {
      return;
    }

    while (!this.drainLoop.isStopped) {
      if (this.canSend && !this.canSend()) {
        return;
      }

      const delivery = await this.store.claimNextPendingDelivery(this.lookup);
      if (!delivery) {
        return;
      }

      const claimToken = delivery.claimToken;
      if (!claimToken) throw new Error(`Outbound delivery ${delivery.id} has no claim token.`);
      const receipt = {
        label: "Outbound delivery",
        claimToken,
        read: () => this.store.getDelivery(delivery.id),
        markUnknown: (error: string) => this.store.markDeliveryUnknown({id: delivery.id, claimToken, error}),
      };
      let result;
      try {
        result = await this.adapter.send(toRequest(delivery));
      } catch (error) {
        try {
          await settleChannelReceipt({
            ...receipt,
            status: "failed",
            write: () => this.store.markDeliveryFailed({
              id: delivery.id,
              claimToken,
              error: error instanceof Error ? error.message : String(error),
            }),
          });
        } catch (receiptError) {
          await this.onError?.(receiptError, delivery.id);
          await this.onError?.(error, delivery.id);
          continue;
        }
        try {
          await this.adapter.onTerminalFailure?.(toRequest(delivery));
        } catch (cleanupError) {
          await this.onError?.(cleanupError, delivery.id);
        }
        await this.onError?.(error, delivery.id);
        continue;
      }
      try {
        await settleChannelReceipt({
          ...receipt,
          status: "sent",
          write: () => this.store.markDeliverySent({id: delivery.id, claimToken, sent: result.sent}),
        });
      } catch (receiptError) {
        await this.onError?.(receiptError, delivery.id);
      }
    }
  }
}
