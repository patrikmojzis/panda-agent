import type {PoolClient} from "pg";

import type {ThinkingLevel} from "@mariozechner/pi-ai";
import {PostgresAgentStore} from "../../domain/agents/index.js";
import {
    createDefaultIdentityInput,
    DEFAULT_IDENTITY_HANDLE,
    type IdentityRecord,
    PostgresIdentityStore,
} from "../../domain/identity/index.js";
import {PandaRuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {PandaDaemonStateRepo} from "./state/repo.js";
import {
    buildThreadRuntimeNotificationChannel,
    parseThreadRuntimeNotification,
    PostgresThreadRuntimeStore,
    type ThreadRuntimeNotification,
} from "../../domain/threads/runtime/postgres.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {InferenceProjection, ThreadRecord, ThreadUpdate,} from "../../domain/threads/runtime/types.js";
import {PostgresSessionStore, type SessionRecord} from "../../domain/sessions/index.js";
import {DEFAULT_PANDA_DAEMON_KEY, PANDA_DAEMON_REQUEST_TIMEOUT_MS, PANDA_DAEMON_STALE_AFTER_MS,} from "./daemon.js";
import {createPandaPool, requirePandaDatabaseUrl} from "./create-runtime.js";
import {ensureSchemas} from "./postgres-bootstrap.js";

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PandaClientOptions {
  identity?: string;
  dbUrl?: string;
  tablePrefix?: string;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}

export interface PandaClientSessionOptions {
  sessionId?: string;
  agentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
}

export interface PandaClientCompactResult {
  compacted: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
}

export interface PandaClient {
  identity: IdentityRecord;
  store: ThreadRuntimeStore;
  createBranchSession(options?: PandaClientSessionOptions): Promise<ThreadRecord>;
  openMainSession(options?: PandaClientSessionOptions): Promise<ThreadRecord>;
  resetSession(options?: PandaClientSessionOptions): Promise<ThreadRecord>;
  openSession(sessionId: string): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
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
  compactThread(threadId: string, customInstructions: string): Promise<PandaClientCompactResult>;
  close(): Promise<void>;
}

async function waitForRequestResult<T>(
  requests: PandaRuntimeRequestRepo,
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
  tablePrefix?: string;
  listener: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}): Promise<() => Promise<void>> {
  const client = await options.pool.connect();
  const channel = buildThreadRuntimeNotificationChannel(options.tablePrefix ?? "thread_runtime");
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

export async function createPandaClient(options: PandaClientOptions): Promise<PandaClient> {
  const pool = createPandaPool(requirePandaDatabaseUrl(options.dbUrl));
  const tablePrefix = options.tablePrefix;

  const identityStore = new PostgresIdentityStore({
    pool,
    tablePrefix,
  });
  const agentStore = new PostgresAgentStore({
    pool,
    tablePrefix,
  });
  const sessionStore = new PostgresSessionStore({
    pool,
    tablePrefix,
  });
  const store = new PostgresThreadRuntimeStore({
    pool,
    tablePrefix,
  });
  const requests = new PandaRuntimeRequestRepo({
    pool,
    tablePrefix,
  });
  const daemonState = new PandaDaemonStateRepo({
    pool,
    tablePrefix,
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

    const requestedIdentityHandle = trimNonEmptyString(options.identity) ?? DEFAULT_IDENTITY_HANDLE;
    const identity = requestedIdentityHandle === DEFAULT_IDENTITY_HANDLE
      ? await identityStore.ensureIdentity(createDefaultIdentityInput())
      : await identityStore.getIdentityByHandle(requestedIdentityHandle);

    if (options.onStoreNotification) {
      unsubscribe = await listenThreadNotifications({
        pool,
        tablePrefix,
        listener: options.onStoreNotification,
      });
    }

    const assertDaemonActive = async (): Promise<void> => {
      const state = await daemonState.readState(DEFAULT_PANDA_DAEMON_KEY);
      if (!state || Date.now() - state.heartbeatAt > PANDA_DAEMON_STALE_AFTER_MS) {
        throw new Error(`panda run (${DEFAULT_PANDA_DAEMON_KEY}) is offline.`);
      }
    };

    const assertIdentityCanAccessAgent = async (agentKey: string): Promise<void> => {
      const pairings = await agentStore.listIdentityPairings(identity.id);
      if (!pairings.some((pairing) => pairing.agentKey === agentKey)) {
        throw new Error(`Identity ${identity.handle} is not paired to agent ${agentKey}.`);
      }
    };

    const createBranchSession = async (sessionOptions: PandaClientSessionOptions = {}): Promise<ThreadRecord> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "create_branch_session",
        payload: {
          identityId: identity.id,
          sessionId: sessionOptions.sessionId,
          agentKey: trimNonEmptyString(sessionOptions.agentKey) ?? undefined,
          model: sessionOptions.model,
          thinking: sessionOptions.thinking,
          ...(sessionOptions.inferenceProjection ? {inferenceProjection: sessionOptions.inferenceProjection} : {}),
        },
      });
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, PANDA_DAEMON_REQUEST_TIMEOUT_MS);
      return store.getThread(result.threadId);
    };

    const openMainSession = async (sessionOptions: PandaClientSessionOptions = {}): Promise<ThreadRecord> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "resolve_main_session_thread",
        payload: {
          identityId: identity.id,
          agentKey: trimNonEmptyString(sessionOptions.agentKey) ?? undefined,
          model: sessionOptions.model,
          thinking: sessionOptions.thinking,
          ...(sessionOptions.inferenceProjection ? {inferenceProjection: sessionOptions.inferenceProjection} : {}),
        },
      });
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, PANDA_DAEMON_REQUEST_TIMEOUT_MS);
      return store.getThread(result.threadId);
    };

    const resetSession = async (
      sessionOptions: PandaClientSessionOptions = {},
    ): Promise<ThreadRecord> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "reset_session",
        payload: {
          identityId: identity.id,
          source: "tui",
          sessionId: trimNonEmptyString(sessionOptions.sessionId) ?? undefined,
          agentKey: trimNonEmptyString(sessionOptions.agentKey) ?? undefined,
          model: sessionOptions.model,
          thinking: sessionOptions.thinking,
          ...(sessionOptions.inferenceProjection ? {inferenceProjection: sessionOptions.inferenceProjection} : {}),
        },
      });
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, PANDA_DAEMON_REQUEST_TIMEOUT_MS);
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
          threadId: trimNonEmptyString(input.threadId) ?? undefined,
          actorId: input.actorId,
          externalMessageId: input.externalMessageId,
          text: input.text,
        },
      });
      return waitForRequestResult<{threadId: string}>(requests, request.id, PANDA_DAEMON_REQUEST_TIMEOUT_MS);
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
      const result = await waitForRequestResult<{aborted?: boolean}>(requests, request.id, PANDA_DAEMON_REQUEST_TIMEOUT_MS);
      return result.aborted === true;
    };

    const waitForCurrentRun = async (threadId: string, timeoutMs = PANDA_DAEMON_REQUEST_TIMEOUT_MS): Promise<void> => {
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
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, PANDA_DAEMON_REQUEST_TIMEOUT_MS);
      return store.getThread(result.threadId);
    };

    const compactThread = async (threadId: string, customInstructions: string): Promise<PandaClientCompactResult> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "compact_thread",
        payload: {
          identityId: identity.id,
          threadId,
          customInstructions,
        },
      });
      return waitForRequestResult<PandaClientCompactResult>(requests, request.id, 15 * 60_000);
    };

    return {
      identity,
      store,
      createBranchSession,
      openMainSession,
      resetSession,
      openSession,
      getThread: (threadId) => store.getThread(threadId),
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
