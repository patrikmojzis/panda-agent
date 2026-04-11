import type {PoolClient} from "pg";

import type {ThinkingLevel} from "@mariozechner/pi-ai";
import {type AgentRecord, PostgresAgentStore} from "../../domain/agents/index.js";
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
import type {
    InferenceProjection,
    ThreadRecord,
    ThreadSummaryRecord,
    ThreadUpdate,
} from "../../domain/threads/runtime/types.js";
import {DEFAULT_PANDA_DAEMON_KEY, PANDA_DAEMON_REQUEST_TIMEOUT_MS, PANDA_DAEMON_STALE_AFTER_MS,} from "./daemon.js";
import {createPandaPool, requirePandaDatabaseUrl} from "./create-runtime.js";

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

export interface PandaClientThreadOptions {
  id?: string;
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
  getAgent(agentKey: string): Promise<AgentRecord>;
  createThread(options?: PandaClientThreadOptions): Promise<ThreadRecord>;
  resolveOrCreateHomeThread(options?: PandaClientThreadOptions): Promise<ThreadRecord>;
  resetHomeThread(options?: Omit<PandaClientThreadOptions, "id">): Promise<ThreadRecord>;
  switchHomeAgent(agentKey: string): Promise<{thread: ThreadRecord; previousThreadId?: string | null}>;
  getThread(threadId: string): Promise<ThreadRecord>;
  listThreadSummaries(limit?: number): Promise<readonly ThreadSummaryRecord[]>;
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
  const store = new PostgresThreadRuntimeStore({
    pool,
    tablePrefix,
    identityStore,
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
    await store.ensureSchema();
    await agentStore.ensureSchema();
    await requests.ensureSchema();
    await daemonState.ensureSchema();

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

    const createThread = async (threadOptions: PandaClientThreadOptions = {}): Promise<ThreadRecord> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "create_thread",
        payload: {
          identityId: identity.id,
          id: threadOptions.id,
          agentKey: trimNonEmptyString(threadOptions.agentKey) ?? undefined,
          model: threadOptions.model,
          thinking: threadOptions.thinking,
          ...(threadOptions.inferenceProjection ? {inferenceProjection: threadOptions.inferenceProjection} : {}),
        },
      });
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, PANDA_DAEMON_REQUEST_TIMEOUT_MS);
      return store.getThread(result.threadId);
    };

    const resolveOrCreateHomeThread = async (threadOptions: PandaClientThreadOptions = {}): Promise<ThreadRecord> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "resolve_home_thread",
        payload: {
          identityId: identity.id,
          agentKey: trimNonEmptyString(threadOptions.agentKey) ?? undefined,
          model: threadOptions.model,
          thinking: threadOptions.thinking,
          ...(threadOptions.inferenceProjection ? {inferenceProjection: threadOptions.inferenceProjection} : {}),
        },
      });
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, PANDA_DAEMON_REQUEST_TIMEOUT_MS);
      return store.getThread(result.threadId);
    };

    const resetHomeThread = async (
      threadOptions: Omit<PandaClientThreadOptions, "id"> = {},
    ): Promise<ThreadRecord> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "reset_home_thread",
        payload: {
          identityId: identity.id,
          source: "tui",
          agentKey: trimNonEmptyString(threadOptions.agentKey) ?? undefined,
          model: threadOptions.model,
          thinking: threadOptions.thinking,
          ...(threadOptions.inferenceProjection ? {inferenceProjection: threadOptions.inferenceProjection} : {}),
        },
      });
      const result = await waitForRequestResult<{threadId: string}>(requests, request.id, PANDA_DAEMON_REQUEST_TIMEOUT_MS);
      return store.getThread(result.threadId);
    };

    const switchHomeAgent = async (agentKey: string): Promise<{thread: ThreadRecord; previousThreadId?: string | null}> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest({
        kind: "switch_home_agent",
        payload: {
          identityId: identity.id,
          agentKey: trimNonEmptyString(agentKey) ?? agentKey,
        },
      });
      const result = await waitForRequestResult<{threadId: string; previousThreadId?: string | null}>(
        requests,
        request.id,
        PANDA_DAEMON_REQUEST_TIMEOUT_MS,
      );
      return {
        thread: await store.getThread(result.threadId),
        previousThreadId: result.previousThreadId,
      };
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
      getAgent: (agentKey) => agentStore.getAgent(agentKey),
      createThread,
      resolveOrCreateHomeThread,
      resetHomeThread,
      switchHomeAgent,
      getThread: (threadId) => store.getThread(threadId),
      listThreadSummaries: (limit = 20) => store.listThreadSummaries(limit, identity.id),
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
