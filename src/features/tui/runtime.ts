import { randomUUID } from "node:crypto";

import type { ThinkingLevel } from "@mariozechner/pi-ai";

import type { Tool } from "../agent-core/tool.js";
import type { ProviderName } from "../agent-core/types.js";
import {
  createPandaThreadDefinition,
  createPandaRuntime,
} from "../panda/runtime.js";
import {
  createDefaultIdentityInput,
  DEFAULT_IDENTITY_HANDLE,
  type IdentityRecord,
} from "../identity/index.js";
import {
  PostgresHomeThreadStore,
} from "../home-threads/index.js";
import type { IdentityStore } from "../identity/store.js";
import {
  type ThreadRuntimeCoordinator,
  type ThreadRuntimeEvent,
  type ThreadRunRecord,
  type ThreadRecord,
  type ThreadSummaryRecord,
  isMissingThreadError,
} from "../thread-runtime/index.js";
import type { ThreadRuntimeNotification } from "../thread-runtime/postgres.js";
import type { ThreadRuntimeStore } from "../thread-runtime/store.js";

export interface ChatRuntimeOptions {
  cwd: string;
  locale: string;
  timezone: string;
  provider?: ProviderName;
  model?: string;
  identity?: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
  tablePrefix?: string;
  onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}

export interface CreateChatThreadOptions {
  id?: string;
  agentKey?: string;
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface ChatRuntimeServices {
  identity: IdentityRecord;
  identityStore: IdentityStore;
  homeThreads: PostgresHomeThreadStore;
  store: ThreadRuntimeStore;
  coordinator: ThreadRuntimeCoordinator;
  extraTools: readonly Tool[];
  createThread(options?: CreateChatThreadOptions): Promise<ThreadRecord>;
  resolveOrCreateHomeThread(options?: CreateChatThreadOptions): Promise<ThreadRecord>;
  setHomeThread(threadId: string, agentKey?: string): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  listThreadSummaries(limit?: number): Promise<readonly ThreadSummaryRecord[]>;
  recoverOrphanedRuns(reason?: string): Promise<readonly ThreadRunRecord[]>;
  close(): Promise<void>;
}

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}
function assertIdentityThreadAccess(thread: ThreadRecord, identity: IdentityRecord): ThreadRecord {
  if (thread.identityId !== identity.id) {
    throw new Error(`Thread ${thread.id} does not belong to identity ${identity.handle}.`);
  }

  return thread;
}

export async function createChatRuntime(options: ChatRuntimeOptions): Promise<ChatRuntimeServices> {
  const fallbackContext = {
    cwd: options.cwd,
    locale: options.locale,
    timezone: options.timezone,
  } as const;
  const requestedIdentityHandle = trimNonEmptyString(options.identity) ?? DEFAULT_IDENTITY_HANDLE;
  let identity: IdentityRecord | null = null;
  let homeThreads: PostgresHomeThreadStore;
  const runtime = await createPandaRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    tablePrefix: options.tablePrefix,
    onEvent: options.onEvent,
    onStoreNotification: options.onStoreNotification,
    resolveDefinition: (thread, { extraTools }) => {
      if (!identity) {
        throw new Error("Chat runtime identity has not been initialized yet.");
      }

      return createPandaThreadDefinition({
        thread,
        fallbackContext: {
          ...fallbackContext,
          identityId: identity.id,
          identityHandle: identity.handle,
        },
        extraTools,
        extraContext: {
          routeMemory: {
            getLastRoute: async () => homeThreads.resolveLastRoute({
              identityId: thread.identityId,
              agentKey: thread.agentKey,
            }),
            rememberLastRoute: async (route) => {
              await homeThreads.rememberLastRoute({
                identityId: thread.identityId,
                agentKey: thread.agentKey,
                route,
              });
            },
          },
        },
      });
    },
  });

  try {
    identity = requestedIdentityHandle === DEFAULT_IDENTITY_HANDLE
      ? await runtime.identityStore.ensureIdentity(createDefaultIdentityInput())
      : await runtime.identityStore.getIdentityByHandle(requestedIdentityHandle);
  } catch (error) {
    await runtime.close();
    throw error;
  }

  try {
    homeThreads = new PostgresHomeThreadStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await homeThreads.ensureSchema();
  } catch (error) {
    await runtime.close();
    throw error;
  }

  const createThread = async (createOptions: CreateChatThreadOptions = {}): Promise<ThreadRecord> => {
    return runtime.store.createThread({
      id: createOptions.id ?? randomUUID(),
      identityId: identity.id,
      agentKey: createOptions.agentKey ?? "panda",
      context: {
        ...fallbackContext,
        identityId: identity.id,
        identityHandle: identity.handle,
      },
      provider: createOptions.provider ?? options.provider,
      model: createOptions.model ?? options.model,
      thinking: createOptions.thinking,
    });
  };

  const resolveOrCreateHomeThread = async (
    createOptions: CreateChatThreadOptions = {},
  ): Promise<ThreadRecord> => {
    const agentKey = createOptions.agentKey ?? "panda";
    const existing = await homeThreads.resolveHomeThread({
      identityId: identity.id,
      agentKey,
    });

    if (existing) {
      try {
        return assertIdentityThreadAccess(await runtime.store.getThread(existing.threadId), identity);
      } catch (error) {
        if (!isMissingThreadError(error, existing.threadId)) {
          throw error;
        }
      }
    }

    // Missing home means "create a fresh home", not "promote whatever thread was touched last".
    const thread = await createThread({
      ...createOptions,
      agentKey,
    });
    await homeThreads.bindHomeThread({
      identityId: identity.id,
      agentKey,
      threadId: thread.id,
    });
    return thread;
  };

  const setHomeThread = async (threadId: string, agentKey?: string): Promise<ThreadRecord> => {
    const thread = assertIdentityThreadAccess(await runtime.store.getThread(threadId), identity);
    await homeThreads.bindHomeThread({
      identityId: identity.id,
      agentKey: agentKey ?? thread.agentKey,
      threadId: thread.id,
    });
    return thread;
  };

  return {
    identity,
    identityStore: runtime.identityStore,
    homeThreads,
    store: runtime.store,
    coordinator: runtime.coordinator,
    extraTools: runtime.extraTools,
    createThread,
    resolveOrCreateHomeThread,
    setHomeThread,
    getThread: async (threadId) => assertIdentityThreadAccess(await runtime.store.getThread(threadId), identity),
    listThreadSummaries: (limit = 20) => runtime.store.listThreadSummaries(limit, identity.id),
    recoverOrphanedRuns: (reason) => runtime.coordinator.recoverOrphanedRuns(reason),
    close: runtime.close,
  };
}
