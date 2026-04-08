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
  dbUrl?: string;
  readOnlyDbUrl?: string;
  tablePrefix?: string;
  defaultAgentKey?: string;
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

export async function createChatRuntime(options: ChatRuntimeOptions): Promise<ChatRuntimeServices> {
  const dbUrl =
    trimNonEmptyString(options.dbUrl)
    ?? trimNonEmptyString(process.env.PANDA_DATABASE_URL)
    ?? trimNonEmptyString(process.env.DATABASE_URL);
  const readOnlyDbUrl =
    trimNonEmptyString(options.readOnlyDbUrl)
    ?? trimNonEmptyString(process.env.PANDA_READONLY_DATABASE_URL);
  const defaultAgentKey = options.defaultAgentKey ?? "panda";
  const fallbackContext = {
    cwd: options.cwd,
    locale: options.locale,
    timezone: options.timezone,
  } as const;

  let mode: StorageMode = "memory";
  let store: ThreadRuntimeStore;
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
    store = new InMemoryThreadRuntimeStore();
  }

  const coordinator = new ThreadRuntimeCoordinator({
    store,
    leaseManager: postgresPool ? new PostgresThreadLeaseManager(postgresPool) : undefined,
    resolveDefinition: (thread) => {
      const context: PandaSessionContext = {
        ...resolveStoredContext(thread.context, fallbackContext),
        threadId: thread.id,
        agentKey: thread.agentKey,
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
      agentKey: createOptions.agentKey ?? defaultAgentKey,
      context: {
        ...fallbackContext,
      },
      provider: createOptions.provider ?? options.provider,
      model: createOptions.model ?? options.model,
      thinking: createOptions.thinking,
    });
  };

  return {
    mode,
    store,
    coordinator,
    extraTools,
    createThread,
    getThread: (threadId) => store.getThread(threadId),
    listThreadSummaries: (limit = 20) => store.listThreadSummaries(limit),
    recoverOrphanedRuns: (reason) => coordinator.recoverOrphanedRuns(reason),
    close,
  };
}
