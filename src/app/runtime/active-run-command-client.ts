import {sleep} from "../../lib/async.js";
import type {CreateRuntimeRequestInput, RuntimeRequestKind} from "../../domain/threads/requests/types.js";
import {
  ACTIVE_PANDA_RUN_ENV,
  buildActivePandaRunEnv,
  isActivePandaRunEnvKey,
  readActivePandaRunContext,
  type ActivePandaRunContext,
} from "../../domain/threads/requests/active-run-env.js";
import {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {createPostgresPool, requireDatabaseUrl} from "./database.js";
import {ensureSchemas} from "./postgres-bootstrap.js";
import {DaemonStateRepo} from "./state/repo.js";
import {
  DAEMON_REQUEST_TIMEOUT_MS,
  DAEMON_STALE_AFTER_MS,
  DEFAULT_DAEMON_KEY,
} from "./daemon-shared.js";

export {
  ACTIVE_PANDA_RUN_ENV,
  buildActivePandaRunEnv,
  isActivePandaRunEnvKey,
  readActivePandaRunContext,
  type ActivePandaRunContext,
};

export interface ActiveRunRuntimeRequestOptions {
  dbUrl?: string;
  timeoutMs?: number;
}

async function waitForRequestResult<T>(
  requests: RuntimeRequestRepo,
  requestId: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const request = await requests.getRequest(requestId);
    if (request.status === "completed") {
      return (request.result ?? {}) as T;
    }

    if (request.status === "failed") {
      throw new Error(request.error ?? `Runtime request ${request.id} failed.`);
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for runtime request ${requestId}.`);
}

export async function submitActivePandaRunRuntimeRequest<
  TResult,
  K extends RuntimeRequestKind = RuntimeRequestKind,
>(
  input: CreateRuntimeRequestInput<K>,
  options: ActiveRunRuntimeRequestOptions = {},
): Promise<TResult> {
  const pool = createPostgresPool({
    connectionString: requireDatabaseUrl(options.dbUrl),
    applicationName: "panda/active-run-command-client",
    max: 2,
  });

  try {
    const requests = new RuntimeRequestRepo({pool});
    const daemonState = new DaemonStateRepo({pool});
    await ensureSchemas([requests, daemonState]);

    const state = await daemonState.readState(DEFAULT_DAEMON_KEY);
    if (!state || Date.now() - state.heartbeatAt > DAEMON_STALE_AFTER_MS) {
      throw new Error(`Runtime daemon (${DEFAULT_DAEMON_KEY}) is offline.`);
    }

    const request = await requests.enqueueRequest(input);
    return waitForRequestResult<TResult>(
      requests,
      request.id,
      options.timeoutMs ?? DAEMON_REQUEST_TIMEOUT_MS,
    );
  } finally {
    await pool.end();
  }
}
