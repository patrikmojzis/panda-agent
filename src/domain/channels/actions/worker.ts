import type {ActionNotification, ActionWorkerLookup, ChannelActionRecord} from "./types.js";
import {isMatchingChannelNotification} from "../worker-shared.js";
import {DrainLoop} from "../../../lib/drain-loop.js";

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

export class ChannelActionWorker {
  private readonly store: ChannelActionWorkerStore;
  private readonly lookup: ActionWorkerLookup;
  private readonly dispatchAction: (action: ChannelActionRecord) => Promise<void>;
  private readonly onError?: (error: unknown, actionId?: string) => Promise<void> | void;
  private unsubscribe: (() => Promise<void>) | null = null;
  private readonly drainLoop: DrainLoop;

  constructor(options: ChannelActionWorkerOptions) {
    this.store = options.store;
    this.lookup = options.lookup;
    this.dispatchAction = options.dispatch;
    this.onError = options.onError;
    this.drainLoop = new DrainLoop({
      label: "Channel action worker drain",
      drain: () => this.drain(),
      onError: this.onError ? (error) => this.onError?.(error) : undefined,
    });
  }

  async start(options: ChannelActionWorkerStartOptions = {}): Promise<void> {
    await this.store.failSendingActions(this.lookup, "Channel action worker stopped before completion.");
    if (options.subscribeToNotifications ?? true) {
      if (!this.store.listenPendingActions) {
        throw new Error("Channel action worker store does not support pending-action subscriptions.");
      }

      this.unsubscribe = await this.store.listenPendingActions(async (notification) => {
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
    while (!this.drainLoop.isStopped) {
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
