import type {PostgresGatewayStore} from "../../domain/gateway/postgres.js";
import {
  buildGatewayDeviceCommandNotificationChannel,
  parseGatewayDeviceCommandNotification,
  type GatewayDeviceCommandNotification,
} from "../../domain/gateway/device-command-notifications.js";
import type {
  GatewayDeviceCommandClaimResult,
  GatewayDeviceCommandKind,
} from "../../domain/gateway/types.js";
import {listenPostgresChannel} from "../../lib/postgres-listen.js";
import type {PgListenClient, PgPoolLike} from "../../lib/postgres-query.js";

export const DEFAULT_GATEWAY_DEVICE_COMMAND_MAX_WAITERS = 256;

type ClaimStore = Pick<PostgresGatewayStore, "claimNextDeviceCommand">;
type WaitOutcome = "aborted" | "closed" | "notified" | "timeout";

interface PendingWaiter {
  pendingNotification: boolean;
  resolve?: () => void;
}

export type GatewayDeviceCommandWaitErrorReason = "closed" | "duplicate" | "overloaded";

export class GatewayDeviceCommandWaitError extends Error {
  constructor(
    readonly reason: GatewayDeviceCommandWaitErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "GatewayDeviceCommandWaitError";
  }
}

export interface GatewayDeviceCommandWaiter {
  claimOrWait(input: {
    sourceId: string;
    deviceId: string;
    allowedKinds: readonly GatewayDeviceCommandKind[];
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<GatewayDeviceCommandClaimResult>;
  close(): Promise<void>;
  notify(notification: GatewayDeviceCommandNotification): void;
}

export type GatewayDeviceCommandClaimer = Pick<GatewayDeviceCommandWaiter, "claimOrWait">;

function waiterKey(sourceId: string, deviceId: string): string {
  return JSON.stringify([sourceId, deviceId]);
}

class DefaultGatewayDeviceCommandWaiter implements GatewayDeviceCommandWaiter {
  private readonly maxWaiters: number;
  private readonly pending = new Map<string, PendingWaiter>();
  private readonly store: ClaimStore;
  private listener?: {close(): Promise<void>};
  private closed = false;

  constructor(options: {
    maxWaiters?: number;
    store: ClaimStore;
  }) {
    this.maxWaiters = Math.max(1, Math.floor(
      options.maxWaiters ?? DEFAULT_GATEWAY_DEVICE_COMMAND_MAX_WAITERS,
    ));
    this.store = options.store;
  }

  attachListener(listener: {close(): Promise<void>}): void {
    if (this.listener) {
      throw new Error("Gateway device command waiter already has a notification listener.");
    }
    this.listener = listener;
  }

  notify(notification: GatewayDeviceCommandNotification): void {
    const waiter = this.pending.get(waiterKey(notification.sourceId, notification.deviceId));
    if (!waiter) {
      return;
    }
    waiter.pendingNotification = true;
    waiter.resolve?.();
  }

  wakeAll(): void {
    for (const waiter of this.pending.values()) {
      waiter.pendingNotification = true;
      waiter.resolve?.();
    }
  }

  async claimOrWait(input: {
    sourceId: string;
    deviceId: string;
    allowedKinds: readonly GatewayDeviceCommandKind[];
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<GatewayDeviceCommandClaimResult> {
    if (this.closed) {
      throw new GatewayDeviceCommandWaitError("closed", "Gateway device command waiter is closed.");
    }

    const key = waiterKey(input.sourceId, input.deviceId);
    if (this.pending.has(key)) {
      throw new GatewayDeviceCommandWaitError(
        "duplicate",
        `Gateway device ${input.deviceId} already has an active command claim request.`,
      );
    }
    if (this.pending.size >= this.maxWaiters) {
      throw new GatewayDeviceCommandWaitError(
        "overloaded",
        "Gateway device command waiter capacity is exhausted.",
      );
    }

    const waiter: PendingWaiter = {pendingNotification: false};
    this.pending.set(key, waiter);
    const deadline = Date.now() + Math.max(0, Math.floor(input.waitMs));
    try {
      let claimed = await this.claim(input);
      if (claimed.claimed || input.signal?.aborted || deadline <= Date.now()) {
        return claimed;
      }

      while (true) {
        const outcome = await this.waitForNotification(waiter, deadline, input.signal);
        if (outcome === "aborted") {
          return {claimed: false};
        }

        claimed = await this.claim(input);
        if (claimed.claimed || outcome === "closed" || outcome === "timeout") {
          return claimed;
        }
      }
    } finally {
      this.pending.delete(key);
      waiter.resolve?.();
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.pending.values()) {
      waiter.resolve?.();
    }
    await this.listener?.close();
  }

  private claim(input: {
    sourceId: string;
    deviceId: string;
    allowedKinds: readonly GatewayDeviceCommandKind[];
  }): Promise<GatewayDeviceCommandClaimResult> {
    return this.store.claimNextDeviceCommand({
      sourceId: input.sourceId,
      deviceId: input.deviceId,
      allowedKinds: input.allowedKinds,
    });
  }

  private async waitForNotification(
    waiter: PendingWaiter,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<WaitOutcome> {
    if (signal?.aborted) {
      return "aborted";
    }
    if (this.closed) {
      return "closed";
    }
    if (waiter.pendingNotification) {
      waiter.pendingNotification = false;
      return "notified";
    }

    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) {
      return "timeout";
    }

    return new Promise<WaitOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: WaitOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiter.resolve = undefined;
        if (outcome === "notified") {
          waiter.pendingNotification = false;
        }
        resolve(outcome);
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), remainingMs);
      timer.unref?.();
      waiter.resolve = () => finish(this.closed ? "closed" : "notified");
      signal?.addEventListener("abort", onAbort, {once: true});
    });
  }
}

export function createGatewayDeviceCommandWaiter(options: {
  maxWaiters?: number;
  store: ClaimStore;
}): GatewayDeviceCommandWaiter {
  return new DefaultGatewayDeviceCommandWaiter(options);
}

export async function startGatewayDeviceCommandWaiter(options: {
  maxWaiters?: number;
  pool: PgPoolLike<PgListenClient>;
  store: ClaimStore;
}): Promise<GatewayDeviceCommandWaiter> {
  const waiter = new DefaultGatewayDeviceCommandWaiter(options);
  const closeListener = await listenPostgresChannel<GatewayDeviceCommandNotification>({
    pool: options.pool,
    channel: buildGatewayDeviceCommandNotificationChannel(),
    label: "Gateway device command notification listener",
    parse: (payload) => typeof payload === "string"
      ? parseGatewayDeviceCommandNotification(payload)
      : null,
    listener: (notification) => waiter.notify(notification),
    onError: (error) => {
      console.error("Gateway device command notification listener failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onStateChange: (snapshot) => {
      if (snapshot.status === "listening") {
        waiter.wakeAll();
      }
    },
  });
  waiter.attachListener({close: closeListener});
  return waiter;
}
