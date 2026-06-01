import type {RuntimeRequestRecord} from "../../domain/threads/requests/types.js";
import {
    acquireManagedConnectorLease,
    type ConnectorLeaseRepository,
    type ManagedConnectorLease,
} from "../../domain/connector-leases/repo.js";
import {type HealthServer, resolveOptionalHealthServerBinding, startHealthServer} from "../health/server.js";
import {
    type AgentAppServer,
    type AgentAppServerOptions,
    type AgentAppHttpService,
    startAgentAppServer,
} from "../../integrations/apps/http-server.js";
import {
    DEFAULT_APPS_PORT,
    resolveAgentAppAuthMode,
    resolveOptionalAgentAppServerBinding,
} from "../../integrations/apps/http-config.js";
import {resolveOptionalControlServerBinding} from "../../integrations/control/config.js";
import {type ControlHttpServer, startControlServer} from "../../integrations/control/http-server.js";
import {runCleanupSteps} from "../../lib/cleanup.js";
import type {PostgresListenSnapshot} from "../../lib/postgres-listen.js";
import {readPositiveIntegerEnv} from "./database.js";
import {DAEMON_HEARTBEAT_INTERVAL_MS, type DaemonServices} from "./daemon-shared.js";
import {RuntimeRequestDrain, type RuntimeRequestDrainStore} from "./request-drain.js";
import type {RuntimeServices} from "./create-runtime.js";
import {formatOrphanedRunRecoveryReason} from "../../domain/threads/runtime/coordinator.js";

const DAEMON_HEALTH_STALE_AFTER_MS = DAEMON_HEARTBEAT_INTERVAL_MS * 3;
const DAEMON_HEALTH_POOL_WAITING_STALE_AFTER_MS = 60_000;

interface StartStopService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface DaemonLifecycleRequests extends RuntimeRequestDrainStore {
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
  identityStore?: AgentAppServerOptions["identityStore"];
  sessionStore?: AgentAppServerOptions["sessionStore"];
  controlAuth: RuntimeServices["controlAuth"];
  controlReads: RuntimeServices["controlReads"];
  controlHome: RuntimeServices["controlHome"];
  controlBriefings: RuntimeServices["controlBriefings"];
  controlHeartbeats: RuntimeServices["controlHeartbeats"];
  controlTodos: RuntimeServices["controlTodos"];
  controlScheduledTasks: RuntimeServices["controlScheduledTasks"];
  coordinator: Pick<RuntimeServices["coordinator"], "recoverOrphanedRuns" | "submitInput">;
  executionEnvironmentService?: Pick<RuntimeServices["executionEnvironmentService"], "sweepExpiredEnvironments">;
  pool: Pick<RuntimeServices["pool"], "waitingCount">;
}

export interface DaemonLifecycleContext {
  daemonKey: string;
  runtime: DaemonLifecycleRuntime;
  connectorLeases: ConnectorLeaseRepository;
  requests: DaemonLifecycleRequests;
  daemonState: {
    heartbeat(daemonKey: string): Promise<unknown>;
  };
  a2aOutboundWorker: StartStopService;
  emailOutboundWorker: StartStopService;
  emailSyncRunner: StartStopService;
  scheduledTaskRunner: StartStopService;
  watchRunner: StartStopService;
  sessionHeartbeatRunner: StartStopService;
}

export function createDaemonLifecycle(input: {
  context: DaemonLifecycleContext;
  processRequest: (request: RuntimeRequestRecord) => Promise<unknown>;
}): DaemonServices {
  let requestUnsubscribe: (() => Promise<void>) | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let healthServer: HealthServer | null = null;
  let appServer: AgentAppServer | null = null;
  let controlServer: ControlHttpServer | null = null;
  let lease: ManagedConnectorLease | null = null;
  let lastHeartbeatAt = 0;
  let running = false;
  let shuttingDown = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let queryPoolWaitingSince: number | null = null;
  let wakeRunLoop: (() => void) | null = null;
  let requestListenerStarted = false;
  let requestListenerSnapshot: PostgresListenSnapshot | null = null;
  const queryPoolWaitingStaleAfterMs = readPositiveIntegerEnv(
    "PANDA_CORE_HEALTH_POOL_WAITING_STALE_MS",
    DAEMON_HEALTH_POOL_WAITING_STALE_AFTER_MS,
  );
  const requestDrain = new RuntimeRequestDrain({
    requests: input.context.requests,
    processRequest: input.processRequest,
    label: "daemon runtime request drain",
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
    await handle.release();
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
    stopPromise = (async () => {
      const unsubscribe = requestUnsubscribe;
      requestUnsubscribe = null;
      const resolvedHealthServer = healthServer;
      healthServer = null;
      const resolvedAppServer = appServer;
      appServer = null;
      const resolvedControlServer = controlServer;
      controlServer = null;

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      await runCleanupSteps([
        {
          label: "request-unsubscribe",
          run: async () => {
            await unsubscribe?.();
          },
        },
        {
          label: "request-drain",
          run: async () => {
            await requestDrain.stop();
          },
        },
        {
          label: "a2a-outbound-worker",
          run: async () => {
            await input.context.a2aOutboundWorker.stop();
          },
        },
        {
          label: "email-outbound-worker",
          run: async () => {
            await input.context.emailOutboundWorker.stop();
          },
        },
        {
          label: "email-sync-runner",
          run: async () => {
            await input.context.emailSyncRunner.stop();
          },
        },
        {
          label: "scheduled-task-runner",
          run: async () => {
            await input.context.scheduledTaskRunner.stop();
          },
        },
        {
          label: "watch-runner",
          run: async () => {
            await input.context.watchRunner.stop();
          },
        },
        {
          label: "session-heartbeat-runner",
          run: async () => {
            await input.context.sessionHeartbeatRunner.stop();
          },
        },
        {
          label: "daemon-lease",
          run: releaseLease,
        },
        {
          label: "runtime",
          run: async () => {
            await input.context.runtime.close();
          },
        },
        {
          label: "health-server",
          run: async () => {
            await resolvedHealthServer?.close();
          },
        },
        {
          label: "app-server",
          run: async () => {
            await resolvedAppServer?.close();
          },
        },
        {
          label: "control-server",
          run: async () => {
            await resolvedControlServer?.close();
          },
        },
      ], (step, error) => {
        console.error("Daemon cleanup failed", {
          daemonKey: input.context.daemonKey,
          step: step.label,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    })();

    return stopPromise;
  };

  const acquireLease = async (): Promise<void> => {
    lease = await acquireManagedConnectorLease({
      repo: input.context.connectorLeases,
      source: "daemon",
      connectorKey: input.context.daemonKey,
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
      stopPromise = null;
      requestListenerStarted = false;
      requestListenerSnapshot = null;
      try {
        await acquireLease();
        healthServer = await (async () => {
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
                ok: running
                  && !shuttingDown
                  && heartbeatAgeMs !== null
                  && heartbeatAgeMs <= DAEMON_HEALTH_STALE_AFTER_MS
                  && queryPool.ok
                  && (!requestListenerStarted || requestListenerActive),
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
        appServer = await (async () => {
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
        controlServer = await (async () => {
          const binding = resolveOptionalControlServerBinding(process.env);
          if (!binding) {
            return null;
          }
          return startControlServer({
            host: binding.host,
            port: binding.port,
            auth: input.context.runtime.controlAuth,
            reads: input.context.runtime.controlReads,
            home: input.context.runtime.controlHome,
            briefings: input.context.runtime.controlBriefings,
            heartbeats: input.context.runtime.controlHeartbeats,
            todos: input.context.runtime.controlTodos,
            scheduledTasks: input.context.runtime.controlScheduledTasks,
            uiStaticDir: binding.uiStaticDir,
          });
        })();
        await heartbeat();
        heartbeatTimer = setInterval(() => {
          void heartbeat().catch((error) => {
            console.error("Daemon heartbeat failed", {
              daemonKey: input.context.daemonKey,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, DAEMON_HEARTBEAT_INTERVAL_MS);
        requestUnsubscribe = await input.context.requests.listenPendingRequests(() => {
          requestDrain.kick();
        }, {
          onStateChange: (snapshot) => {
            requestListenerSnapshot = snapshot;
          },
          onError: (error) => {
            console.error("Daemon request listener failed", {
              daemonKey: input.context.daemonKey,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });
        requestListenerStarted = true;
        requestListenerSnapshot ??= {
          status: "listening",
          listening: true,
          channels: [],
          lastConnectedAt: Date.now(),
          lastErrorAt: null,
          lastError: null,
        };
        const recoveredAt = Date.now();
        await input.context.runtime.coordinator.recoverOrphanedRuns(formatOrphanedRunRecoveryReason({
          recoveryTrigger: "daemon_startup_or_restart",
          probableCause: "previous_runtime_stopped_before_run_completed",
          recoveredAt,
        }));
        if (stopped) {
          return;
        }
        await input.context.a2aOutboundWorker.start();
        await input.context.emailOutboundWorker.start();
        await input.context.emailSyncRunner.start();
        await input.context.scheduledTaskRunner.start();
        await input.context.watchRunner.start();
        await input.context.sessionHeartbeatRunner.start();
        if (stopped) {
          return;
        }
        running = true;
        requestDrain.start();
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
