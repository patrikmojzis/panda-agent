import {createServer} from "node:net";

import {describe, expect, it, vi} from "vitest";

import type {RuntimeRequestRecord} from "../src/domain/threads/requests/index.js";
import {
  createDaemonLifecycle,
  type DaemonLifecycleContext,
  type DaemonLifecycleRuntime,
} from "../src/app/runtime/daemon-lifecycle.js";
import {sleep, waitFor} from "./helpers/wait-for.js";

function deferred(): {promise: Promise<void>; resolve(): void} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

function requestRecord(id: string): RuntimeRequestRecord {
  const now = Date.now();
  return {
    id,
    kind: "tui_input",
    status: "pending",
    payload: {
      actorId: "operator",
      externalMessageId: `message-${id}`,
      text: "hello",
    },
    claimToken: `claim-${id}`,
    claimExpiresAt: now + 300_000,
    createdAt: now,
    updatedAt: now,
  };
}

function failUnusedDependency(name: string): never {
  throw new Error(`${name} should not be used by this test`);
}

function createUnusedAppService(): DaemonLifecycleRuntime["apps"] {
  return {
    getApp: async () => failUnusedDependency("runtime.apps.getApp"),
    executeView: async () => failUnusedDependency("runtime.apps.executeView"),
    executeAction: async () => failUnusedDependency("runtime.apps.executeAction"),
  };
}

function createStartStopService(): DaemonLifecycleContext["a2aOutboundWorker"] {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

type RuntimeOverrides = Omit<Partial<DaemonLifecycleRuntime>, "coordinator" | "pool"> & {
  coordinator?: Partial<DaemonLifecycleRuntime["coordinator"]>;
  pool?: DaemonLifecycleRuntime["pool"];
};

type DaemonLifecycleContextOverrides =
  Omit<Partial<DaemonLifecycleContext>, "connectorLeases" | "daemonState" | "requests" | "runtime"> & {
    connectorLeases?: Partial<DaemonLifecycleContext["connectorLeases"]>;
    daemonState?: Partial<DaemonLifecycleContext["daemonState"]>;
    requests?: Partial<DaemonLifecycleContext["requests"]>;
    runtime?: RuntimeOverrides;
  };

function createDaemonLifecycleContext(overrides: DaemonLifecycleContextOverrides = {}): DaemonLifecycleContext {
  const runtimeOverrides = overrides.runtime ?? {};
  const baseRuntime: DaemonLifecycleRuntime = {
    close: vi.fn(async () => undefined),
    apps: createUnusedAppService(),
    backgroundJobService: {
      close: vi.fn(async () => undefined),
      setOwner: vi.fn(),
    } as DaemonLifecycleRuntime["backgroundJobService"],
    commandExecutor: {
      setOwner: vi.fn(),
    } as DaemonLifecycleRuntime["commandExecutor"],
    coordinator: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      submitInput: vi.fn(async () => failUnusedDependency("runtime.coordinator.submitInput")),
      submitSessionInput: vi.fn(async () => failUnusedDependency("runtime.coordinator.submitSessionInput")),
    },
    pool: {waitingCount: 0},
  };
  const runtime: DaemonLifecycleRuntime = {
    ...baseRuntime,
    ...runtimeOverrides,
    coordinator: {
      ...baseRuntime.coordinator,
      ...runtimeOverrides.coordinator,
    },
    pool: runtimeOverrides.pool ?? baseRuntime.pool,
  };

  const baseContext: DaemonLifecycleContext = {
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
      renewRequestClaim: vi.fn(async () => true),
      deferRequestClaim: vi.fn(async () => true),
      releaseRequestClaim: vi.fn(async () => true),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
      pruneSettledRequests: vi.fn(async () => 0),
      listenPendingRequests: vi.fn(async () => async () => undefined),
    },
    mediaReceiptJanitor: {
      startReceiptJanitor: vi.fn(),
      stopReceiptJanitor: vi.fn(async () => undefined),
    },
    a2aOutboundWorker: createStartStopService(),
    emailOutboundWorker: createStartStopService(),
    emailSyncRunner: createStartStopService(),
    scheduledTaskRunner: createStartStopService(),
    watchRunner: createStartStopService(),
    sessionHeartbeatRunner: createStartStopService(),
    discordVoice: {close: vi.fn(async () => undefined)},
    runtime,
  };

  return {
    ...baseContext,
    ...overrides,
    connectorLeases: {
      ...baseContext.connectorLeases,
      ...overrides.connectorLeases,
    },
    daemonState: {
      ...baseContext.daemonState,
      ...overrides.daemonState,
    },
    requests: {
      ...baseContext.requests,
      ...overrides.requests,
    },
    runtime,
  };
}

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
    const context = createDaemonLifecycleContext({
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
      sessionHeartbeatRunner: {
        start: vi.fn(async () => {
          order.push("heartbeat-start");
          queueMicrotask(() => {
            void lifecycle.stop();
          });
        }),
        stop: vi.fn(async () => {
          order.push("heartbeat-stop");
        }),
      },
      discordVoice: {close: vi.fn(async () => { order.push("voice-store-close"); })},
      mediaReceiptJanitor: {
        startReceiptJanitor: vi.fn(() => {
          order.push("media-receipt-janitor-start");
        }),
        stopReceiptJanitor: vi.fn(async () => {
          order.push("media-receipt-janitor-stop");
        }),
      },
      runtime: {
        close: vi.fn(async () => {
          order.push("runtime-close");
        }),
        backgroundJobService: {
          close: vi.fn(async () => {
            order.push("background-jobs-close");
          }),
          setOwner: vi.fn(),
        } as DaemonLifecycleRuntime["backgroundJobService"],
        coordinator: {
          start: vi.fn(async () => {
            order.push("coordinator-start");
          }),
          stop: vi.fn(async () => {
            order.push("coordinator-stop");
          }),
        },
      },
    });

    lifecycle = createDaemonLifecycle({
      context,
      processRequest,
    });

    try {
      await lifecycle.run();

      expect(order).toEqual([
        "lease",
        "coordinator-start",
        "heartbeat",
        "listen",
        "media-receipt-janitor-start",
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
        "voice-store-close",
        "coordinator-stop",
        "background-jobs-close",
        "media-receipt-janitor-stop",
        "release",
        "runtime-close",
      ]);
      expect(context.runtime.coordinator.start).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "daemon",
          connectorKey: "primary",
          holderId: expect.any(String),
        }),
        expect.stringMatching(
          /^Run marked failed during orphaned-run recovery; recoveryTrigger=daemon_startup_or_restart; recoveryMechanism=daemon_lease_fenced_run_claim_sweep; probableCause=previous_runtime_stopped_before_run_completed; recoveredAt=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/,
        ),
      );
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

  it("waits for coordinator startup before releasing ownership and closing runtime", async () => {
    const coordinatorStartEntered = deferred();
    const finishCoordinatorStart = deferred();
    const order: string[] = [];
    const context = createDaemonLifecycleContext({
      connectorLeases: {
        release: vi.fn(async () => {
          order.push("lease-release");
          return true;
        }),
      },
      runtime: {
        close: vi.fn(async () => {
          order.push("runtime-close");
        }),
        backgroundJobService: {
          close: vi.fn(async () => {
            order.push("background-jobs-close");
          }),
          setOwner: vi.fn(),
        } as DaemonLifecycleRuntime["backgroundJobService"],
        coordinator: {
          start: vi.fn(async () => {
            order.push("coordinator-start");
            coordinatorStartEntered.resolve();
            await finishCoordinatorStart.promise;
            order.push("coordinator-start-settled");
          }),
          stop: vi.fn(async () => {
            order.push("coordinator-stop");
          }),
        },
      },
    });
    const lifecycle = createDaemonLifecycle({
      context,
      processRequest: vi.fn(async () => undefined),
    });

    const runPromise = lifecycle.run();
    await coordinatorStartEntered.promise;
    const stopPromise = lifecycle.stop();
    let stopSettled = false;
    void stopPromise.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    expect(order).toEqual(["coordinator-start"]);
    expect(context.runtime.close).not.toHaveBeenCalled();
    expect(context.connectorLeases.release).not.toHaveBeenCalled();

    finishCoordinatorStart.resolve();
    await Promise.all([runPromise, stopPromise]);

    expect(order).toEqual([
      "coordinator-start",
      "coordinator-start-settled",
      "coordinator-stop",
      "background-jobs-close",
      "lease-release",
      "runtime-close",
    ]);
    expect(context.a2aOutboundWorker.start).not.toHaveBeenCalled();
    expect(context.emailOutboundWorker.start).not.toHaveBeenCalled();
    expect(context.emailSyncRunner.start).not.toHaveBeenCalled();
    expect(context.scheduledTaskRunner.start).not.toHaveBeenCalled();
    expect(context.watchRunner.start).not.toHaveBeenCalled();
    expect(context.sessionHeartbeatRunner.start).not.toHaveBeenCalled();
  });

  it("bounds shutdown during stuck startup and fences a late starter", async () => {
    const previousStopTimeout = process.env.PANDA_DAEMON_SERVICE_STOP_TIMEOUT_MS;
    process.env.PANDA_DAEMON_SERVICE_STOP_TIMEOUT_MS = "20";
    const coordinatorStartEntered = deferred();
    const finishCoordinatorStart = deferred();
    const context = createDaemonLifecycleContext({
      runtime: {
        coordinator: {
          start: vi.fn(async () => {
            coordinatorStartEntered.resolve();
            await finishCoordinatorStart.promise;
          }),
          stop: vi.fn(async () => undefined),
        },
      },
    });
    const lifecycle = createDaemonLifecycle({
      context,
      processRequest: vi.fn(async () => undefined),
    });

    try {
      const runPromise = lifecycle.run();
      await coordinatorStartEntered.promise;
      await expect(Promise.race([
        lifecycle.stop(),
        sleep(1_000).then(() => { throw new Error("stuck startup blocked daemon stop"); }),
      ])).resolves.toBeUndefined();
      await expect(runPromise).resolves.toBeUndefined();
      expect(context.runtime.close).toHaveBeenCalledOnce();
      expect(context.connectorLeases.release).toHaveBeenCalledOnce();

      finishCoordinatorStart.resolve();
      await waitFor(() => {
        expect(context.runtime.coordinator.stop).toHaveBeenCalledTimes(2);
      });
      expect(context.a2aOutboundWorker.start).not.toHaveBeenCalled();
    } finally {
      finishCoordinatorStart.resolve();
      if (previousStopTimeout === undefined) {
        delete process.env.PANDA_DAEMON_SERVICE_STOP_TIMEOUT_MS;
      } else {
        process.env.PANDA_DAEMON_SERVICE_STOP_TIMEOUT_MS = previousStopTimeout;
      }
    }
  });

  it("stops receipt-producing runners concurrently with their coordinator", async () => {
    const previousAppsPort = process.env.PANDA_APPS_PORT;
    const previousHealthPort = process.env.PANDA_CORE_HEALTH_PORT;
    process.env.PANDA_APPS_PORT = "0";
    delete process.env.PANDA_CORE_HEALTH_PORT;

    const allRunnersStarted = deferred();
    const coordinatorStopEntered = deferred();
    const order: string[] = [];
    const context = createDaemonLifecycleContext({
      scheduledTaskRunner: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => {
          order.push("tasks-stop-entered");
          await coordinatorStopEntered.promise;
          order.push("tasks-stop-settled");
        }),
      },
      sessionHeartbeatRunner: {
        start: vi.fn(async () => {
          allRunnersStarted.resolve();
        }),
        stop: vi.fn(async () => undefined),
      },
      runtime: {
        coordinator: {
          stop: vi.fn(async () => {
            order.push("coordinator-stop");
            coordinatorStopEntered.resolve();
          }),
        },
      },
    });
    const lifecycle = createDaemonLifecycle({
      context,
      processRequest: vi.fn(async () => undefined),
    });

    try {
      const runPromise = lifecycle.run();
      await allRunnersStarted.promise;
      const stopPromise = lifecycle.stop();
      await Promise.race([
        stopPromise,
        sleep(1_000).then(() => {
          throw new Error("Daemon shutdown deadlocked behind a receipt-producing runner.");
        }),
      ]);
      await runPromise;

      expect(order).toEqual([
        "tasks-stop-entered",
        "coordinator-stop",
        "tasks-stop-settled",
      ]);
    } finally {
      await lifecycle.stop();
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

  it("waits for request-listener startup and then closes the acquired listener", async () => {
    const previousAppsPort = process.env.PANDA_APPS_PORT;
    const previousHealthPort = process.env.PANDA_CORE_HEALTH_PORT;
    process.env.PANDA_APPS_PORT = "0";
    delete process.env.PANDA_CORE_HEALTH_PORT;

    const listenerStartEntered = deferred();
    const finishListenerStart = deferred();
    const order: string[] = [];
    const context = createDaemonLifecycleContext({
      connectorLeases: {
        release: vi.fn(async () => {
          order.push("lease-release");
          return true;
        }),
      },
      requests: {
        listenPendingRequests: vi.fn(async () => {
          order.push("listener-start");
          listenerStartEntered.resolve();
          await finishListenerStart.promise;
          order.push("listener-start-settled");
          return async () => {
            order.push("listener-stop");
          };
        }),
      },
      runtime: {
        close: vi.fn(async () => {
          order.push("runtime-close");
        }),
        coordinator: {
          stop: vi.fn(async () => {
            order.push("coordinator-stop");
          }),
        },
      },
    });
    const lifecycle = createDaemonLifecycle({
      context,
      processRequest: vi.fn(async () => undefined),
    });

    try {
      const runPromise = lifecycle.run();
      await listenerStartEntered.promise;
      const stopPromise = lifecycle.stop();
      await Promise.resolve();

      expect(order).toEqual(["listener-start"]);
      expect(context.runtime.close).not.toHaveBeenCalled();
      expect(context.connectorLeases.release).not.toHaveBeenCalled();

      finishListenerStart.resolve();
      await Promise.all([runPromise, stopPromise]);

      expect(order).toEqual([
        "listener-start",
        "listener-start-settled",
        "listener-stop",
        "coordinator-stop",
        "lease-release",
        "runtime-close",
      ]);
      expect(context.a2aOutboundWorker.start).not.toHaveBeenCalled();
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

  it("waits for an in-flight heartbeat before closing runtime pools", async () => {
    vi.useFakeTimers();
    const previousAppsPort = process.env.PANDA_APPS_PORT;
    const previousHealthPort = process.env.PANDA_CORE_HEALTH_PORT;
    process.env.PANDA_APPS_PORT = "0";
    delete process.env.PANDA_CORE_HEALTH_PORT;

    const daemonStarted = deferred();
    const secondHeartbeatEntered = deferred();
    const finishSecondHeartbeat = deferred();
    let heartbeatCalls = 0;
    const order: string[] = [];
    const context = createDaemonLifecycleContext({
      daemonState: {
        heartbeat: vi.fn(async () => {
          heartbeatCalls += 1;
          if (heartbeatCalls === 2) {
            order.push("heartbeat-start");
            secondHeartbeatEntered.resolve();
            await finishSecondHeartbeat.promise;
            order.push("heartbeat-settled");
          }
          return {
            daemonKey: "primary",
            heartbeatAt: Date.now(),
            startedAt: Date.now(),
            updatedAt: Date.now(),
          };
        }),
      },
      sessionHeartbeatRunner: {
        start: vi.fn(async () => {
          daemonStarted.resolve();
        }),
        stop: vi.fn(async () => undefined),
      },
      runtime: {
        close: vi.fn(async () => {
          order.push("runtime-close");
        }),
      },
    });
    const lifecycle = createDaemonLifecycle({
      context,
      processRequest: vi.fn(async () => undefined),
    });

    try {
      const runPromise = lifecycle.run();
      await daemonStarted.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      await secondHeartbeatEntered.promise;
      const stopPromise = lifecycle.stop();
      await Promise.resolve();

      expect(order).toEqual(["heartbeat-start"]);
      expect(context.runtime.close).not.toHaveBeenCalled();

      finishSecondHeartbeat.resolve();
      await Promise.all([runPromise, stopPromise]);
      expect(order).toEqual(["heartbeat-start", "heartbeat-settled", "runtime-close"]);
    } finally {
      finishSecondHeartbeat.resolve();
      await lifecycle.stop();
      vi.useRealTimers();
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
    const context = createDaemonLifecycleContext({
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
      sessionHeartbeatRunner: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          order.push("heartbeat-stop");
        }),
      },
      runtime: {
        close: vi.fn(async () => {
          order.push("runtime-close");
        }),
        backgroundJobService: {
          close: vi.fn(async () => {
            order.push("background-jobs-close");
          }),
          setOwner: vi.fn(),
        } as DaemonLifecycleRuntime["backgroundJobService"],
        coordinator: {
          start: vi.fn(async () => {
            queueMicrotask(() => {
              void lifecycle.stop();
            });
          }),
        },
      },
    });

    lifecycle = createDaemonLifecycle({
      context,
      processRequest: vi.fn(async () => undefined),
    });

    try {
      await lifecycle.run();
      expect(order).toEqual([
        "a2a-stop",
        "email-outbound-stop",
        "email-sync-stop",
        "tasks-stop",
        "watch-stop",
        "heartbeat-stop",
        "background-jobs-close",
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

  it("waits for an active runtime request before closing runtime", async () => {
    const previousAppsPort = process.env.PANDA_APPS_PORT;
    const previousHealthPort = process.env.PANDA_CORE_HEALTH_PORT;
    const previousRequestConcurrency = process.env.PANDA_RUNTIME_REQUEST_CONCURRENCY;
    process.env.PANDA_APPS_PORT = "0";
    process.env.PANDA_RUNTIME_REQUEST_CONCURRENCY = "1";
    delete process.env.PANDA_CORE_HEALTH_PORT;

    const order: string[] = [];
    const pendingRequests = [requestRecord("request-1"), requestRecord("request-2")];
    const context = createDaemonLifecycleContext({
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
        claimNextPendingRequest: vi.fn(async () => pendingRequests.shift() ?? null),
        releaseRequestClaim: vi.fn(async (id: string) => {
          order.push(`release-${id}`);
          return true;
        }),
        completeRequest: vi.fn(async (id: string) => {
          order.push(`complete-${id}`);
        }),
        failRequest: vi.fn(async () => undefined),
        listenPendingRequests: vi.fn(async () => async () => undefined),
      },
      a2aOutboundWorker: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      emailOutboundWorker: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      emailSyncRunner: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      scheduledTaskRunner: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      watchRunner: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      sessionHeartbeatRunner: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      runtime: {
        close: vi.fn(async () => {
          order.push("runtime-close");
        }),
        pool: {waitingCount: 0},
        coordinator: {
          start: vi.fn(async () => undefined),
        },
      },
    });
    const lifecycle = createDaemonLifecycle({
      context,
      processRequest: vi.fn(async (request, signal) => {
        order.push(`process-start-${request.id}`);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            order.push(`process-abort-${request.id}`);
            resolve();
          }, {once: true});
        });
        signal.throwIfAborted();
        return request.id;
      }),
    });
    const runPromise = lifecycle.run();

    try {
      await waitFor(() => {
        expect(order).toEqual(["process-start-request-1"]);
      });

      await lifecycle.stop();
      await runPromise;

      expect(order).toEqual([
        "process-start-request-1",
        "process-abort-request-1",
        "release-request-1",
        "runtime-close",
      ]);
      expect(context.requests.claimNextPendingRequest).toHaveBeenCalledTimes(1);
      expect(context.requests.failRequest).not.toHaveBeenCalled();
      expect(context.requests.completeRequest).not.toHaveBeenCalled();
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
      if (previousRequestConcurrency === undefined) {
        delete process.env.PANDA_RUNTIME_REQUEST_CONCURRENCY;
      } else {
        process.env.PANDA_RUNTIME_REQUEST_CONCURRENCY = previousRequestConcurrency;
      }
    }
  });

  it("acquires and releases the lease if app server startup fails after binding resolution", async () => {
    const previousAppsPort = process.env.PANDA_APPS_PORT;
    const previousHealthPort = process.env.PANDA_CORE_HEALTH_PORT;
    process.env.PANDA_APPS_PORT = "nope";
    delete process.env.PANDA_CORE_HEALTH_PORT;

    const order: string[] = [];
    const context = createDaemonLifecycleContext({
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
      sessionHeartbeatRunner: {
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
          start: vi.fn(async () => undefined),
          stop: vi.fn(async () => {
            order.push("coordinator-stop");
            throw new Error("coordinator stop blew up");
          }),
        },
      },
    });

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
      "coordinator-stop",
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
    const context = createDaemonLifecycleContext({
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
      sessionHeartbeatRunner: {start: vi.fn(async () => {}), stop: vi.fn(async () => {})},
      runtime: {
        close: vi.fn(async () => {}),
        pool,
        coordinator: {
          start: vi.fn(async () => {
            resolveRecovered();
          }),
        },
      },
    });
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

  it("includes request listener state in health and marks reconnecting listeners unhealthy", async () => {
    const previousAppsPort = process.env.PANDA_APPS_PORT;
    const previousHealthPort = process.env.PANDA_CORE_HEALTH_PORT;
    process.env.PANDA_APPS_PORT = "0";
    process.env.PANDA_CORE_HEALTH_PORT = String(await getFreePort());

    let resolveRecovered!: () => void;
    const recovered = new Promise<void>((resolve) => {
      resolveRecovered = resolve;
    });
    let updateListenerState: ((snapshot: {
      status: "listening" | "reconnecting" | "closed";
      listening: boolean;
      channels: readonly string[];
      lastConnectedAt: number | null;
      lastErrorAt: number | null;
      lastError: string | null;
    }) => void) | undefined;
    const context = createDaemonLifecycleContext({
      daemonKey: "primary",
      requests: {
        claimNextPendingRequest: vi.fn(async () => null),
        listenPendingRequests: vi.fn(async (_onRequest, options) => {
          updateListenerState = options?.onStateChange;
          updateListenerState?.({
            status: "listening",
            listening: true,
            channels: ["runtime_request_events"],
            lastConnectedAt: Date.now(),
            lastErrorAt: null,
            lastError: null,
          });
          return async () => undefined;
        }),
      },
      runtime: {
        close: vi.fn(async () => {}),
        pool: {waitingCount: 0},
        coordinator: {
          start: vi.fn(async () => {
            resolveRecovered();
          }),
        },
      },
    });
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
      await expect(healthy.json()).resolves.toMatchObject({
        ok: true,
        requestListenerStatus: "listening",
        requestListenerActive: true,
        requestListenerLastErrorAt: null,
        requestListenerLastError: null,
      });

      updateListenerState?.({
        status: "reconnecting",
        listening: false,
        channels: ["runtime_request_events"],
        lastConnectedAt: Date.now() - 1_000,
        lastErrorAt: 123,
        lastError: "listen lost",
      });

      const unhealthy = await fetch(`http://127.0.0.1:${process.env.PANDA_CORE_HEALTH_PORT}/health`);
      expect(unhealthy.status).toBe(503);
      await expect(unhealthy.json()).resolves.toMatchObject({
        ok: false,
        requestListenerStatus: "reconnecting",
        requestListenerActive: false,
        requestListenerLastErrorAt: 123,
        requestListenerLastError: "listen lost",
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
    }
  });

});
