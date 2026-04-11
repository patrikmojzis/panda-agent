import {Pool, type PoolClient} from "pg";

import {type AgentStore, PostgresAgentStore} from "../../domain/agents/index.js";
import {
    CredentialResolver,
    CredentialService,
    PostgresCredentialStore,
    resolveCredentialCrypto,
} from "../../domain/credentials/index.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import {PostgresScheduledTaskStore, type ScheduledTaskStore,} from "../../domain/scheduling/tasks/index.js";
import {PostgresHomeThreadStore} from "../../domain/threads/home/index.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/index.js";
import {
    buildThreadRuntimeNotificationChannel,
    parseThreadRuntimeNotification,
} from "../../domain/threads/runtime/postgres.js";
import {ensureReadonlyChatQuerySchema, readDatabaseUsername,} from "../../domain/threads/runtime/postgres-readonly.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {Tool} from "../../kernel/agent/tool.js";
import {AgentDocumentTool} from "../../personas/panda/tools/agent-document-tool.js";
import {ClearEnvValueTool, SetEnvValueTool} from "../../personas/panda/tools/env-value-tools.js";
import {PostgresReadonlyQueryTool} from "../../personas/panda/tools/postgres-readonly-query-tool.js";
import {
    ScheduledTaskCancelTool,
    ScheduledTaskCreateTool,
    ScheduledTaskUpdateTool,
} from "../../personas/panda/tools/scheduled-task-tools.js";
import {SpawnSubagentTool} from "../../personas/panda/tools/spawn-subagent-tool.js";
import {PandaSubagentService} from "../../personas/panda/subagents/service.js";
import {createPandaPool} from "./database.js";
import type {PandaRuntimeOptions} from "./create-runtime.js";

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export interface RuntimeBootstrapOptions extends Omit<PandaRuntimeOptions, "dbUrl"> {
  dbUrl: string;
}

export interface RuntimeBootstrapResult {
  agentStore: AgentStore;
  credentialResolver: CredentialResolver;
  identityStore: IdentityStore;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
  extraTools: readonly Tool[];
  pool: Pool;
  close(): Promise<void>;
}

function createCloseRuntime(options: {
  postgresPool: Pool;
  readonlyPool: Pool | null;
  notificationClient: PoolClient | null;
  notificationChannel: string | null;
  notificationHandler: ((message: { channel: string; payload?: string }) => void) | null;
}): () => Promise<void> {
  return async () => {
    if (options.notificationClient && options.notificationHandler && options.notificationChannel) {
      options.notificationClient.off("notification", options.notificationHandler);
      try {
        await options.notificationClient.query(`UNLISTEN ${options.notificationChannel}`);
      } finally {
        options.notificationClient.release();
      }
    }

    if (options.readonlyPool) {
      await options.readonlyPool.end();
    }
    await options.postgresPool.end();
  };
}

export async function bootstrapPandaRuntime(
  options: RuntimeBootstrapOptions,
): Promise<RuntimeBootstrapResult> {
  const readOnlyDbUrl =
    trimNonEmptyString(options.readOnlyDbUrl)
    ?? trimNonEmptyString(process.env.PANDA_READONLY_DATABASE_URL);

  let readonlyPool: Pool | null = null;
  let notificationClient: PoolClient | null = null;
  let notificationHandler: ((message: { channel: string; payload?: string }) => void) | null = null;
  let notificationChannel: string | null = null;
  const maxSubagentDepth = options.maxSubagentDepth ?? 1;

  const postgresPool = createPandaPool(options.dbUrl);

  try {
    const store = new PostgresThreadRuntimeStore({
      pool: postgresPool,
      tablePrefix: options.tablePrefix,
    });
    await store.ensureSchema();

    const identityStore = store.identityStore;
    const agentStore = new PostgresAgentStore({
      pool: postgresPool,
      tablePrefix: options.tablePrefix,
    });
    await agentStore.ensureSchema();

    const credentialStore = new PostgresCredentialStore({
      pool: postgresPool,
      tablePrefix: options.tablePrefix,
    });
    await credentialStore.ensureSchema();

    const credentialCrypto = resolveCredentialCrypto();
    const credentialResolver = new CredentialResolver({
      store: credentialStore,
      crypto: credentialCrypto,
    });
    const credentialService = credentialCrypto
      ? new CredentialService({
        store: credentialStore,
        crypto: credentialCrypto,
      })
      : null;

    const scheduledTasks = new PostgresScheduledTaskStore({
      pool: postgresPool,
      tablePrefix: options.tablePrefix,
    });
    await scheduledTasks.ensureSchema();

    await new PostgresHomeThreadStore({
      pool: postgresPool,
      tablePrefix: options.tablePrefix,
    }).ensureSchema();

    await ensureReadonlyChatQuerySchema({
      queryable: postgresPool,
      tablePrefix: options.tablePrefix,
      readonlyRole: readOnlyDbUrl ? readDatabaseUsername(readOnlyDbUrl) : null,
    });

    if (readOnlyDbUrl) {
      readonlyPool = createPandaPool(readOnlyDbUrl);
    }

    let extraTools: readonly Tool[] = [];
    const subagentService = new PandaSubagentService({
      store,
      resolveDefinition: (thread) => options.resolveDefinition(thread, {
        agentStore,
        credentialResolver,
        identityStore,
        store,
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
      ...(credentialService
        ? [
          new SetEnvValueTool({
            service: credentialService,
          }),
          new ClearEnvValueTool({
            service: credentialService,
          }),
        ]
        : []),
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
      notificationChannel = buildThreadRuntimeNotificationChannel(options.tablePrefix ?? "thread_runtime");
      notificationClient = await postgresPool.connect();
      notificationHandler = (message: { channel: string; payload?: string }) => {
        if (message.channel !== notificationChannel || typeof message.payload !== "string") {
          return;
        }

        const parsed = parseThreadRuntimeNotification(message.payload);
        if (!parsed) {
          return;
        }

        void options.onStoreNotification?.(parsed);
      };

      notificationClient.on("notification", notificationHandler);
      await notificationClient.query(`LISTEN ${notificationChannel}`);
    }

    return {
      agentStore,
      credentialResolver,
      identityStore,
      store,
      scheduledTasks,
      extraTools,
      pool: postgresPool,
      close: createCloseRuntime({
        postgresPool,
        readonlyPool,
        notificationClient,
        notificationChannel,
        notificationHandler,
      }),
    };
  } catch (error) {
    await createCloseRuntime({
      postgresPool,
      readonlyPool,
      notificationClient,
      notificationChannel,
      notificationHandler,
    })().catch(() => undefined);
    throw error;
  }
}
