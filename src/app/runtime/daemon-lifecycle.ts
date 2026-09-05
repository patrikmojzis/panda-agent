import {randomUUID} from "node:crypto";

import type {RuntimeRequestRecord} from "../../domain/threads/requests/types.js";
import {
  acquireManagedConnectorLease,
  type ConnectorLeaseRepository,
  type ManagedConnectorLease,
} from "../../domain/connector-leases/repo.js";
import {type HealthServer, resolveOptionalHealthServerBinding, startHealthServer} from "../../lib/health-server.js";
import {
  type AgentAppHttpService,
  type AgentAppServer,
  type AgentAppServerOptions,
  startAgentAppServer,
} from "../../integrations/apps/http-server.js";
import {
  DEFAULT_APPS_PORT,
  resolveAgentAppAuthMode,
  resolveOptionalAgentAppServerBinding,
} from "../../integrations/apps/http-config.js";
import {resolveOptionalControlServerBinding} from "../../integrations/control/config.js";
import {type ControlHttpServer, startControlServer} from "../../integrations/control/http-server.js";
import {resolveOptionalCommandServerBinding} from "../../integrations/commands/config.js";
import {type CommandHttpServer, startCommandHttpServer} from "../../integrations/commands/http-server.js";
import {runCleanupSteps} from "../../lib/cleanup.js";
import type {PostgresListenSnapshot} from "../../lib/postgres-listen.js";
import {readPositiveIntegerEnv} from "../../lib/postgres-database.js";
import {DAEMON_HEARTBEAT_INTERVAL_MS, type DaemonServices} from "./daemon-shared.js";
import {
  DEFAULT_RUNTIME_REQUEST_CONCURRENCY,
  DEFAULT_RUNTIME_REQUEST_SHUTDOWN_DRAIN_TIMEOUT_MS,
  RuntimeRequestDrain,
  type RuntimeRequestDrainStore,
} from "./request-drain.js";
import type {RuntimeServices} from "./create-runtime.js";
import {formatOrphanedRunRecoveryReason} from "../../domain/threads/runtime/coordinator.js";
import {FileSystemCommandUploadStore} from "../../integrations/commands/file-uploads.js";
import type {ThreadRunOwner} from "../../domain/threads/runtime/types.js";
import type {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";

const DAEMON_HEALTH_STALE_AFTER_MS = DAEMON_HEARTBEAT_INTERVAL_MS * 3;
const DAEMON_HEALTH_POOL_WAITING_STALE_AFTER_MS = 60_000;
const DEFAULT_DAEMON_SERVICE_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_THREAD_RUN_DRAIN_TIMEOUT_MS = 30_000;

interface StartStopService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface DaemonLifecycleRequests extends RuntimeRequestDrainStore, Pick<RuntimeRequestRepo, "enqueueRequest" | "getRequest"> {
  listenPendingRequests(
    onRequest: () => void,
    options?: {
      onError?: (error: unknown) => Promise<void> | void;
      onStateChange?: (snapshot: PostgresListenSnapshot) => Promise<void> | void;
    },
  ): Promise<() => Promise<void>>;
}

export interface DaemonLifecycleRuntime {
  close(): Promise<void>;
  apps: AgentAppHttpService;
  appAuth?: AgentAppServerOptions["auth"];
  identityStore?: RuntimeServices["identityStore"];
  sessionStore?: AgentAppServerOptions["sessionStore"];
  controlAuth: RuntimeServices["controlAuth"];
  controlReads: RuntimeServices["controlReads"];
  controlHome: RuntimeServices["controlHome"];
  controlOperator: RuntimeServices["controlOperator"];
  controlMcp: RuntimeServices["controlMcp"];
  controlBriefings: RuntimeServices["controlBriefings"];
  controlHeartbeats: RuntimeServices["controlHeartbeats"];
  controlScheduledTasks: RuntimeServices["controlScheduledTasks"];
  controlWatches: RuntimeServices["controlWatches"];
  controlRuntimeActivity: RuntimeServices["controlRuntimeActivity"];
  controlConnectorAccounts: RuntimeServices["controlConnectorAccounts"];
  controlModelCallTraces: RuntimeServices["controlModelCallTraces"];
  sessionCompaction: RuntimeServices["sessionCompaction"];
  commandExecutor: RuntimeServices["commandExecutor"];
  backgroundJobService: Pick<RuntimeServices["backgroundJobService"], "close" | "setOwner">;
  commandLeases: RuntimeServices["commandLeases"];
  coordinator: Pick<RuntimeServices["coordinator"], "start" | "stop" | "submitInput" | "submitSessionInput">;
  executionEnvironmentService?: Pick<RuntimeServices["executionEnvironmentService"], "sweepExpiredEnvironments">;
  pool: Pick<RuntimeServices["pool"], "waitingCount">;
}

export interface DaemonLifecycleContext {
  daemonKey: string;
  runtime: DaemonLifecycleRuntime;
  connectorLeases: ConnectorLeaseRepository;
  requests: DaemonLifecycleRequests;
  mediaReceiptJanitor: {
    startReceiptJanitor(): void;
    stopReceiptJanitor(): Promise<void>;
  };
  daemonState: {
    heartbeat(daemonKey: string): Promise<unknown>;
  };
  a2aOutboundWorker: StartStopService;
  emailOutboundWorker: StartStopService;
  emailSyncRunner: StartStopService;
  scheduledTaskRunner: StartStopService;
  scheduledCommandRunner: StartStopService;
  watchRunner: StartStopService;
  sessionHeartbeatRunner: StartStopService;
  discordVoice: {close(): Promise<void>};
}

export function createDaemonLifecycle(input: {
  context: DaemonLifecycleContext;
  processRequest: (request: RuntimeRequestRecord, signal: AbortSignal) => Promise<unknown>;
  afterRequestSettle?: (request: RuntimeRequestRecord, status: "completed" | "failed") => Promise<void> | void;
}): DaemonServices {
  let requestUnsubscribe: (() => Promise<void>) | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let healthServer: HealthServer | null = null;
  let appServer: AgentAppServer | null = null;
  let controlServer: ControlHttpServer | null = null;
  let commandServer: CommandHttpServer | null = null;
  let lease: ManagedConnectorLease | null = null;
  let runOwner: ThreadRunOwner | null = null;
  let lastHeartbeatAt = 0;
  let running = false;
  let shuttingDown = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let requestDrainStopPromise: Promise<void> | null = null;
  let startupPromise: Promise<void> | null = null;
  let heartbeatInFlight: Promise<void> | null = null;
  let queryPoolWaitingSince: number | null = null;
  let wakeRunLoop: (() => void) | null = null;
  let requestListenerStarted = false;
  let requestListenerSnapshot: PostgresListenSnapshot | null = null;
  let stopStartupWait: (() => void) | null = null;
  let cleanupStarted = false;
  const queryPoolWaitingStaleAfterMs = readPositiveIntegerEnv(
    "PANDA_CORE_HEALTH_POOL_WAITING_STALE_MS",
    DAEMON_HEALTH_POOL_WAITING_STALE_AFTER_MS,
  );
  const serviceStopTimeoutMs = readPositiveIntegerEnv(
    "PANDA_DAEMON_SERVICE_STOP_TIMEOUT_MS",
    DEFAULT_DAEMON_SERVICE_STOP_TIMEOUT_MS,
  );
  const requestDrainTimeoutMs = readPositiveIntegerEnv(
    "PANDA_RUNTIME_REQUEST_DRAIN_TIMEOUT_MS",
    DEFAULT_RUNTIME_REQUEST_SHUTDOWN_DRAIN_TIMEOUT_MS,
  );
  const threadRunDrainTimeoutMs = readPositiveIntegerEnv(
    "PANDA_CORE_THREAD_RUN_DRAIN_TIMEOUT_MS",
    DEFAULT_THREAD_RUN_DRAIN_TIMEOUT_MS,
  );
  const stopServiceWithinDeadline = async (
    label: string,
    run: () => Promise<void>,
    timeoutMs = serviceStopTimeoutMs,
  ): Promise<void> => {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} did not stop within ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([run(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const requestDrain = new RuntimeRequestDrain({
    requests: input.context.requests,
    processRequest: input.processRequest,
    afterSettle: input.afterRequestSettle,
    label: "daemon runtime request drain",
    maxConcurrency: readPositiveIntegerEnv("PANDA_RUNTIME_REQUEST_CONCURRENCY", DEFAULT_RUNTIME_REQUEST_CONCURRENCY),
    shutdownDrainTimeoutMs: requestDrainTimeoutMs,
    onError: (error) => {
      console.error("Daemon request drain failed", {
        daemonKey: input.context.daemonKey,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const releaseLease = async (): Promise<void> => {
    if (!lease) {
      return;
    }

    const handle = lease;
    lease = null;
    try {
      await handle.release();
    } finally {
      runOwner = null;
      input.context.runtime.backgroundJobService.setOwner(null);
      input.context.runtime.commandExecutor.setOwner(null);
    }
  };

  const stop = async (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }

    shuttingDown = true;
    stopped = true;
    running = false;
    if (requestListenerStarted) {
      requestListenerSnapshot = requestListenerSnapshot
        ? {
            ...requestListenerSnapshot,
            status: "closed",
            listening: false,
          }
        : null;
    }
    wakeRunLoop?.();
    wakeRunLoop = null;
    stopStartupWait?.();
    stopStartupWait = null;
    // Cancellation starts at the lifecycle boundary, before any potentially
    // blocking listener, heartbeat, or HTTP shutdown joins.
    requestDrainStopPromise ??= requestDrain.stop();
    void requestDrainStopPromise.catch(() => undefined);
    stopPromise = (async () => {
      if (startupPromise) {
        try {
          await stopServiceWithinDeadline("daemon startup", () => startupPromise as Promise<void>);
        } catch (error) {
          console.error("Daemon cleanup failed", {
            daemonKey: input.context.daemonKey,
            step: "daemon-startup",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // A starter that settles before this boundary is handed to the normal
      // cleanup pass. Only resources that settle after it must self-clean;
      // otherwise a stop racing startup invokes service stop hooks twice.
      cleanupStarted = true;

      const unsubscribe = requestUnsubscribe;
      requestUnsubscribe = null;
      const resolvedHealthServer = healthServer;
      healthServer = null;
      const resolvedAppServer = appServer;
      appServer = null;
      const resolvedControlServer = controlServer;
      controlServer = null;
      const resolvedCommandServer = commandServer;
      commandServer = null;

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      await runCleanupSteps(
        [
          {
            label: "request-unsubscribe",
            run: async () => {
              if (unsubscribe) await stopServiceWithinDeadline("request listener", unsubscribe);
            },
          },
          {
            label: "daemon-heartbeat",
            run: async () => {
              if (heartbeatInFlight) {
                await stopServiceWithinDeadline("daemon heartbeat", () => heartbeatInFlight as Promise<void>);
              }
            },
          },
          {
            label: "app-server",
            run: async () => {
              if (resolvedAppServer) await stopServiceWithinDeadline("app server", () => resolvedAppServer.close());
            },
          },
          {
            label: "control-server",
            run: async () => {
              if (resolvedControlServer) {
                await stopServiceWithinDeadline("control server", () => resolvedControlServer.close());
              }
            },
          },
          {
            label: "command-server",
            run: async () => {
              if (resolvedCommandServer) {
                await stopServiceWithinDeadline("command server", () => resolvedCommandServer.close());
              }
            },
          },
          {
            label: "a2a-outbound-worker",
            run: async () => {
              await stopServiceWithinDeadline(
                "a2a outbound worker",
                () => input.context.a2aOutboundWorker.stop(),
              );
            },
          },
          {
            label: "email-outbound-worker",
            run: async () => {
              await stopServiceWithinDeadline(
                "email outbound worker",
                () => input.context.emailOutboundWorker.stop(),
              );
            },
          },
          {
            label: "email-sync-runner",
            run: async () => {
              await stopServiceWithinDeadline("email sync runner", () => input.context.emailSyncRunner.stop());
            },
          },
          {
            label: "request-and-runtime-work",
            run: async () => {
              // A claimed reset can be waiting on the coordinator while the
              // coordinator is waiting for its active run to settle. Begin all
              // stops together, then await them, so shutdown cannot deadlock.
              const steps = [
                {label: "request-drain", run: () => requestDrainStopPromise ?? requestDrain.stop()},
                {label: "scheduled-task-runner", run: () => input.context.scheduledTaskRunner.stop()},
                {label: "scheduled-command-runner", run: () => input.context.scheduledCommandRunner.stop()},
                {label: "watch-runner", run: () => input.context.watchRunner.stop()},
                {label: "session-heartbeat-runner", run: () => input.context.sessionHeartbeatRunner.stop()},
                {label: "discord-voice-store", run: () => input.context.discordVoice.close()},
                {label: "thread-runtime", run: () => input.context.runtime.coordinator.stop()},
              ];
              await Promise.all(steps.map(async (step) => {
                try {
                  const timeoutMs = step.label === "request-drain"
                    ? requestDrainTimeoutMs + serviceStopTimeoutMs
                    : step.label === "thread-runtime"
                      ? threadRunDrainTimeoutMs + serviceStopTimeoutMs
                      : serviceStopTimeoutMs;
                  await stopServiceWithinDeadline(step.label, step.run, timeoutMs);
                } catch (error) {
                  console.error("Daemon cleanup failed", {
                    daemonKey: input.context.daemonKey,
                    step: step.label,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }));
            },
          },
          {
            label: "background-job-service",
            run: async () => {
              await stopServiceWithinDeadline(
                "background job service",
                () => input.context.runtime.backgroundJobService.close(),
              );
            },
          },
          {
            label: "media-receipt-janitor",
            run: () => stopServiceWithinDeadline(
              "media receipt janitor",
              () => input.context.mediaReceiptJanitor.stopReceiptJanitor(),
            ),
          },
          {
            label: "daemon-lease",
            run: () => stopServiceWithinDeadline("daemon lease", releaseLease),
          },
          {
            label: "runtime",
            run: async () => {
              await stopServiceWithinDeadline("runtime", () => input.context.runtime.close());
            },
          },
          {
            label: "health-server",
            run: async () => {
              if (resolvedHealthServer) {
                await stopServiceWithinDeadline("health server", () => resolvedHealthServer.close());
              }
            },
          },
        ],
        (step, error) => {
          console.error("Daemon cleanup failed", {
            daemonKey: input.context.daemonKey,
            step: step.label,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    })();

    return stopPromise;
  };

  const acquireLease = async (): Promise<void> => {
    const owner: ThreadRunOwner = {
      source: "daemon",
      connectorKey: input.context.daemonKey,
      holderId: randomUUID(),
    };
    const acquiredLease = await acquireManagedConnectorLease({
      repo: input.context.connectorLeases,
      source: owner.source,
      connectorKey: owner.connectorKey,
      holderId: owner.holderId,
      alreadyHeldMessage: `panda run (${input.context.daemonKey}) is already active.`,
      onError: async (error) => {
        console.error("Daemon lease renew failed", {
          daemonKey: input.context.daemonKey,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onLeaseLost: async (error) => {
        console.error("Daemon lease lost", {
          daemonKey: input.context.daemonKey,
          error: error.message,
        });
        await stop();
      },
    });
    if (stopped) {
      await acquiredLease.release();
      return;
    }
    lease = acquiredLease;
    runOwner = owner;
    input.context.runtime.backgroundJobService.setOwner(owner);
    input.context.runtime.commandExecutor.setOwner(owner);
  };

  const heartbeat = async (): Promise<void> => {
    await input.context.daemonState.heartbeat(input.context.daemonKey);
    lastHeartbeatAt = Date.now();
    try {
      await input.context.runtime.executionEnvironmentService?.sweepExpiredEnvironments?.();
    } catch (error) {
      console.error("Execution environment expiry sweep failed", {
        daemonKey: input.context.daemonKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const runHeartbeat = (): Promise<void> => {
    if (heartbeatInFlight) {
      return heartbeatInFlight;
    }
    const current = heartbeat().finally(() => {
      if (heartbeatInFlight === current) {
        heartbeatInFlight = null;
      }
    });
    heartbeatInFlight = current;
    return current;
  };

  const getQueryPoolHealth = (): {
    ok: boolean;
    waitingCount: number;
    waitingForMs: number;
  } => {
    const waitingCount = input.context.runtime.pool.waitingCount;
    if (waitingCount <= 0) {
      queryPoolWaitingSince = null;
      return {
        ok: true,
        waitingCount: 0,
        waitingForMs: 0,
      };
    }

    queryPoolWaitingSince ??= Date.now();
    const waitingForMs = Date.now() - queryPoolWaitingSince;
    return {
      ok: waitingForMs < queryPoolWaitingStaleAfterMs,
      waitingCount,
      waitingForMs,
    };
  };

  return {
    run: async () => {
      stopped = false;
      shuttingDown = false;
      cleanupStarted = false;
      stopPromise = null;
      requestListenerStarted = false;
      requestListenerSnapshot = null;
      let resolveStartupStop!: () => void;
      const startupStop = new Promise<"stopped">((resolve) => {
        resolveStartupStop = () => resolve("stopped");
      });
      stopStartupWait = resolveStartupStop;
      try {
        const startup = (async () => {
          await acquireLease();
          if (stopped) {
            return;
          }
          if (!runOwner) {
            throw new Error("Daemon run ownership was not established.");
          }
          await input.context.runtime.coordinator.start(
            runOwner,
            formatOrphanedRunRecoveryReason({
              recoveryTrigger: "daemon_startup_or_restart",
              probableCause: "previous_runtime_stopped_before_run_completed",
              recoveredAt: Date.now(),
            }),
          );
          if (stopped) {
            if (cleanupStarted) {
              await stopServiceWithinDeadline(
                "late-started thread runtime",
                () => input.context.runtime.coordinator.stop(),
                threadRunDrainTimeoutMs + serviceStopTimeoutMs,
              );
            }
            return;
          }
          const startedHealthServer = await (async () => {
            const binding = resolveOptionalHealthServerBinding({
              hostEnvKey: "PANDA_CORE_HEALTH_HOST",
              portEnvKey: "PANDA_CORE_HEALTH_PORT",
            });
            if (!binding) {
              return null;
            }

            return startHealthServer({
              ...binding,
              getSnapshot: () => {
                const queryPool = getQueryPoolHealth();
                const heartbeatAgeMs = lastHeartbeatAt ? Date.now() - lastHeartbeatAt : null;
                const requestListenerActive = requestListenerSnapshot?.listening ?? false;
                return {
                  ok:
                    running &&
                    !shuttingDown &&
                    heartbeatAgeMs !== null &&
                    heartbeatAgeMs <= DAEMON_HEALTH_STALE_AFTER_MS &&
                    queryPool.ok &&
                    (!requestListenerStarted || requestListenerActive),
                  daemonKey: input.context.daemonKey,
                  running,
                  shuttingDown,
                  lastHeartbeatAt: lastHeartbeatAt || null,
                  heartbeatAgeMs,
                  queryPoolWaitingCount: queryPool.waitingCount,
                  queryPoolWaitingForMs: queryPool.waitingForMs,
                  requestListenerStatus: requestListenerSnapshot?.status ?? null,
                  requestListenerActive,
                  requestListenerLastErrorAt: requestListenerSnapshot?.lastErrorAt ?? null,
                  requestListenerLastError: requestListenerSnapshot?.lastError ?? null,
                };
              },
            });
          })();
          if (stopped) {
            if (cleanupStarted && startedHealthServer) {
              await stopServiceWithinDeadline("late-started health server", () => startedHealthServer.close());
            } else {
              healthServer = startedHealthServer;
            }
            return;
          }
          healthServer = startedHealthServer;
          const startedAppServer = await (async () => {
            const binding = resolveOptionalAgentAppServerBinding({
              hostEnvKey: "PANDA_APPS_HOST",
              portEnvKey: "PANDA_APPS_PORT",
              defaultPort: DEFAULT_APPS_PORT,
            });
            if (!binding) {
              throw new Error("App server binding resolution failed.");
            }
            return startAgentAppServer({
              ...binding,
              service: input.context.runtime.apps,
              auth: input.context.runtime.appAuth,
              authMode: resolveAgentAppAuthMode(process.env),
              identityStore: input.context.runtime.identityStore,
              sessionStore: input.context.runtime.sessionStore,
              coordinator: input.context.runtime.coordinator,
            });
          })();
          if (stopped) {
            if (cleanupStarted) {
              await stopServiceWithinDeadline("late-started app server", () => startedAppServer.close());
            } else {
              appServer = startedAppServer;
            }
            return;
          }
          appServer = startedAppServer;
          const startedControlServer = await (async () => {
            const binding = resolveOptionalControlServerBinding(process.env);
            if (!binding) {
              return null;
            }
            if (!input.context.runtime.identityStore) {
              throw new Error("Control server requires an identity store.");
            }
            return startControlServer({
              host: binding.host,
              port: binding.port,
              auth: input.context.runtime.controlAuth,
              reads: input.context.runtime.controlReads,
              home: input.context.runtime.controlHome,
              operator: input.context.runtime.controlOperator,
              mcp: input.context.runtime.controlMcp,
              briefings: input.context.runtime.controlBriefings,
              heartbeats: input.context.runtime.controlHeartbeats,
              scheduledTasks: input.context.runtime.controlScheduledTasks,
              watches: input.context.runtime.controlWatches,
              runtimeActivity: input.context.runtime.controlRuntimeActivity,
              connectorAccounts: input.context.runtime.controlConnectorAccounts,
              modelCallTraces: input.context.runtime.controlModelCallTraces,
              sessionCompaction: input.context.runtime.sessionCompaction,
              sessionRequests: input.context.requests,
              identityStore: input.context.runtime.identityStore,
              env: process.env,
              uiStaticDir: binding.uiStaticDir,
            });
          })();
          if (stopped) {
            if (cleanupStarted && startedControlServer) {
              await stopServiceWithinDeadline("late-started control server", () => startedControlServer.close());
            } else {
              controlServer = startedControlServer;
            }
            return;
          }
          controlServer = startedControlServer;
          const startedCommandServer = await (async () => {
            const binding = resolveOptionalCommandServerBinding(process.env);
            if (!binding) {
              return null;
            }

            return startCommandHttpServer({
              host: binding.host,
              port: binding.port,
              socketPath: binding.socketPath,
              executor: input.context.runtime.commandExecutor,
              leaseVerifier: input.context.runtime.commandLeases,
              fileUploads: new FileSystemCommandUploadStore(),
            });
          })();
          if (stopped) {
            if (cleanupStarted && startedCommandServer) {
              await stopServiceWithinDeadline("late-started command server", () => startedCommandServer.close());
            } else {
              commandServer = startedCommandServer;
            }
            return;
          }
          commandServer = startedCommandServer;
          await runHeartbeat();
          if (stopped) {
            return;
          }
          heartbeatTimer = setInterval(() => {
            void runHeartbeat().catch((error) => {
              console.error("Daemon heartbeat failed", {
                daemonKey: input.context.daemonKey,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }, DAEMON_HEARTBEAT_INTERVAL_MS);
          const startedRequestUnsubscribe = await input.context.requests.listenPendingRequests(
            () => {
              requestDrain.kick();
            },
            {
              onStateChange: (snapshot) => {
                requestListenerSnapshot = snapshot;
              },
              onError: (error) => {
                console.error("Daemon request listener failed", {
                  daemonKey: input.context.daemonKey,
                  error: error instanceof Error ? error.message : String(error),
                });
              },
            },
          );
          if (stopped) {
            if (cleanupStarted) {
              await stopServiceWithinDeadline("late-started request listener", startedRequestUnsubscribe);
            } else {
              requestUnsubscribe = startedRequestUnsubscribe;
            }
            return;
          }
          requestUnsubscribe = startedRequestUnsubscribe;
          requestListenerStarted = true;
          requestListenerSnapshot ??= {
            status: "listening",
            listening: true,
            channels: [],
            lastConnectedAt: Date.now(),
            lastErrorAt: null,
            lastError: null,
          };
          if (stopped) {
            return;
          }
          // The media tree is process-global. Only the daemon that owns the
          // singleton lease may scan it or run the recurring janitor timer.
          input.context.mediaReceiptJanitor.startReceiptJanitor();
          if (stopped) {
            return;
          }
          const workers: readonly [string, StartStopService][] = [
            ["a2a outbound worker", input.context.a2aOutboundWorker],
            ["email outbound worker", input.context.emailOutboundWorker],
            ["email sync runner", input.context.emailSyncRunner],
            ["scheduled task runner", input.context.scheduledTaskRunner],
            ["scheduled command runner", input.context.scheduledCommandRunner],
            ["watch runner", input.context.watchRunner],
            ["session heartbeat runner", input.context.sessionHeartbeatRunner],
          ];
          for (const [label, worker] of workers) {
            await worker.start();
            if (stopped) {
              if (cleanupStarted) {
                await stopServiceWithinDeadline(`late-started ${label}`, () => worker.stop());
              }
              return;
            }
          }
          running = true;
          requestDrain.start();
        })();
        startupPromise = startup;
        void startup.then(() => {
          if (startupPromise === startup) {
            startupPromise = null;
          }
        }, (error) => {
          if (startupPromise === startup) {
            startupPromise = null;
          }
          if (stopped) {
            console.error("Daemon startup settled after shutdown", {
              daemonKey: input.context.daemonKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        const startupOutcome = await Promise.race([
          startup.then(() => "started" as const),
          startupStop,
        ]);
        if (startupOutcome === "stopped" || stopped) {
          if (stopPromise) await stopPromise;
          return;
        }
        stopStartupWait = null;
      } catch (error) {
        try {
          await stop();
        } catch (cleanupError) {
          console.error("Daemon startup cleanup failed", {
            daemonKey: input.context.daemonKey,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
        throw error;
      }

      while (!stopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wakeRunLoop = null;
            resolve();
          }, DAEMON_HEARTBEAT_INTERVAL_MS);
          wakeRunLoop = () => {
            clearTimeout(timer);
            wakeRunLoop = null;
            resolve();
          };
        });
      }
    },
    stop,
  };
}
