import type {RuntimeRequestRecord} from "../../domain/threads/requests/index.js";
import {acquireManagedConnectorLease, type ManagedConnectorLease} from "../../domain/connector-leases/index.js";
import {type HealthServer, resolveOptionalHealthServerBinding, startHealthServer} from "../health/server.js";
import {
  DEFAULT_APPS_PORT,
  type AgentAppServer,
  resolveOptionalAgentAppServerBinding,
  resolveAgentAppAuthMode,
  startAgentAppServer,
} from "../../integrations/apps/http-server.js";
import {runCleanupSteps} from "../../lib/cleanup.js";
import type {DaemonContext} from "./daemon-bootstrap.js";
import {buildDaemonAlreadyActiveMessage} from "./daemon-copy.js";
import {DAEMON_HEARTBEAT_INTERVAL_MS, type DaemonServices} from "./daemon-shared.js";

const DAEMON_HEALTH_STALE_AFTER_MS = DAEMON_HEARTBEAT_INTERVAL_MS * 3;

export function createDaemonLifecycle(input: {
  context: DaemonContext;
  processRequest: (request: RuntimeRequestRecord) => Promise<unknown>;
}): DaemonServices {
  let requestUnsubscribe: (() => Promise<void>) | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let healthServer: HealthServer | null = null;
  let appServer: AgentAppServer | null = null;
  let lease: ManagedConnectorLease | null = null;
  let drainPromise: Promise<void> | null = null;
  let pendingDrain = false;
  let lastHeartbeatAt = 0;
  let running = false;
  let shuttingDown = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;

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
    stopPromise = (async () => {
      const unsubscribe = requestUnsubscribe;
      requestUnsubscribe = null;
      const resolvedHealthServer = healthServer;
      healthServer = null;
      const resolvedAppServer = appServer;
      appServer = null;

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
          label: "a2a-outbound-worker",
          run: async () => {
            await input.context.a2aOutboundWorker.stop();
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
          label: "relationship-heartbeat-runner",
          run: async () => {
            await input.context.relationshipHeartbeatRunner.stop();
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
      alreadyHeldMessage: buildDaemonAlreadyActiveMessage(input.context.daemonKey),
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
    lastHeartbeatAt = Date.now();
    await input.context.daemonState.heartbeat(input.context.daemonKey);
  };

  const triggerDrain = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    if (drainPromise) {
      pendingDrain = true;
      return;
    }

    drainPromise = (async () => {
      while (!stopped) {
        const request = await input.context.requests.claimNextPendingRequest();
        if (!request) {
          return;
        }

        try {
          const result = await input.processRequest(request);
          await input.context.requests.completeRequest(request.id, result);
        } catch (error) {
          await input.context.requests.failRequest(
            request.id,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    })();

    try {
      await drainPromise;
    } finally {
      drainPromise = null;
      if (pendingDrain && !stopped) {
        pendingDrain = false;
        await triggerDrain();
      }
    }
  };

  return {
    run: async () => {
      stopped = false;
      shuttingDown = false;
      stopPromise = null;
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
            getSnapshot: () => ({
              ok: running && !shuttingDown && (Date.now() - lastHeartbeatAt) <= DAEMON_HEALTH_STALE_AFTER_MS,
              daemonKey: input.context.daemonKey,
              running,
              shuttingDown,
              lastHeartbeatAt: lastHeartbeatAt || null,
            }),
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
        await heartbeat();
        heartbeatTimer = setInterval(() => {
          void heartbeat().catch((error) => {
            console.error("Daemon heartbeat failed", {
              daemonKey: input.context.daemonKey,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, DAEMON_HEARTBEAT_INTERVAL_MS);
        requestUnsubscribe = await input.context.requests.listenPendingRequests(async () => {
          await triggerDrain();
        });
        await input.context.a2aOutboundWorker.start();
        await input.context.scheduledTaskRunner.start();
        await input.context.watchRunner.start();
        await input.context.relationshipHeartbeatRunner.start();
        await input.context.runtime.coordinator.recoverOrphanedRuns("Run marked failed before recovery.");
        running = true;
        await triggerDrain();
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
        await new Promise((resolve) => setTimeout(resolve, DAEMON_HEARTBEAT_INTERVAL_MS));
      }
    },
    stop,
  };
}
