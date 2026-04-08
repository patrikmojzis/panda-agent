import { Pool, type PoolClient } from "pg";

import type { Tool } from "../agent-core/tool.js";
import type { IdentityStore } from "../identity/store.js";
import { PostgresReadonlyQueryTool } from "./tools/postgres-readonly-query-tool.js";
import type { PandaSessionContext } from "./types.js";
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
import {
  ensureReadonlyChatQuerySchema,
  readDatabaseUsername,
} from "../thread-runtime/postgres-readonly.js";
import type { ThreadRuntimeStore } from "../thread-runtime/store.js";
import type {
  ResolvedThreadDefinition,
  ThreadRecord,
} from "../thread-runtime/types.js";
import type { ThreadRuntimeEvent } from "../thread-runtime/coordinator.js";

export interface PandaDefinitionResolverContext {
  identityStore: IdentityStore;
  store: ThreadRuntimeStore;
  extraTools: readonly Tool[];
}

export interface PandaRuntimeOptions {
  dbUrl?: string;
  readOnlyDbUrl?: string;
  tablePrefix?: string;
  onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
  resolveDefinition: (
    thread: ThreadRecord,
    context: PandaDefinitionResolverContext,
  ) => Promise<ResolvedThreadDefinition> | ResolvedThreadDefinition;
}

export interface PandaRuntimeServices {
  identityStore: IdentityStore;
  store: ThreadRuntimeStore;
  coordinator: ThreadRuntimeCoordinator;
  extraTools: readonly Tool[];
  pool: Pool;
  close(): Promise<void>;
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

export function resolveStoredPandaContext(
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

export async function createPandaRuntime(options: PandaRuntimeOptions): Promise<PandaRuntimeServices> {
  const dbUrl = requirePandaDatabaseUrl(options.dbUrl);
  const readOnlyDbUrl =
    trimNonEmptyString(options.readOnlyDbUrl)
    ?? trimNonEmptyString(process.env.PANDA_READONLY_DATABASE_URL);

  let store: ThreadRuntimeStore;
  let identityStore: IdentityStore;
  let pool: Pool;
  let readonlyPool: Pool | null = null;
  let extraTools: readonly Tool[] = [];
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
    pool = postgresPool;
    await ensureReadonlyChatQuerySchema({
      queryable: postgresPool,
      tablePrefix: options.tablePrefix,
      readonlyRole: readOnlyDbUrl ? readDatabaseUsername(readOnlyDbUrl) : null,
    });

    if (readOnlyDbUrl) {
      readonlyPool = createPandaPool(readOnlyDbUrl);
    }

    extraTools = [new PostgresReadonlyQueryTool({
      pool: readonlyPool ?? postgresPool,
    })];

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
    identityStore,
    store,
    coordinator,
    extraTools,
    pool,
    close,
  };
}
