import type {PoolClient} from "pg";

import type {ThinkingLevel} from "@mariozechner/pi-ai";
import {sleep} from "../../lib/async.js";
import {trimToNull, trimToUndefined} from "../../lib/strings.js";
import {PostgresAgentStore} from "../../domain/agents/index.js";
import {type IdentityRecord, normalizeIdentityHandle, PostgresIdentityStore,} from "../../domain/identity/index.js";
import {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {DaemonStateRepo} from "./state/repo.js";
import {
  buildThreadRuntimeNotificationChannel,
  parseThreadRuntimeNotification,
  PostgresThreadRuntimeStore,
  type ThreadRuntimeNotification,
} from "../../domain/threads/runtime/postgres.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {InferenceProjection, ThreadRecord, ThreadUpdate,} from "../../domain/threads/runtime/types.js";
import {PostgresSessionStore, type SessionRecord} from "../../domain/sessions/index.js";
import {DAEMON_REQUEST_TIMEOUT_MS, DAEMON_STALE_AFTER_MS, DEFAULT_DAEMON_KEY,} from "./daemon.js";
import {createPostgresPool, requireDatabaseUrl} from "./create-runtime.js";
import {ensureSchemas} from "./postgres-bootstrap.js";

function requireRuntimeIdentityHandle(value: string | null | undefined): string {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    throw new Error("Runtime client requires an explicit identity handle.");
  }

  return normalizeIdentityHandle(trimmed);
}

export interface RuntimeClientOptions {
  identity: string;
  dbUrl?: string;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}

export interface RuntimeClientSessionOptions {
  sessionId?: string;
  agentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
}

export interface RuntimeClientCompactResult {
  compacted: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
}

export interface RuntimeClient {
  identity: IdentityRecord;
  store: ThreadRuntimeStore;
  createBranchSession(options?: RuntimeClientSessionOptions): Promise<ThreadRecord>;
  openMainSession(options?: RuntimeClientSessionOptions): Promise<ThreadRecord>;
  resetSession(options?: RuntimeClientSessionOptions): Promise<ThreadRecord>;
  openSession(sessionId: string): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  resolveThreadRunConfig(threadId: string): Promise<{
    model: string;
    thinking?: ThinkingLevel;
  }>;
  listAgentSessions(agentKey: string): Promise<readonly SessionRecord[]>;
  submitTextInput(input: {
    threadId?: string;
    text: string;
    actorId: string;
    externalMessageId: string;
  }): Promise<{threadId: string}>;
  abortThread(threadId: string, reason?: string): Promise<boolean>;
  waitForCurrentRun(threadId: string, timeoutMs?: number): Promise<void>;
  updateThread(threadId: string, update: ThreadUpdate): Promise<ThreadRecord>;
  compactThread(threadId: string, customInstructions: string): Promise<RuntimeClientCompactResult>;
  close(): Promise<void>;
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

async function listenThreadNotifications(options: {
  pool: { connect(): Promise<PoolClient> };
  listener: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}): Promise<() => Promise<void>> {
  const client = await options.pool.connect();
  const channel = buildThreadRuntimeNotificationChannel();
  const handleNotification = (message: { channel: string; payload?: string }) => {
    if (message.channel !== channel || typeof message.payload !== "string") {
      return;
    }

    const notification = parseThreadRuntimeNotification(message.payload);
    if (!notification) {
      return;
    }

    void options.listener(notification);
  };

  client.on("notification", handleNotification);
  await client.query(`LISTEN ${channel}`);

  return async () => {
    client.off("notification", handleNotification);
    try {
      await client.query(`UNLISTEN ${channel}`);
    } finally {
      client.release();
    }
  };
}

export async function createRuntimeClient(options: RuntimeClientOptions): Promise<RuntimeClient> {
  const pool = createPostgresPool({
    connectionString: requireDatabaseUrl(options.dbUrl),
    applicationName: "panda/runtime-client",
    max: 3,
  });

  const identityStore = new PostgresIdentityStore({
    pool,
  });
  const agentStore = new PostgresAgentStore({
    pool,
  });
  const sessionStore = new PostgresSessionStore({
    pool,
  });
  const store = new PostgresThreadRuntimeStore({
    pool,
  });
  const requests = new RuntimeRequestRepo({
    pool,
  });
  const daemonState = new DaemonStateRepo({
    pool,
  });

  let unsubscribe: (() => Promise<void>) | null = null;

  try {
    await ensureSchemas([
      identityStore,
      agentStore,
      sessionStore,
      store,
      requests,
      daemonState,
    ]);

    const identity = await identityStore.getIdentityByHandle(requireRuntimeIdentityHandle(options.identity));

    if (options.onStoreNotification) {
      unsubscribe = await listenThreadNotifications({
        pool,
        listener: options.onStoreNotification,
      });
    }

    const assertDaemonActive = async (): Promise<void> => {
      const state = await daemonState.readState(DEFAULT_DAEMON_KEY);
      if (!state || Date.now() - state.heartbeatAt > DAEMON_STALE_AFTER_MS) {
        throw new Error(`Runtime daemon (${DEFAULT_DAEMON_KEY}) is offline.`);
      }
    };

    const assertIdentityCanAccessAgent = async (agentKey: string): Promise<void> => {
      const pairings = await agentStore.listIdentityPairings(identity.id);
      if (!pairings.some((pairing) => pairing.agentKey === agentKey)) {
        throw new Error(`Identity ${identity.handle} is not paired to agent ${agentKey}.`);
      }
    };

    const createBranchSession = async (sessionOptions: RuntimeClientSessionOptions = {}): Promise<ThreadRecord> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "create_branch_session",
        payload: {
          identityId: identity.id,
          sessionId: sessionOptions.sessionId,
          agentKey: trimToUndefined(sessionOptions.agentKey),
          model: sessionOptions.model,
          thinking: sessionOptions.thinking,
          ...(sessionOptions.inferenceProjection ? {inferenceProjection: sessionOptions.inferenceProjection} : {}),
        },
      });
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, DAEMON_REQUEST_TIMEOUT_MS);
      return store.getThread(result.threadId);
    };

    const openMainSession = async (sessionOptions: RuntimeClientSessionOptions = {}): Promise<ThreadRecord> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "resolve_main_session_thread",
        payload: {
          identityId: identity.id,
          agentKey: trimToUndefined(sessionOptions.agentKey),
          model: sessionOptions.model,
          thinking: sessionOptions.thinking,
          ...(sessionOptions.inferenceProjection ? {inferenceProjection: sessionOptions.inferenceProjection} : {}),
        },
      });
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, DAEMON_REQUEST_TIMEOUT_MS);
      return store.getThread(result.threadId);
    };

    const resetSession = async (
      sessionOptions: RuntimeClientSessionOptions = {},
    ): Promise<ThreadRecord> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "reset_session",
        payload: {
          identityId: identity.id,
          source: "tui",
          sessionId: trimToUndefined(sessionOptions.sessionId),
          agentKey: trimToUndefined(sessionOptions.agentKey),
          model: sessionOptions.model,
          thinking: sessionOptions.thinking,
          ...(sessionOptions.inferenceProjection ? {inferenceProjection: sessionOptions.inferenceProjection} : {}),
        },
      });
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, DAEMON_REQUEST_TIMEOUT_MS);
      return store.getThread(result.threadId);
    };

    const openSession = async (sessionId: string): Promise<ThreadRecord> => {
      const session = await sessionStore.getSession(sessionId);
      await assertIdentityCanAccessAgent(session.agentKey);
      return store.getThread(session.currentThreadId);
    };

    const listAgentSessions = async (agentKey: string): Promise<readonly SessionRecord[]> => {
      await assertIdentityCanAccessAgent(agentKey);
      return sessionStore.listAgentSessions(agentKey);
    };

    const submitTextInput = async (input: {
      threadId?: string;
      text: string;
      actorId: string;
      externalMessageId: string;
    }): Promise<{threadId: string}> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "tui_input",
        payload: {
          identityId: identity.id,
          identityHandle: identity.handle,
          threadId: trimToUndefined(input.threadId),
          actorId: input.actorId,
          externalMessageId: input.externalMessageId,
          sentAt: Date.now(),
          text: input.text,
        },
      });
      return waitForRequestResult<{threadId: string}>(requests, request.id, DAEMON_REQUEST_TIMEOUT_MS);
    };

    const abortThread = async (threadId: string, reason?: string): Promise<boolean> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "abort_thread",
        payload: {
          identityId: identity.id,
          threadId,
          reason,
        },
      });
      const result = await waitForRequestResult<{aborted?: boolean}>(requests, request.id, DAEMON_REQUEST_TIMEOUT_MS);
      return result.aborted === true;
    };

    const waitForCurrentRun = async (threadId: string, timeoutMs = DAEMON_REQUEST_TIMEOUT_MS): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const runs = await store.listRuns(threadId);
        if (!runs.some((run) => run.status === "running")) {
          return;
        }

        await sleep(100);
      }

      throw new Error(`Timed out waiting for thread ${threadId} to become idle.`);
    };

    const updateThread = async (threadId: string, update: ThreadUpdate): Promise<ThreadRecord> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "update_thread",
        payload: {
          identityId: identity.id,
          threadId,
          update,
        },
      });
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, DAEMON_REQUEST_TIMEOUT_MS);
      return store.getThread(result.threadId);
    };

    const compactThread = async (threadId: string, customInstructions: string): Promise<RuntimeClientCompactResult> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "compact_thread",
        payload: {
          identityId: identity.id,
          threadId,
          customInstructions,
        },
      });
      return waitForRequestResult<RuntimeClientCompactResult>(requests, request.id, 15 * 60_000);
    };

    const resolveThreadRunConfig = async (
      threadId: string,
    ): Promise<{model: string; thinking?: ThinkingLevel}> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "resolve_thread_run_config",
        payload: {
          identityId: identity.id,
          threadId,
        },
      });
      const result = await waitForRequestResult<{model: string; thinking?: ThinkingLevel | null}>(
        requests,
        request.id,
        DAEMON_REQUEST_TIMEOUT_MS,
      );
      return {
        model: result.model,
        thinking: result.thinking ?? undefined,
      };
    };

    return {
      identity,
      store,
      createBranchSession,
      openMainSession,
      resetSession,
      openSession,
      getThread: (threadId) => store.getThread(threadId),
      resolveThreadRunConfig,
      listAgentSessions,
      submitTextInput,
      abortThread,
      waitForCurrentRun,
      updateThread,
      compactThread,
      close: async () => {
        if (unsubscribe) {
          const current = unsubscribe;
          unsubscribe = null;
          await current();
        }
        await pool.end();
      },
    };
  } catch (error) {
    if (unsubscribe) {
      await unsubscribe();
    }
    await pool.end();
    throw error;
  }
}
