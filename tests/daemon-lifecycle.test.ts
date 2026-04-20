import {describe, expect, it, vi} from "vitest";

import {createDaemonLifecycle} from "../src/app/runtime/daemon-lifecycle.js";

describe("createDaemonLifecycle", () => {
  it("acquires the daemon lease before starting workers and releases it on stop", async () => {
    const order: string[] = [];
    const processRequest = vi.fn(async () => undefined);
    let lifecycle!: ReturnType<typeof createDaemonLifecycle>;
    const context = {
      daemonKey: "primary",
      connectorLeases: {
        tryAcquire: vi.fn(async () => {
          order.push("lease");
          return {
            source: "daemon",
            connectorKey: "primary",
            holderId: "holder-a",
            leasedUntil: Date.now() + 30_000,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        }),
        renew: vi.fn(async () => null),
        release: vi.fn(async () => {
          order.push("release");
          return true;
        }),
      },
      daemonState: {
        heartbeat: vi.fn(async () => {
          order.push("heartbeat");
          return {
            daemonKey: "primary",
            heartbeatAt: Date.now(),
            startedAt: Date.now(),
            updatedAt: Date.now(),
          };
        }),
      },
      requests: {
        claimNextPendingRequest: vi.fn(async () => null),
        listenPendingRequests: vi.fn(async () => {
          order.push("listen");
          return async () => {
            order.push("unlisten");
          };
        }),
      },
      a2aOutboundWorker: {
        start: vi.fn(async () => {
          order.push("a2a-start");
        }),
        stop: vi.fn(async () => {
          order.push("a2a-stop");
        }),
      },
      scheduledTaskRunner: {
        start: vi.fn(async () => {
          order.push("tasks-start");
        }),
        stop: vi.fn(async () => {
          order.push("tasks-stop");
        }),
      },
      watchRunner: {
        start: vi.fn(async () => {
          order.push("watch-start");
        }),
        stop: vi.fn(async () => {
          order.push("watch-stop");
        }),
      },
      relationshipHeartbeatRunner: {
        start: vi.fn(async () => {
          order.push("heartbeat-start");
        }),
        stop: vi.fn(async () => {
          order.push("heartbeat-stop");
        }),
      },
      runtime: {
        close: vi.fn(async () => {
          order.push("runtime-close");
        }),
        coordinator: {
          recoverOrphanedRuns: vi.fn(async () => {
            order.push("recover");
            await lifecycle.stop();
          }),
        },
      },
    } as any;

    lifecycle = createDaemonLifecycle({
      context,
      processRequest,
    });

    await lifecycle.run();

    expect(order).toEqual([
      "lease",
      "heartbeat",
      "listen",
      "a2a-start",
      "tasks-start",
      "watch-start",
      "heartbeat-start",
      "recover",
      "unlisten",
      "a2a-stop",
      "tasks-stop",
      "watch-stop",
      "heartbeat-stop",
      "release",
      "runtime-close",
    ]);
    expect(processRequest).not.toHaveBeenCalled();
  });
});
