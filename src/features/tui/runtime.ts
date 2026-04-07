import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import type { ThinkingLevel } from "@mariozechner/pi-ai";

import { createDefaultPandaContexts } from "../panda/contexts/index.js";
import { createPandaAgent } from "../panda/agent.js";
import type { PandaProviderName, PandaSessionContext } from "../panda/types.js";
import {
  buildThreadRuntimeNotificationChannel,
  InMemoryThreadRuntimeStore,
  parseThreadRuntimeNotification,
  PostgresThreadLeaseManager,
  PostgresThreadRuntimeStore,
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
  provider?: PandaProviderName;
  model?: string;
  dbUrl?: string;
  tablePrefix?: string;
  defaultAgentKey?: string;
  onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}

export interface CreateChatThreadOptions {
  id?: string;
  agentKey?: string;
  provider?: PandaProviderName;
  model?: string;
  thinking?: ThinkingLevel;
}

export type ChatThreadSummary = ThreadSummaryRecord;

export interface ChatRuntimeServices {
  mode: StorageMode;
  store: ThreadRuntimeStore;
  coordinator: ThreadRuntimeCoordinator;
  createThread(options?: CreateChatThreadOptions): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  listThreadSummaries(limit?: number): Promise<readonly ChatThreadSummary[]>;
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
  fallback: Pick<PandaSessionContext, "cwd" | "locale" | "timezone">,
): PandaSessionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }

  const context = value as Record<string, unknown>;
  return {
    cwd: typeof context.cwd === "string" ? context.cwd : fallback.cwd,
    locale: typeof context.locale === "string" ? context.locale : fallback.locale,
    timezone: typeof context.timezone === "string" ? context.timezone : fallback.timezone,
  };
}

export function resolveChatDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return trimNonEmptyString(env.PANDA_DATABASE_URL) ?? trimNonEmptyString(env.DATABASE_URL);
}

export async function createChatRuntime(options: ChatRuntimeOptions): Promise<ChatRuntimeServices> {
  const dbUrl = trimNonEmptyString(options.dbUrl) ?? resolveChatDatabaseUrl();
  const defaultAgentKey = options.defaultAgentKey ?? "panda";
  const fallbackContext = {
    cwd: options.cwd,
    locale: options.locale,
    timezone: options.timezone,
  } as const;

  let mode: StorageMode = "memory";
  let store: ThreadRuntimeStore;
  let postgresPool: Pool | null = null;
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
    postgresPool = pool;
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
          await pool.end();
        }
      };
    } else {
      close = async () => {
        await pool.end();
      };
    }
  } else {
    store = new InMemoryThreadRuntimeStore();
  }

  const coordinator = new ThreadRuntimeCoordinator({
    store,
    leaseManager: postgresPool ? new PostgresThreadLeaseManager(postgresPool) : undefined,
    resolveDefinition: (thread) => {
      const context = resolveStoredContext(thread.context, fallbackContext);
      return {
        agent: createPandaAgent({
          name: thread.agentKey,
          promptAdditions: options.instructions,
        }),
        context,
        llmContexts: createDefaultPandaContexts({
          cwd: context.cwd ?? options.cwd,
          locale: context.locale ?? options.locale,
          timeZone: context.timezone ?? options.timezone,
        }),
      };
    },
    onEvent: options.onEvent,
  });

  const createThread = async (createOptions: CreateChatThreadOptions = {}): Promise<ThreadRecord> => {
    return store.createThread({
      id: createOptions.id ?? randomUUID(),
      agentKey: createOptions.agentKey ?? defaultAgentKey,
      context: {
        ...fallbackContext,
      },
      provider: createOptions.provider ?? options.provider,
      model: createOptions.model ?? options.model,
      thinking: createOptions.thinking,
    });
  };

  const listThreadSummaries = async (limit = 20): Promise<readonly ChatThreadSummary[]> => {
    return store.listThreadSummaries(limit);
  };

  return {
    mode,
    store,
    coordinator,
    createThread,
    getThread: (threadId) => store.getThread(threadId),
    listThreadSummaries,
    recoverOrphanedRuns: (reason) => coordinator.recoverOrphanedRuns(reason),
    close,
  };
}
