import {describe, expect, it, vi} from "vitest";

import {
  createConnectorOutboundWorker,
  startConnectorWorkerRuntime,
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
    triggerDrain: vi.fn(async () => {}),
  };
}

describe("connector worker runtime", () => {
  it("creates outbound workers with consistent connector error logging", async () => {
    const log = vi.fn();
    let claimed = false;
    const delivery = {
      id: "delivery-1",
      claimToken: "claim-1",
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
      markSendingDeliveriesUnknown: vi.fn(async () => 0),
      claimNextPendingDelivery: vi.fn(async () => {
        if (claimed) {
          return null;
        }

        claimed = true;
        return delivery;
      }),
      getDelivery: vi.fn(async () => delivery),
      markDeliveryUnknown: vi.fn(async () => delivery),
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
      claimToken: "claim-1",
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

  it("starts under a connector lease and unregisters before stopping workers and lease", async () => {
    const order: string[] = [];
    const lease = {
      release: vi.fn(async () => {
        order.push("lease:release");
      }),
    };
    const notificationRouter = {
      register: vi.fn(() => {
        order.push("notifications:register");
        return {unregister: () => order.push("notifications:unregister")};
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
      connectorKey: "bot-1",
      notificationRouter,
    });
    await stopConnectorWorkerRuntime(handle);

    expect(order).toEqual([
      "lease:acquire",
      "outbound:start:false",
      "action:start:false",
      "notifications:register",
      "notifications:unregister",
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
      connectorKey: "bot-1",
      notificationRouter: {register: vi.fn()},
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

  it.each(["sync", "async"])("releases the lease when the %s cleanup reporter fails for multiple workers", async (mode) => {
    const order: string[] = [];
    const actionError = new Error("action stop failed");
    const outboundError = new Error("outbound stop failed");
    const reporterError = new Error("first reporter failed");
    const actionWorker = createWorker("action", order);
    const outboundWorker = createWorker("outbound", order);
    actionWorker.stop.mockImplementationOnce(async () => { order.push("action:stop"); throw actionError; });
    outboundWorker.stop.mockImplementationOnce(async () => { order.push("outbound:stop"); throw outboundError; });
    let released = false;
    const handle = {
      notificationRegistration: {unregister: () => { order.push("unregister"); }},
      actionWorker,
      outboundWorker,
      lease: {release: async () => { released = true; order.push("lease:release"); }},
    };
    const onError = vi.fn((step: {label: string}) => {
      order.push(`report:${step.label}`);
      const failure = step.label === "action-worker" ? reporterError : new Error("later reporter failed");
      if (mode === "async") return Promise.reject(failure);
      throw failure;
    });

    await expect(stopConnectorWorkerRuntime(handle, onError)).rejects.toBe(reporterError);

    expect(released).toBe(true);
    expect(order).toEqual(["unregister", "action:stop", "report:action-worker", "outbound:stop", "report:outbound-worker", "lease:release"]);
    expect(onError).toHaveBeenNthCalledWith(1, {label: "action-worker"}, actionError);
    expect(onError).toHaveBeenNthCalledWith(2, {label: "outbound-worker"}, outboundError);
  });

  it("reports cleanup failures while continuing through remaining resources", async () => {
    const order: string[] = [];
    const onCleanupError = vi.fn();
    const handle = {
      notificationRegistration: {
        unregister: vi.fn(() => {
          order.push("registration:unregister");
          throw new Error("unregister failed");
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
      "registration:unregister",
      "action:stop",
      "outbound:stop",
      "lease:release",
    ]);
    expect(onCleanupError).toHaveBeenCalledWith(
      {label: "notification-registration"},
      expect.objectContaining({message: "unregister failed"}),
    );
  });
});
