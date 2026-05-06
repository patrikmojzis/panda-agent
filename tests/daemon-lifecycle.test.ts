import {createServer} from "node:net";

import {describe, expect, it, vi} from "vitest";

import {createDaemonLifecycle} from "../src/app/runtime/daemon-lifecycle.js";

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate test port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return address.port;
}

describe("createDaemonLifecycle", () => {
  it("acquires the daemon lease before starting workers and releases it on stop", async () => {
    const previousAppsPort = process.env.PANDA_APPS_PORT;
    const previousHealthPort = process.env.PANDA_CORE_HEALTH_PORT;
    process.env.PANDA_APPS_PORT = "0";
    delete process.env.PANDA_CORE_HEALTH_PORT;

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
      emailOutboundWorker: {
        start: vi.fn(async () => {
          order.push("email-outbound-start");
        }),
        stop: vi.fn(async () => {
          order.push("email-outbound-stop");
        }),
      },
      emailSyncRunner: {
        start: vi.fn(async () => {
          order.push("email-sync-start");
        }),
        stop: vi.fn(async () => {
          order.push("email-sync-stop");
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
          await lifecycle.stop();
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
          }),
        },
      },
    } as any;

    lifecycle = createDaemonLifecycle({
      context,
      processRequest,
    });

    try {
      await lifecycle.run();

      expect(order).toEqual([
        "lease",
        "heartbeat",
        "listen",
        "recover",
        "a2a-start",
        "email-outbound-start",
        "email-sync-start",
        "tasks-start",
        "watch-start",
        "heartbeat-start",
        "unlisten",
        "a2a-stop",
        "email-outbound-stop",
        "email-sync-stop",
        "tasks-stop",
        "watch-stop",
        "heartbeat-stop",
        "release",
        "runtime-close",
      ]);
      expect(processRequest).not.toHaveBeenCalled();
    } finally {
      if (previousAppsPort === undefined) {
        delete process.env.PANDA_APPS_PORT;
      } else {
        process.env.PANDA_APPS_PORT = previousAppsPort;
      }

      if (previousHealthPort === undefined) {
        delete process.env.PANDA_CORE_HEALTH_PORT;
      } else {
        process.env.PANDA_CORE_HEALTH_PORT = previousHealthPort;
      }
    }
  });

  it("keeps cleaning up even when an earlier shutdown step fails", async () => {
    const previousAppsPort = process.env.PANDA_APPS_PORT;
    const previousHealthPort = process.env.PANDA_CORE_HEALTH_PORT;
    process.env.PANDA_APPS_PORT = "0";
    delete process.env.PANDA_CORE_HEALTH_PORT;

    const order: string[] = [];
    let lifecycle!: ReturnType<typeof createDaemonLifecycle>;
    const context = {
      daemonKey: "primary",
      connectorLeases: {
        tryAcquire: vi.fn(async () => ({
          source: "daemon",
          connectorKey: "primary",
          holderId: "holder-a",
          leasedUntil: Date.now() + 30_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
        renew: vi.fn(async () => null),
        release: vi.fn(async () => {
          order.push("release");
          return true;
        }),
      },
      daemonState: {
        heartbeat: vi.fn(async () => ({
          daemonKey: "primary",
          heartbeatAt: Date.now(),
          startedAt: Date.now(),
          updatedAt: Date.now(),
        })),
      },
      requests: {
        claimNextPendingRequest: vi.fn(async () => null),
        listenPendingRequests: vi.fn(async () => async () => {
          order.push("unlisten");
          throw new Error("unlisten blew up");
        }),
      },
      a2aOutboundWorker: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("a2a-stop");
          throw new Error("a2a blew up");
        }),
      },
      emailOutboundWorker: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("email-outbound-stop");
        }),
      },
      emailSyncRunner: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("email-sync-stop");
        }),
      },
      scheduledTaskRunner: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("tasks-stop");
        }),
      },
      watchRunner: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("watch-stop");
        }),
      },
      relationshipHeartbeatRunner: {
        start: vi.fn(async () => {}),
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
            await lifecycle.stop();
          }),
        },
      },
    } as any;

    lifecycle = createDaemonLifecycle({
      context,
      processRequest: vi.fn(async () => undefined),
    });

    try {
      await expect(lifecycle.run()).resolves.toBeUndefined();
      expect(order).toEqual([
        "unlisten",
        "a2a-stop",
        "email-outbound-stop",
        "email-sync-stop",
        "tasks-stop",
        "watch-stop",
        "heartbeat-stop",
        "release",
        "runtime-close",
      ]);
    } finally {
      if (previousAppsPort === undefined) {
        delete process.env.PANDA_APPS_PORT;
      } else {
        process.env.PANDA_APPS_PORT = previousAppsPort;
      }

      if (previousHealthPort === undefined) {
        delete process.env.PANDA_CORE_HEALTH_PORT;
      } else {
        process.env.PANDA_CORE_HEALTH_PORT = previousHealthPort;
      }
    }
  });

  it("acquires and releases the lease if app server startup fails after binding resolution", async () => {
    const previousAppsPort = process.env.PANDA_APPS_PORT;
    const previousHealthPort = process.env.PANDA_CORE_HEALTH_PORT;
    process.env.PANDA_APPS_PORT = "nope";
    delete process.env.PANDA_CORE_HEALTH_PORT;

    const order: string[] = [];
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
        heartbeat: vi.fn(async () => ({
          daemonKey: "primary",
          heartbeatAt: Date.now(),
          startedAt: Date.now(),
          updatedAt: Date.now(),
        })),
      },
      requests: {
        claimNextPendingRequest: vi.fn(async () => null),
        listenPendingRequests: vi.fn(async () => async () => undefined),
      },
      a2aOutboundWorker: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("a2a-stop");
        }),
      },
      emailOutboundWorker: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("email-outbound-stop");
        }),
      },
      emailSyncRunner: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("email-sync-stop");
        }),
      },
      scheduledTaskRunner: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("tasks-stop");
        }),
      },
      watchRunner: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("watch-stop");
        }),
      },
      relationshipHeartbeatRunner: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("heartbeat-stop");
        }),
      },
      runtime: {
        close: vi.fn(async () => {
          order.push("runtime-close");
        }),
        apps: {},
        identityStore: {},
        sessionStore: {},
        coordinator: {
          recoverOrphanedRuns: vi.fn(async () => undefined),
        },
      },
    } as any;

    const lifecycle = createDaemonLifecycle({
      context,
      processRequest: vi.fn(async () => undefined),
    });

    try {
      await expect(lifecycle.run()).rejects.toThrow("Invalid PANDA_APPS_PORT: nope");
    } finally {
      if (previousAppsPort === undefined) {
        delete process.env.PANDA_APPS_PORT;
      } else {
        process.env.PANDA_APPS_PORT = previousAppsPort;
      }

      if (previousHealthPort === undefined) {
        delete process.env.PANDA_CORE_HEALTH_PORT;
      } else {
        process.env.PANDA_CORE_HEALTH_PORT = previousHealthPort;
      }
    }

    expect(order).toEqual([
      "lease",
      "a2a-stop",
      "email-outbound-stop",
      "email-sync-stop",
      "tasks-stop",
      "watch-stop",
      "heartbeat-stop",
      "release",
      "runtime-close",
    ]);
  });

  it("marks health unhealthy when the query pool has sustained waiters", async () => {
    const previousAppsPort = process.env.PANDA_APPS_PORT;
    const previousHealthPort = process.env.PANDA_CORE_HEALTH_PORT;
    const previousWaitingStale = process.env.PANDA_CORE_HEALTH_POOL_WAITING_STALE_MS;
    process.env.PANDA_APPS_PORT = "0";
    process.env.PANDA_CORE_HEALTH_PORT = String(await getFreePort());
    process.env.PANDA_CORE_HEALTH_POOL_WAITING_STALE_MS = "1";

    let resolveRecovered!: () => void;
    const recovered = new Promise<void>((resolve) => {
      resolveRecovered = resolve;
    });
    const pool = {
      waitingCount: 0,
    };
    const context = {
      daemonKey: "primary",
      connectorLeases: {
        tryAcquire: vi.fn(async () => ({
          source: "daemon",
          connectorKey: "primary",
          holderId: "holder-a",
          leasedUntil: Date.now() + 30_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
        renew: vi.fn(async () => null),
        release: vi.fn(async () => true),
      },
      daemonState: {
        heartbeat: vi.fn(async () => ({
          daemonKey: "primary",
          heartbeatAt: Date.now(),
          startedAt: Date.now(),
          updatedAt: Date.now(),
        })),
      },
      requests: {
        claimNextPendingRequest: vi.fn(async () => null),
        listenPendingRequests: vi.fn(async () => async () => undefined),
      },
      a2aOutboundWorker: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      emailOutboundWorker: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      emailSyncRunner: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      scheduledTaskRunner: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      watchRunner: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      relationshipHeartbeatRunner: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      runtime: {
        close: vi.fn(async () => {}),
        apps: {},
        appAuth: {},
        identityStore: {},
        sessionStore: {},
        pool,
        coordinator: {
          recoverOrphanedRuns: vi.fn(async () => {
            resolveRecovered();
          }),
        },
      },
    } as any;
    const lifecycle = createDaemonLifecycle({
      context,
      processRequest: vi.fn(async () => undefined),
    });
    const runPromise = lifecycle.run();

    try {
      await recovered;
      await new Promise((resolve) => setTimeout(resolve, 20));

      const healthy = await fetch(`http://127.0.0.1:${process.env.PANDA_CORE_HEALTH_PORT}/health`);
      expect(healthy.status).toBe(200);

      pool.waitingCount = 1;
      await fetch(`http://127.0.0.1:${process.env.PANDA_CORE_HEALTH_PORT}/health`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const unhealthy = await fetch(`http://127.0.0.1:${process.env.PANDA_CORE_HEALTH_PORT}/health`);
      expect(unhealthy.status).toBe(503);
      await expect(unhealthy.json()).resolves.toMatchObject({
        ok: false,
        queryPoolWaitingCount: 1,
      });
    } finally {
      await lifecycle.stop();
      await runPromise;
      if (previousAppsPort === undefined) {
        delete process.env.PANDA_APPS_PORT;
      } else {
        process.env.PANDA_APPS_PORT = previousAppsPort;
      }
      if (previousHealthPort === undefined) {
        delete process.env.PANDA_CORE_HEALTH_PORT;
      } else {
        process.env.PANDA_CORE_HEALTH_PORT = previousHealthPort;
      }
      if (previousWaitingStale === undefined) {
        delete process.env.PANDA_CORE_HEALTH_POOL_WAITING_STALE_MS;
      } else {
        process.env.PANDA_CORE_HEALTH_POOL_WAITING_STALE_MS = previousWaitingStale;
      }
    }
  });
});
