import type {ActionNotification, ActionWorkerLookup, ChannelActionRecord} from "./types.js";
import {isMatchingChannelNotification} from "../worker-shared.js";
import {DrainLoop} from "../../../lib/drain-loop.js";

export const DEFAULT_CHANNEL_ACTION_POLL_INTERVAL_MS = 15_000;

export type ChannelActionDrainCause = "startup" | "notification" | "listener_reconnect" | "poll";

export type ChannelActionWorkerEvent = {
  type: "expired_before_dispatch" | "recovered_by_poll";
  action: ChannelActionRecord;
  ageMs: number;
  cause: ChannelActionDrainCause;
};

type ChannelActionWorkerStore = {
  failSendingActions(lookup: ActionWorkerLookup, error: string): Promise<number>;
  listenPendingActions?(
    listener: (notification: ActionNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
  claimNextPendingAction(lookup: ActionWorkerLookup): Promise<ChannelActionRecord | null>;
  markActionSent(id: string): Promise<ChannelActionRecord>;
  markActionFailed(id: string, error: string): Promise<ChannelActionRecord>;
  expireActionIfDue(id: string): Promise<ChannelActionRecord | null>;
};

export interface ChannelActionWorkerStartOptions {
  subscribeToNotifications?: boolean;
}

export interface ChannelActionWorkerOptions {
  store: ChannelActionWorkerStore;
  lookup: ActionWorkerLookup;
  dispatch(action: ChannelActionRecord): Promise<void>;
  onError?: (error: unknown, actionId?: string) => Promise<void> | void;
  onEvent?: (event: ChannelActionWorkerEvent) => Promise<void> | void;
  pollIntervalMs?: number;
}

export class ChannelActionWorker {
  private readonly store: ChannelActionWorkerStore;
  private readonly lookup: ActionWorkerLookup;
  private readonly dispatchAction: (action: ChannelActionRecord) => Promise<void>;
  private readonly onError?: (error: unknown, actionId?: string) => Promise<void> | void;
  private readonly onEvent?: (event: ChannelActionWorkerEvent) => Promise<void> | void;
  private readonly pendingDrainCauses = new Set<ChannelActionDrainCause>();
  private unsubscribe: (() => Promise<void>) | null = null;
  private readonly drainLoop: DrainLoop;

  constructor(options: ChannelActionWorkerOptions) {
    this.store = options.store;
    this.lookup = options.lookup;
    this.dispatchAction = options.dispatch;
    this.onError = options.onError;
    this.onEvent = options.onEvent;
    this.drainLoop = new DrainLoop({
      label: "Channel action worker drain",
      drain: () => this.drain(),
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_CHANNEL_ACTION_POLL_INTERVAL_MS,
      onPoll: () => this.pendingDrainCauses.add("poll"),
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

        this.pendingDrainCauses.add("notification");
        this.drainLoop.kick();
      });
    }
    this.pendingDrainCauses.add("startup");
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

  async triggerDrain(cause: ChannelActionDrainCause = "notification"): Promise<void> {
    this.pendingDrainCauses.add(cause);
    await this.drainLoop.trigger();
  }

  private async drain(): Promise<void> {
    const cause = this.consumeDrainCause();
    while (!this.drainLoop.isStopped) {
      const action = await this.store.claimNextPendingAction(this.lookup);
      if (!action) {
        return;
      }

      const now = Date.now();
      if (action.expiresAt !== undefined) {
        const expired = await this.store.expireActionIfDue(action.id);
        if (expired) {
          await this.emitEvent({
            type: "expired_before_dispatch",
            action: expired,
            ageMs: Math.max(0, now - action.createdAt),
            cause,
          });
          continue;
        }
      }

      if (cause === "poll") {
        await this.emitEvent({
          type: "recovered_by_poll",
          action,
          ageMs: Math.max(0, now - action.createdAt),
          cause,
        });
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

  private consumeDrainCause(): ChannelActionDrainCause {
    for (const cause of ["notification", "listener_reconnect", "startup", "poll"] as const) {
      if (this.pendingDrainCauses.delete(cause)) {
        this.pendingDrainCauses.clear();
        return cause;
      }
    }
    return "notification";
  }

  private async emitEvent(event: ChannelActionWorkerEvent): Promise<void> {
    try {
      await this.onEvent?.(event);
    } catch (error) {
      try {
        await this.onError?.(error, event.action.id);
      } catch {
        // Observability must not strand a claimed action.
      }
    }
  }
}
