import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import type { ThinkingLevel } from "@mariozechner/pi-ai";

import { Agent } from "../agent-core/agent.js";
import type { Tool } from "../agent-core/tool.js";
import type { ProviderName } from "../agent-core/types.js";
import { buildPandaTools } from "../panda/agent.js";
import { DateTimeContext, EnvironmentContext } from "../panda/contexts/index.js";
import { buildPandaPrompt } from "../panda/prompts.js";
import { PostgresReadonlyQueryTool } from "../panda/tools/postgres-readonly-query-tool.js";
import type { PandaSessionContext } from "../panda/types.js";
import {
  createDefaultIdentityInput,
  DEFAULT_IDENTITY_HANDLE,
  type IdentityRecord,
  type IdentityStore,
} from "../identity/index.js";
import {
  buildThreadRuntimeNotificationChannel,
  ensureReadonlyChatQuerySchema,
  InMemoryThreadRuntimeStore,
  parseThreadRuntimeNotification,
  PostgresThreadLeaseManager,
  PostgresThreadRuntimeStore,
  readDatabaseUsername,
  ThreadRuntimeCoordinator,
  type ThreadRuntimeNotification,
  type ThreadRuntimeEvent,
  type ThreadRuntimeStore,
  type ThreadRunRecord,
  type ThreadRecord,
  type ThreadSummaryRecord,
} from "../thread-runtime/index.js";

type StorageMode = "memory" | "postgres";

export interface ChatRuntimeOptions {
  cwd: string;
  locale: string;
  timezone: string;
  instructions?: string;
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
  mode: StorageMode;
  identity: IdentityRecord;
  identityStore: IdentityStore;
  store: ThreadRuntimeStore;
  coordinator: ThreadRuntimeCoordinator;
  extraTools: readonly Tool[];
  createThread(options?: CreateChatThreadOptions): Promise<ThreadRecord>;
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

function resolveStoredContext(
  value: ThreadRecord["context"],
  fallback: Pick<PandaSessionContext, "cwd" | "locale" | "timezone" | "identityId" | "identityHandle">,
): PandaSessionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }

  const context = value as Record<string, unknown>;
  return {
    cwd: typeof context.cwd === "string" ? context.cwd : fallback.cwd,
    locale: typeof context.locale === "string" ? context.locale : fallback.locale,
    timezone: typeof context.timezone === "string" ? context.timezone : fallback.timezone,
    identityId: typeof context.identityId === "string" ? context.identityId : fallback.identityId,
    identityHandle: typeof context.identityHandle === "string" ? context.identityHandle : fallback.identityHandle,
  };
}

function assertIdentityThreadAccess(thread: ThreadRecord, identity: IdentityRecord): ThreadRecord {
  if (thread.identityId !== identity.id) {
    throw new Error(`Thread ${thread.id} does not belong to identity ${identity.handle}.`);
  }

  return thread;
}

export async function createChatRuntime(options: ChatRuntimeOptions): Promise<ChatRuntimeServices> {
  const dbUrl =
    trimNonEmptyString(options.dbUrl)
    ?? trimNonEmptyString(process.env.PANDA_DATABASE_URL)
    ?? trimNonEmptyString(process.env.DATABASE_URL);
  const readOnlyDbUrl =
    trimNonEmptyString(options.readOnlyDbUrl)
    ?? trimNonEmptyString(process.env.PANDA_READONLY_DATABASE_URL);
  const fallbackContext = {
    cwd: options.cwd,
    locale: options.locale,
    timezone: options.timezone,
  } as const;
  const requestedIdentityHandle = trimNonEmptyString(options.identity) ?? DEFAULT_IDENTITY_HANDLE;

  let mode: StorageMode = "memory";
  let store: ThreadRuntimeStore;
  let identityStore: IdentityStore;
  let postgresPool: Pool | null = null;
  let readonlyPool: Pool | null = null;
  let extraTools: readonly Tool[] = [];
  let close = async (): Promise<void> => {};

  if (dbUrl) {
    const pool = new Pool({
      connectionString: dbUrl,
    });
    const postgresStore = new PostgresThreadRuntimeStore({
      pool,
      tablePrefix: options.tablePrefix,
    });
    await postgresStore.ensureSchema();

    mode = "postgres";
    store = postgresStore;
    identityStore = postgresStore.identityStore;
    postgresPool = pool;
    await ensureReadonlyChatQuerySchema({
      queryable: pool,
      tablePrefix: options.tablePrefix,
      readonlyRole: readOnlyDbUrl ? readDatabaseUsername(readOnlyDbUrl) : null,
    });

    if (readOnlyDbUrl) {
      readonlyPool = new Pool({
        connectionString: readOnlyDbUrl,
      });
    }
    extraTools = [new PostgresReadonlyQueryTool({
      pool: readonlyPool ?? pool,
    })];
    if (options.onStoreNotification) {
      const channel = buildThreadRuntimeNotificationChannel(options.tablePrefix ?? "thread_runtime");
      const client = await pool.connect();
      const handleNotification = (message: { channel: string; payload?: string }) => {
        if (message.channel !== channel || typeof message.payload !== "string") {
          return;
        }

        const parsed = parseThreadRuntimeNotification(message.payload);
        if (!parsed) {
          return;
        }

        void options.onStoreNotification?.(parsed);
      };

      client.on("notification", handleNotification);
      await client.query(`LISTEN ${channel}`);

      close = async () => {
        client.off("notification", handleNotification);
        try {
          await client.query(`UNLISTEN ${channel}`);
        } finally {
          client.release();
          if (readonlyPool) {
            await readonlyPool.end();
          }
          await pool.end();
        }
      };
    } else {
      close = async () => {
        if (readonlyPool) {
          await readonlyPool.end();
        }
        await pool.end();
      };
    }
  } else {
    const inMemoryStore = new InMemoryThreadRuntimeStore();
    store = inMemoryStore;
    identityStore = inMemoryStore.identityStore;
  }

  const identity = requestedIdentityHandle === DEFAULT_IDENTITY_HANDLE
    ? await identityStore.ensureIdentity(createDefaultIdentityInput())
    : await identityStore.getIdentityByHandle(requestedIdentityHandle);

  const coordinator = new ThreadRuntimeCoordinator({
    store,
    leaseManager: postgresPool ? new PostgresThreadLeaseManager(postgresPool) : undefined,
    resolveDefinition: (thread) => {
      const context: PandaSessionContext = {
        ...resolveStoredContext(thread.context, {
          ...fallbackContext,
          identityId: identity.id,
          identityHandle: identity.handle,
        }),
        threadId: thread.id,
        agentKey: thread.agentKey,
        identityId: identity.id,
        identityHandle: identity.handle,
      };
      return {
        agent: new Agent({
          name: thread.agentKey,
          instructions: buildPandaPrompt(options.instructions),
          tools: buildPandaTools(extraTools),
        }),
        context,
        llmContexts: [
          new DateTimeContext({
            locale: context.locale ?? options.locale,
            timeZone: context.timezone ?? options.timezone,
          }),
          new EnvironmentContext({
            cwd: context.cwd ?? options.cwd,
          }),
        ],
      };
    },
    onEvent: options.onEvent,
  });

  const createThread = async (createOptions: CreateChatThreadOptions = {}): Promise<ThreadRecord> => {
    return store.createThread({
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

  return {
    mode,
    identity,
    identityStore,
    store,
    coordinator,
    extraTools,
    createThread,
    getThread: async (threadId) => assertIdentityThreadAccess(await store.getThread(threadId), identity),
    listThreadSummaries: (limit = 20) => store.listThreadSummaries(limit, identity.id),
    recoverOrphanedRuns: (reason) => coordinator.recoverOrphanedRuns(reason),
    close,
  };
}
