import {randomUUID} from "node:crypto";

import type {ThinkingLevel} from "@mariozechner/pi-ai";
import {sleep} from "../../lib/async.js";
import {trimToNull, trimToUndefined} from "../../lib/strings.js";
import {PostgresAgentStore} from "../../domain/agents/postgres.js";
import type {ExecutionToolPolicy} from "../../domain/execution-environments/types.js";
import {PostgresIdentityStore} from "../../domain/identity/postgres.js";
import {type IdentityRecord, normalizeIdentityHandle} from "../../domain/identity/types.js";
import type {JsonValue} from "../../lib/json.js";
import type {CreateRuntimeRequestInput, RuntimeRequestKind, RuntimeThreadUpdate} from "../../domain/threads/requests/types.js";
import {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {DaemonStateRepo} from "./state/repo.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import type {ThreadRuntimeNotification} from "../../domain/threads/runtime/postgres-notifications.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {InferenceProjection, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import {resolveCurrentSessionThread} from "../../domain/sessions/current-thread.js";
import {DAEMON_REQUEST_TIMEOUT_MS, DAEMON_STALE_AFTER_MS, DEFAULT_DAEMON_KEY,} from "./daemon.js";
import {createPostgresPool, requireDatabaseUrl} from "./create-runtime.js";
import {ensureSchemas} from "./postgres-bootstrap.js";
import {listenThreadRuntimeNotifications} from "./store-notifications.js";

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

export interface RuntimeClientWorkerSessionOptions extends RuntimeClientSessionOptions {
  threadId?: string;
  role?: string;
  task: string;
  context?: string;
  credentialAllowlist?: readonly string[];
  environmentId?: string;
  skillAllowlist?: readonly string[];
  toolPolicy?: ExecutionToolPolicy;
  ttlMs?: number;
  parentSessionId?: string;
}

export interface RuntimeClientWorkerSessionResult {
  thread: ThreadRecord;
  sessionId: string;
  threadId: string;
  environmentId: string;
  environment?: {
    id: string;
    runnerCwd?: string;
    rootPath?: string;
    metadata?: JsonValue;
  };
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
  createWorkerSession(options: RuntimeClientWorkerSessionOptions): Promise<RuntimeClientWorkerSessionResult>;
  openMainSession(options?: RuntimeClientSessionOptions): Promise<ThreadRecord>;
  resetSession(options?: RuntimeClientSessionOptions): Promise<ThreadRecord>;
  openSession(sessionRef: string, agentKey?: string): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  resolveThreadRunConfig(threadId: string): Promise<{
    model: string;
    thinking?: ThinkingLevel;
    inferenceProjection?: InferenceProjection;
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
  updateThread(threadId: string, update: RuntimeThreadUpdate): Promise<ThreadRecord>;
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
      unsubscribe = await listenThreadRuntimeNotifications({
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

    const enqueueDaemonRequest = async <
      TResult,
      K extends RuntimeRequestKind = RuntimeRequestKind,
    >(
      input: CreateRuntimeRequestInput<K>,
      timeoutMs = DAEMON_REQUEST_TIMEOUT_MS,
    ): Promise<TResult> => {
      await assertDaemonActive();
      const request = await requests.enqueueRequest(input);
      return waitForRequestResult<TResult>(requests, request.id, timeoutMs);
    };

    const createBranchSession = async (sessionOptions: RuntimeClientSessionOptions = {}): Promise<ThreadRecord> => {
      const result = await enqueueDaemonRequest<{threadId: string}>({
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
      return store.getThread(result.threadId);
    };

    const createWorkerSession = async (
      sessionOptions: RuntimeClientWorkerSessionOptions,
    ): Promise<RuntimeClientWorkerSessionResult> => {
      const sessionId = trimToUndefined(sessionOptions.sessionId) ?? randomUUID();
      const threadId = trimToUndefined(sessionOptions.threadId) ?? randomUUID();
      const result = await enqueueDaemonRequest<{
        threadId: string;
        sessionId: string;
        environmentId: string;
        environment?: RuntimeClientWorkerSessionResult["environment"];
      }>({
        kind: "create_worker_session",
        payload: {
          identityId: identity.id,
          sessionId,
          threadId,
          agentKey: trimToUndefined(sessionOptions.agentKey),
          role: trimToUndefined(sessionOptions.role),
          task: sessionOptions.task,
          context: trimToUndefined(sessionOptions.context),
          model: sessionOptions.model,
          thinking: sessionOptions.thinking,
          ...(sessionOptions.inferenceProjection ? {inferenceProjection: sessionOptions.inferenceProjection} : {}),
          ...(sessionOptions.credentialAllowlist ? {credentialAllowlist: sessionOptions.credentialAllowlist} : {}),
          ...(sessionOptions.environmentId ? {environmentId: trimToUndefined(sessionOptions.environmentId)} : {}),
          ...(sessionOptions.skillAllowlist ? {skillAllowlist: sessionOptions.skillAllowlist} : {}),
          ...(sessionOptions.toolPolicy ? {toolPolicy: sessionOptions.toolPolicy} : {}),
          ...(sessionOptions.ttlMs === undefined ? {} : {ttlMs: sessionOptions.ttlMs}),
          parentSessionId: trimToUndefined(sessionOptions.parentSessionId),
        },
      });
      return {
        thread: await store.getThread(result.threadId),
        sessionId: result.sessionId,
        threadId: result.threadId,
        environmentId: result.environmentId,
        ...(result.environment ? {environment: result.environment} : {}),
      };
    };

    const openMainSession = async (sessionOptions: RuntimeClientSessionOptions = {}): Promise<ThreadRecord> => {
      const result = await enqueueDaemonRequest<{threadId: string}>({
        kind: "resolve_main_session_thread",
        payload: {
          identityId: identity.id,
          agentKey: trimToUndefined(sessionOptions.agentKey),
          model: sessionOptions.model,
          thinking: sessionOptions.thinking,
          ...(sessionOptions.inferenceProjection ? {inferenceProjection: sessionOptions.inferenceProjection} : {}),
        },
      });
      return store.getThread(result.threadId);
    };

    const resetSession = async (
      sessionOptions: RuntimeClientSessionOptions = {},
    ): Promise<ThreadRecord> => {
      const requestedSessionRef = trimToUndefined(sessionOptions.sessionId);
      const requestedAgentKey = trimToUndefined(sessionOptions.agentKey);
      const resolvedSession = requestedSessionRef
        ? await sessionStore.resolveSessionRef({
          sessionRef: requestedSessionRef,
          agentKey: requestedAgentKey,
        })
        : null;
      if (resolvedSession) {
        await assertIdentityCanAccessAgent(resolvedSession.agentKey);
      }

      const result = await enqueueDaemonRequest<{threadId: string}>({
        kind: "reset_session",
        payload: {
          identityId: identity.id,
          source: "tui",
          sessionId: resolvedSession?.id,
          agentKey: requestedAgentKey,
          model: sessionOptions.model,
          thinking: sessionOptions.thinking,
          ...(sessionOptions.inferenceProjection ? {inferenceProjection: sessionOptions.inferenceProjection} : {}),
        },
      });
      return store.getThread(result.threadId);
    };

    const openSession = async (sessionRef: string, agentKey?: string): Promise<ThreadRecord> => {
      const session = await sessionStore.resolveSessionRef({
        sessionRef,
        agentKey: trimToUndefined(agentKey),
      });
      await assertIdentityCanAccessAgent(session.agentKey);
      const {threadId} = await resolveCurrentSessionThread(sessionStore, session.id);
      return store.getThread(threadId);
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
      return enqueueDaemonRequest<{threadId: string}>({
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
    };

    const abortThread = async (threadId: string, reason?: string): Promise<boolean> => {
      const result = await enqueueDaemonRequest<{aborted?: boolean}>({
        kind: "abort_thread",
        payload: {
          identityId: identity.id,
          threadId,
          reason,
        },
      });
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

    const updateThread = async (threadId: string, update: RuntimeThreadUpdate): Promise<ThreadRecord> => {
      const result = await enqueueDaemonRequest<{threadId: string}>({
        kind: "update_thread",
        payload: {
          identityId: identity.id,
          threadId,
          update,
        },
      });
      return store.getThread(result.threadId);
    };

    const compactThread = async (threadId: string, customInstructions: string): Promise<RuntimeClientCompactResult> => {
      return enqueueDaemonRequest<RuntimeClientCompactResult>({
        kind: "compact_thread",
        payload: {
          identityId: identity.id,
          threadId,
          customInstructions,
        },
      }, 15 * 60_000);
    };

    const resolveThreadRunConfig = async (
      threadId: string,
    ): Promise<{model: string; thinking?: ThinkingLevel; inferenceProjection?: InferenceProjection}> => {
      const result = await enqueueDaemonRequest<{
        model: string;
        thinking?: ThinkingLevel | null;
        inferenceProjection?: InferenceProjection;
      }>({
        kind: "resolve_thread_run_config",
        payload: {
          identityId: identity.id,
          threadId,
        },
      });
      return {
        model: result.model,
        thinking: result.thinking ?? undefined,
        ...(result.inferenceProjection ? {inferenceProjection: result.inferenceProjection} : {}),
      };
    };

    return {
      identity,
      store,
      createBranchSession,
      createWorkerSession,
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
