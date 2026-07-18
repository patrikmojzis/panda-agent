import {EventEmitter} from "node:events";

import {describe, expect, it, vi} from "vitest";

import {
  createConnectorOutboundWorker,
  startConnectorWorkerRuntime,
  startConnectorWorkerNotificationListener,
  stopConnectorWorkerRuntime,
} from "../src/integrations/channels/worker-runtime.js";

function createWorker(label: string, order: string[]) {
  return {
    start: vi.fn(async (options?: {subscribeToNotifications?: boolean}) => {
      order.push(`${label}:start:${String(options?.subscribeToNotifications)}`);
    }),
    stop: vi.fn(async () => {
      order.push(`${label}:stop`);
    }),
  };
}

async function flushBackgroundHandlers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("connector worker runtime", () => {
  it("creates outbound workers with consistent connector error logging", async () => {
    const log = vi.fn();
    let claimed = false;
    const delivery = {
      id: "delivery-1",
      status: "pending" as const,
      attemptCount: 0,
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "telegram-bot",
        externalConversationId: "chat-1",
      },
      items: [
        {
          type: "text" as const,
          text: "hello",
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    const store = {
      failSendingDeliveries: vi.fn(async () => 0),
      claimNextPendingDelivery: vi.fn(async () => {
        if (claimed) {
          return null;
        }

        claimed = true;
        return delivery;
      }),
      markDeliverySent: vi.fn(),
      markDeliveryFailed: vi.fn(async (input: {id: string; error: string}) => ({
        ...delivery,
        id: input.id,
        status: "failed" as const,
        lastError: input.error,
      })),
    };
    const onTerminalFailure = vi.fn(async () => undefined);
    const worker = createConnectorOutboundWorker({
      store,
      adapter: {
        channel: "telegram",
        send: vi.fn(async () => {
          throw new Error("send failed");
        }),
        onTerminalFailure,
      },
      connectorKey: "telegram-bot",
      log,
    });

    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain();
    await worker.stop();

    expect(store.markDeliveryFailed).toHaveBeenCalledWith({
      id: "delivery-1",
      error: "send failed",
    });
    expect(onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-1",
      channel: "telegram",
    }));
    expect(log).toHaveBeenCalledWith("outbound_delivery_failed", {
      connectorKey: "telegram-bot",
      deliveryId: "delivery-1",
      message: "send failed",
    });
  });

  it("logs notification listener errors and reports reconnecting state without connector recovery", async () => {
    const log = vi.fn();
    const onListenerError = vi.fn();
    const onListenerStateChange = vi.fn();
    const client = new EventEmitter() as EventEmitter & {
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    };
    client.query = vi.fn(async () => ({rows: []}));
    client.release = vi.fn();
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({rows: []})),
    };

    const listener = await startConnectorWorkerNotificationListener({
      pool,
      source: "telegram",
      connectorKey: "telegram-bot",
      actionWorker: {
        triggerDrain: vi.fn(),
      },
      outboundWorker: {
        triggerDrain: vi.fn(),
      },
      log,
      onListenerError,
      onListenerStateChange,
    });

    client.emit("error", new Error("listen failed"));
    await flushBackgroundHandlers();
    await listener.close();

    expect(log).toHaveBeenCalledWith("worker_notification_listener_failed", {
      connectorKey: "telegram-bot",
      message: "listen failed",
    });
    expect(onListenerError).toHaveBeenCalledWith(expect.objectContaining({
      message: "listen failed",
    }));
    expect(onListenerStateChange).toHaveBeenCalledWith(expect.objectContaining({
      status: "reconnecting",
      listening: false,
      lastError: "listen failed",
    }));
  });

  it("starts under a connector lease and stops listener, workers, then lease", async () => {
    const order: string[] = [];
    const lease = {
      release: vi.fn(async () => {
        order.push("lease:release");
      }),
    };
    const listener = {
      close: vi.fn(async () => {
        order.push("listener:close");
      }),
    };
    const outboundWorker = createWorker("outbound", order);
    const actionWorker = createWorker("action", order);

    const handle = await startConnectorWorkerRuntime({
      acquireLease: vi.fn(async () => {
        order.push("lease:acquire");
        return lease;
      }),
      outboundWorker,
      actionWorker,
      startNotificationListener: vi.fn(async () => {
        order.push("listener:start");
        return listener;
      }),
    });
    await stopConnectorWorkerRuntime(handle);

    expect(order).toEqual([
      "lease:acquire",
      "outbound:start:false",
      "action:start:false",
      "listener:start",
      "listener:close",
      "action:stop",
      "outbound:stop",
      "lease:release",
    ]);
  });

  it("cleans up acquired resources when worker startup fails", async () => {
    const order: string[] = [];
    const onCleanupError = vi.fn();
    const lease = {
      release: vi.fn(async () => {
        order.push("lease:release");
      }),
    };
    const outboundWorker = createWorker("outbound", order);
    const actionWorker = createWorker("action", order);
    actionWorker.start.mockImplementationOnce(async () => {
      order.push("action:start");
      throw new Error("action worker failed");
    });

    await expect(startConnectorWorkerRuntime({
      acquireLease: vi.fn(async () => {
        order.push("lease:acquire");
        return lease;
      }),
      outboundWorker,
      actionWorker,
      startNotificationListener: vi.fn(async () => {
        throw new Error("listener should not start");
      }),
      onCleanupError,
    })).rejects.toThrow("action worker failed");

    expect(order).toEqual([
      "lease:acquire",
      "outbound:start:false",
      "action:start",
      "action:stop",
      "outbound:stop",
      "lease:release",
    ]);
    expect(onCleanupError).not.toHaveBeenCalled();
  });

  it("reports cleanup failures while continuing through remaining resources", async () => {
    const order: string[] = [];
    const onCleanupError = vi.fn();
    const handle = {
      notificationListener: {
        close: vi.fn(async () => {
          order.push("listener:close");
          throw new Error("listener close failed");
        }),
      },
      actionWorker: createWorker("action", order),
      outboundWorker: createWorker("outbound", order),
      lease: {
        release: vi.fn(async () => {
          order.push("lease:release");
        }),
      },
    };

    await stopConnectorWorkerRuntime(handle, onCleanupError);

    expect(order).toEqual([
      "listener:close",
      "action:stop",
      "outbound:stop",
      "lease:release",
    ]);
    expect(onCleanupError).toHaveBeenCalledWith(
      {label: "notification-listener"},
      expect.objectContaining({message: "listener close failed"}),
    );
  });
});
