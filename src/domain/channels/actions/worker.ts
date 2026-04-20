import type {ActionNotification, ActionWorkerLookup, ChannelActionRecord} from "./types.js";

type ChannelActionWorkerStore = {
  failSendingActions(lookup: ActionWorkerLookup, error: string): Promise<number>;
  listenPendingActions?(
    listener: (notification: ActionNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
  claimNextPendingAction(lookup: ActionWorkerLookup): Promise<ChannelActionRecord | null>;
  markActionSent(id: string): Promise<ChannelActionRecord>;
  markActionFailed(id: string, error: string): Promise<ChannelActionRecord>;
};

export interface ChannelActionWorkerStartOptions {
  subscribeToNotifications?: boolean;
}

export interface ChannelActionWorkerOptions {
  store: ChannelActionWorkerStore;
  lookup: ActionWorkerLookup;
  dispatch(action: ChannelActionRecord): Promise<void>;
  onError?: (error: unknown, actionId?: string) => Promise<void> | void;
}

function isMatchingNotification(
  lookup: ActionWorkerLookup,
  notification: ActionNotification,
): boolean {
  return notification.channel === lookup.channel
    && notification.connectorKey === lookup.connectorKey;
}

export class ChannelActionWorker {
  private readonly store: ChannelActionWorkerStore;
  private readonly lookup: ActionWorkerLookup;
  private readonly dispatchAction: (action: ChannelActionRecord) => Promise<void>;
  private readonly onError?: (error: unknown, actionId?: string) => Promise<void> | void;
  private unsubscribe: (() => Promise<void>) | null = null;
  private drainPromise: Promise<void> | null = null;
  private stopped = false;
  private pendingDrain = false;

  constructor(options: ChannelActionWorkerOptions) {
    this.store = options.store;
    this.lookup = options.lookup;
    this.dispatchAction = options.dispatch;
    this.onError = options.onError;
  }

  async start(options: ChannelActionWorkerStartOptions = {}): Promise<void> {
    this.stopped = false;
    await this.store.failSendingActions(this.lookup, "Channel action worker stopped before completion.");
    if (options.subscribeToNotifications ?? true) {
      if (!this.store.listenPendingActions) {
        throw new Error("Channel action worker store does not support pending-action subscriptions.");
      }

      this.unsubscribe = await this.store.listenPendingActions(async (notification) => {
        if (!isMatchingNotification(this.lookup, notification)) {
          return;
        }

        await this.triggerDrain();
      });
    }
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
    while (!this.stopped) {
      const action = await this.store.claimNextPendingAction(this.lookup);
      if (!action) {
        return;
      }

      try {
        await this.dispatchAction(action);
        await this.store.markActionSent(action.id);
      } catch (error) {
        await this.store.markActionFailed(action.id, error instanceof Error ? error.message : String(error));
        await this.onError?.(error, action.id);
      }
    }
  }
}
