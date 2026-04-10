import {Pool, type PoolClient} from "pg";

import {Agent} from "../agent-core/agent.js";
import type {LlmContext} from "../agent-core/llm-context.js";
import {type AgentStore, PostgresAgentStore} from "../agents/index.js";
import type {Tool} from "../agent-core/tool.js";
import type {IdentityStore} from "../identity/store.js";
import {PostgresHomeThreadStore} from "../home-threads/index.js";
import {buildPandaTools} from "./agent.js";
import {buildPandaLlmContexts, type PandaLlmContextSection} from "./contexts/index.js";
import {PANDA_PROMPT} from "./prompts.js";
import {PostgresScheduledTaskStore, type ScheduledTaskStore} from "../scheduled-tasks/index.js";
import {AgentDocumentTool} from "./tools/agent-document-tool.js";
import {PostgresReadonlyQueryTool} from "./tools/postgres-readonly-query-tool.js";
import {
    ScheduledTaskCancelTool,
    ScheduledTaskCreateTool,
    ScheduledTaskUpdateTool,
} from "./tools/scheduled-task-tools.js";
import {SpawnSubagentTool} from "./tools/spawn-subagent-tool.js";
import type {PandaSessionContext} from "./types.js";
import {PandaSubagentService} from "./subagents/index.js";
import {
    PostgresThreadLeaseManager,
    PostgresThreadRuntimeStore,
    ThreadRuntimeCoordinator,
} from "../thread-runtime/index.js";
import {
    buildThreadRuntimeNotificationChannel,
    parseThreadRuntimeNotification,
    type ThreadRuntimeNotification,
} from "../thread-runtime/postgres.js";
import {ensureReadonlyChatQuerySchema, readDatabaseUsername,} from "../thread-runtime/postgres-readonly.js";
import type {ThreadRuntimeStore} from "../thread-runtime/store.js";
import type {InferenceProjection, ResolvedThreadDefinition, ThreadRecord,} from "../thread-runtime/types.js";
import type {ThreadRuntimeEvent} from "../thread-runtime/coordinator.js";
import {mergeInferenceProjection} from "../thread-runtime/inference-projection.js";
import {resolveRemoteInitialCwd} from "./tools/bash-executor.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_PANDA_INFERENCE_PROJECTION: InferenceProjection = {
  dropToolCalls: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 13
  },
  dropThinking: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 13
  },
  dropImages: {
    olderThanMs: 4 * HOUR_MS,
    preserveRecentUserTurns: 13
  },
  dropMessages: {
    olderThanMs: 1 * DAY_MS,
  },
};

export interface PandaDefinitionResolverContext {
  agentStore: AgentStore;
  identityStore: IdentityStore;
  store: ThreadRuntimeStore;
  extraTools: readonly Tool[];
}

export interface PandaRuntimeOptions {
  dbUrl?: string;
  readOnlyDbUrl?: string;
  maxSubagentDepth?: number;
  tablePrefix?: string;
  onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
  resolveDefinition: (
    thread: ThreadRecord,
    context: PandaDefinitionResolverContext,
  ) => Promise<ResolvedThreadDefinition> | ResolvedThreadDefinition;
}

export interface PandaRuntimeServices {
  agentStore: AgentStore;
  identityStore: IdentityStore;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
  coordinator: ThreadRuntimeCoordinator;
  extraTools: readonly Tool[];
  pool: Pool;
  close(): Promise<void>;
}

export interface CreatePandaThreadDefinitionOptions {
  thread: ThreadRecord;
  fallbackContext: Pick<PandaSessionContext, "cwd" | "identityId" | "identityHandle">;
  agentStore?: AgentStore;
  extraTools?: readonly Tool[];
  extraLlmContexts?: readonly LlmContext[];
  llmContextSections?: readonly PandaLlmContextSection[];
  extraContext?: Omit<
    PandaSessionContext,
    "cwd" | "timezone" | "identityId" | "identityHandle" | "threadId" | "agentKey" | "subagentDepth"
  >;
}

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function resolvePandaDatabaseUrl(explicitDbUrl?: string): string | null {
  return (
    trimNonEmptyString(explicitDbUrl)
    ?? trimNonEmptyString(process.env.PANDA_DATABASE_URL)
    ?? trimNonEmptyString(process.env.DATABASE_URL)
  );
}

export function requirePandaDatabaseUrl(explicitDbUrl?: string): string {
  const dbUrl = resolvePandaDatabaseUrl(explicitDbUrl);
  if (dbUrl) {
    return dbUrl;
  }

  throw new Error("Panda requires Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
}

export function createPandaPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStoredShellCwd(value: Record<string, unknown>): boolean {
  const shell = value.shell;
  return isRecord(shell) && typeof shell.cwd === "string" && shell.cwd.trim().length > 0;
}

export function resolveStoredPandaContext(
  value: ThreadRecord["context"],
  fallback: Pick<PandaSessionContext, "cwd" | "identityId" | "identityHandle">,
  agentKey?: string,
): PandaSessionContext {
  const remoteInitialCwd = agentKey ? resolveRemoteInitialCwd(agentKey) : null;
  if (!isRecord(value)) {
    return {
      ...fallback,
      ...(remoteInitialCwd ? {cwd: remoteInitialCwd} : {}),
    };
  }

  const context = value;
  const storedCwd = typeof context.cwd === "string" && context.cwd.trim().length > 0
    ? context.cwd
    : null;
  const useRemoteInitialCwd = Boolean(
    remoteInitialCwd
    && !hasStoredShellCwd(context)
    && (!storedCwd || storedCwd === fallback.cwd),
  );

  return {
    cwd: useRemoteInitialCwd && remoteInitialCwd ? remoteInitialCwd : storedCwd ?? fallback.cwd,
    timezone: typeof context.timezone === "string" ? context.timezone : undefined,
    identityId: typeof context.identityId === "string" ? context.identityId : fallback.identityId,
    identityHandle: typeof context.identityHandle === "string" ? context.identityHandle : fallback.identityHandle,
  };
}

export function createPandaThreadDefinition(
  options: CreatePandaThreadDefinitionOptions,
): ResolvedThreadDefinition {
  const context: PandaSessionContext = {
    ...resolveStoredPandaContext(options.thread.context, options.fallbackContext, options.thread.agentKey),
    threadId: options.thread.id,
    agentKey: options.thread.agentKey,
    identityId: options.fallbackContext.identityId,
    identityHandle: options.fallbackContext.identityHandle,
    subagentDepth: 0,
    ...options.extraContext,
  };
  const resolvedIdentityId = context.identityId ?? options.fallbackContext.identityId;
  if (!resolvedIdentityId) {
    throw new Error(`Missing identityId for thread ${options.thread.id}.`);
  }

  const llmContexts: LlmContext[] = buildPandaLlmContexts({
    context,
    agentStore: options.agentStore,
    agentKey: options.thread.agentKey,
    identityId: resolvedIdentityId,
    sections: options.llmContextSections,
    extraLlmContexts: options.extraLlmContexts,
  });

  return {
    agent: new Agent({
      name: options.thread.agentKey,
      instructions: PANDA_PROMPT,
      tools: buildPandaTools(options.extraTools),
    }),
    context,
    llmContexts,
    inferenceProjection: mergeInferenceProjection(
      DEFAULT_PANDA_INFERENCE_PROJECTION,
      options.thread.inferenceProjection,
    ),
  };
}

export async function createPandaRuntime(options: PandaRuntimeOptions): Promise<PandaRuntimeServices> {
  const dbUrl = requirePandaDatabaseUrl(options.dbUrl);
  const readOnlyDbUrl =
    trimNonEmptyString(options.readOnlyDbUrl)
    ?? trimNonEmptyString(process.env.PANDA_READONLY_DATABASE_URL);

  let store: ThreadRuntimeStore;
  let agentStore: AgentStore;
  let identityStore: IdentityStore;
  let pool: Pool;
  let scheduledTasks: ScheduledTaskStore;
  let readonlyPool: Pool | null = null;
  let extraTools: readonly Tool[] = [];
  const maxSubagentDepth = options.maxSubagentDepth ?? 1;
  let close = async (): Promise<void> => {};

  const postgresPool = createPandaPool(dbUrl);
  let notificationClient: PoolClient | null = null;
  let notificationHandler: ((message: { channel: string; payload?: string }) => void) | null = null;

  try {
    const postgresStore = new PostgresThreadRuntimeStore({
      pool: postgresPool,
      tablePrefix: options.tablePrefix,
    });
    await postgresStore.ensureSchema();

    store = postgresStore;
    identityStore = postgresStore.identityStore;
    agentStore = new PostgresAgentStore({
      pool: postgresPool,
      tablePrefix: options.tablePrefix,
    });
    await agentStore.ensureSchema();
    scheduledTasks = new PostgresScheduledTaskStore({
      pool: postgresPool,
      tablePrefix: options.tablePrefix,
    });
    await scheduledTasks.ensureSchema();
    await new PostgresHomeThreadStore({
      pool: postgresPool,
      tablePrefix: options.tablePrefix,
    }).ensureSchema();
    pool = postgresPool;
    await ensureReadonlyChatQuerySchema({
      queryable: postgresPool,
      tablePrefix: options.tablePrefix,
      readonlyRole: readOnlyDbUrl ? readDatabaseUsername(readOnlyDbUrl) : null,
    });

    if (readOnlyDbUrl) {
      readonlyPool = createPandaPool(readOnlyDbUrl);
    }

    const subagentService = new PandaSubagentService({
      store: postgresStore,
      resolveDefinition: (thread) => options.resolveDefinition(thread, {
        agentStore,
        identityStore,
        store: postgresStore,
        extraTools,
      }),
      agentStore,
      maxSubagentDepth,
    });

    extraTools = [
      new SpawnSubagentTool({
        service: subagentService,
      }),
      new AgentDocumentTool({
        store: agentStore,
      }),
      new PostgresReadonlyQueryTool({
        pool: readonlyPool ?? postgresPool,
      }),
      new ScheduledTaskCreateTool({
        store: scheduledTasks,
      }),
      new ScheduledTaskUpdateTool({
        store: scheduledTasks,
      }),
      new ScheduledTaskCancelTool({
        store: scheduledTasks,
      }),
    ];

    if (options.onStoreNotification) {
      const channel = buildThreadRuntimeNotificationChannel(options.tablePrefix ?? "thread_runtime");
      const client = await postgresPool.connect();
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

      notificationClient = client;
      notificationHandler = handleNotification;
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
          await postgresPool.end();
        }
      };
    } else {
      close = async () => {
        if (readonlyPool) {
          await readonlyPool.end();
        }
        await postgresPool.end();
      };
    }
  } catch (error) {
    if (notificationClient && notificationHandler) {
      notificationClient.off("notification", notificationHandler);
    }
    if (notificationClient) {
      notificationClient.release();
    }
    try {
      if (readonlyPool) {
        await readonlyPool.end();
      }
    } finally {
      await postgresPool.end();
    }
    throw error;
  }

  const resolverContext: PandaDefinitionResolverContext = {
    agentStore,
    identityStore,
    store,
    extraTools,
  };

  const coordinator = new ThreadRuntimeCoordinator({
    store,
    leaseManager: new PostgresThreadLeaseManager(pool),
    resolveDefinition: (thread) => options.resolveDefinition(thread, resolverContext),
    onEvent: options.onEvent,
  });

  return {
    agentStore,
    identityStore,
    store,
    scheduledTasks,
    coordinator,
    extraTools,
    pool,
    close,
  };
}
