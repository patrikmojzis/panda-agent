import type {PoolClient} from "pg";

import type {RuntimeRequestRecord} from "../../domain/threads/requests/index.js";
import {type HealthServer, resolveOptionalHealthServerBinding, startHealthServer} from "../health/server.js";
import type {DaemonContext} from "./daemon-bootstrap.js";
import {buildDaemonAlreadyActiveMessage} from "./daemon-copy.js";
import {DAEMON_HEARTBEAT_INTERVAL_MS, type DaemonServices, hashLockKey,} from "./daemon-shared.js";

const DAEMON_HEALTH_STALE_AFTER_MS = DAEMON_HEARTBEAT_INTERVAL_MS * 3;

export function createDaemonLifecycle(input: {
  context: DaemonContext;
  processRequest: (request: RuntimeRequestRecord) => Promise<unknown>;
}): DaemonServices {
  let requestUnsubscribe: (() => Promise<void>) | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let healthServer: HealthServer | null = null;
  let lockClient: PoolClient | null = null;
  let drainPromise: Promise<void> | null = null;
  let pendingDrain = false;
  let lastHeartbeatAt = 0;
  let running = false;
  let shuttingDown = false;
  let stopped = false;

  const acquireLock = async (): Promise<void> => {
    const client = await input.context.runtime.pool.connect();
    const [keyA, keyB] = hashLockKey(`panda-daemon:${input.context.daemonKey}`);
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [keyA, keyB],
    );
    const acquired = Boolean((result.rows[0] as Record<string, unknown> | undefined)?.acquired);
    if (!acquired) {
      client.release();
      throw new Error(buildDaemonAlreadyActiveMessage(input.context.daemonKey));
    }

    lockClient = client;
  };

  const releaseLock = async (): Promise<void> => {
    if (!lockClient) {
      return;
    }

    const client = lockClient;
    lockClient = null;
    const [keyA, keyB] = hashLockKey(`panda-daemon:${input.context.daemonKey}`);
    try {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [keyA, keyB]);
    } finally {
      client.release();
    }
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
      await acquireLock();
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

      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, DAEMON_HEARTBEAT_INTERVAL_MS));
      }
    },
    stop: async () => {
      shuttingDown = true;
      stopped = true;
      running = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (requestUnsubscribe) {
        await requestUnsubscribe();
        requestUnsubscribe = null;
      }
      await input.context.a2aOutboundWorker.stop();
      await input.context.scheduledTaskRunner.stop();
      await input.context.watchRunner.stop();
      await input.context.relationshipHeartbeatRunner.stop();
      await releaseLock();
      await input.context.runtime.close();
      await healthServer?.close().catch(() => undefined);
      healthServer = null;
    },
  };
}
