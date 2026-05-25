import {sleep} from "../../lib/async.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {CreateRuntimeRequestInput, RuntimeRequestKind} from "../../domain/threads/requests/types.js";
import {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {createPostgresPool, requireDatabaseUrl} from "./database.js";
import {ensureSchemas} from "./postgres-bootstrap.js";
import {DaemonStateRepo} from "./state/repo.js";
import {
  DAEMON_REQUEST_TIMEOUT_MS,
  DAEMON_STALE_AFTER_MS,
  DEFAULT_DAEMON_KEY,
} from "./daemon-shared.js";

export const ACTIVE_PANDA_RUN_ENV = {
  agentKey: "PANDA_ACTIVE_AGENT_KEY",
  sessionId: "PANDA_ACTIVE_SESSION_ID",
  threadId: "PANDA_ACTIVE_THREAD_ID",
  runId: "PANDA_ACTIVE_RUN_ID",
} as const;

const ACTIVE_PANDA_RUN_ENV_KEYS = new Set<string>(Object.values(ACTIVE_PANDA_RUN_ENV));

export interface ActivePandaRunContext {
  agentKey: string;
  sessionId: string;
  threadId: string;
  runId: string;
}

export interface ActiveRunRuntimeRequestOptions {
  dbUrl?: string;
  timeoutMs?: number;
}

function readRequiredActiveRunEnv(
  env: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = trimToUndefined(env[key]);
  if (!value) {
    throw new Error(
      `panda telegram react must be run from an active Panda agent bash run (missing ${key}).`,
    );
  }

  return value;
}

export function isActivePandaRunEnvKey(key: string): boolean {
  return ACTIVE_PANDA_RUN_ENV_KEYS.has(key);
}

export function readActivePandaRunContext(
  env: NodeJS.ProcessEnv = process.env,
): ActivePandaRunContext {
  return {
    agentKey: readRequiredActiveRunEnv(env, ACTIVE_PANDA_RUN_ENV.agentKey),
    sessionId: readRequiredActiveRunEnv(env, ACTIVE_PANDA_RUN_ENV.sessionId),
    threadId: readRequiredActiveRunEnv(env, ACTIVE_PANDA_RUN_ENV.threadId),
    runId: readRequiredActiveRunEnv(env, ACTIVE_PANDA_RUN_ENV.runId),
  };
}

export function buildActivePandaRunEnv(
  context: Partial<ActivePandaRunContext> | undefined,
): Record<string, string> {
  const agentKey = trimToUndefined(context?.agentKey);
  const sessionId = trimToUndefined(context?.sessionId);
  const threadId = trimToUndefined(context?.threadId);
  const runId = trimToUndefined(context?.runId);
  if (!agentKey || !sessionId || !threadId || !runId) {
    return {};
  }

  return {
    [ACTIVE_PANDA_RUN_ENV.agentKey]: agentKey,
    [ACTIVE_PANDA_RUN_ENV.sessionId]: sessionId,
    [ACTIVE_PANDA_RUN_ENV.threadId]: threadId,
    [ACTIVE_PANDA_RUN_ENV.runId]: runId,
  };
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
