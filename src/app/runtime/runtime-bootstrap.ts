import {Pool, type PoolClient} from "pg";

import {type AgentStore, PostgresAgentStore} from "../../domain/agents/index.js";
import {
    CredentialResolver,
    CredentialService,
    PostgresCredentialStore,
    resolveCredentialCrypto,
} from "../../domain/credentials/index.js";
import {PostgresIdentityStore} from "../../domain/identity/index.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import {PostgresScheduledTaskStore, type ScheduledTaskStore,} from "../../domain/scheduling/tasks/index.js";
import {PostgresSessionStore, type SessionStore} from "../../domain/sessions/index.js";
import {WatchMutationService} from "../../domain/watches/mutation-service.js";
import {PostgresWatchStore, type WatchStore,} from "../../domain/watches/index.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/index.js";
import {
    buildThreadRuntimeNotificationChannel,
    parseThreadRuntimeNotification,
} from "../../domain/threads/runtime/postgres.js";
import {
    ensureReadonlySessionQuerySchema,
    readDatabaseUsername,
} from "../../domain/threads/runtime/postgres-readonly.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {Tool} from "../../kernel/agent/tool.js";
import {buildDefaultAgentToolsetsFromRegistry, createDefaultAgentToolRegistry,} from "../../panda/definition.js";
import {AgentDocumentTool} from "../../panda/tools/agent-document-tool.js";
import {AgentSkillTool} from "../../panda/tools/agent-skill-tool.js";
import {BrowserRunnerClient} from "../../integrations/browser/client.js";
import {createWatchEvaluator} from "../../integrations/watches/evaluator.js";
import {ClearEnvValueTool, SetEnvValueTool} from "../../panda/tools/env-value-tools.js";
import {
    ScheduledTaskCancelTool,
    ScheduledTaskCreateTool,
    ScheduledTaskUpdateTool,
} from "../../panda/tools/scheduled-task-tools.js";
import {WatchCreateTool, WatchDisableTool, WatchUpdateTool,} from "../../panda/tools/watch-tools.js";
import {SpawnSubagentTool} from "../../panda/tools/spawn-subagent-tool.js";
import {ThinkingSetTool} from "../../panda/tools/thinking-set-tool.js";
import {DefaultAgentSubagentService} from "../../panda/subagents/service.js";
import {BashJobService} from "../../integrations/shell/bash-job-service.js";
import {createPostgresPool} from "./database.js";
import {ensureSchemas} from "./postgres-bootstrap.js";
import type {RuntimeOptions} from "./create-runtime.js";

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export interface RuntimeBootstrapOptions extends Omit<RuntimeOptions, "dbUrl"> {
  dbUrl: string;
}

export interface RuntimeBootstrapResult {
  agentStore: AgentStore;
  bashJobService: BashJobService;
  browserService: BrowserRunnerClient;
  credentialResolver: CredentialResolver;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
  watches: WatchStore;
  mainTools: readonly Tool[];
  pool: Pool;
  close(): Promise<void>;
}

function createCloseRuntime(options: {
  bashJobService: BashJobService | null;
  browserService: BrowserRunnerClient | null;
  postgresPool: Pool;
  readonlyPool: Pool | null;
  notificationClient: PoolClient | null;
  notificationChannel: string | null;
  notificationHandler: ((message: { channel: string; payload?: string }) => void) | null;
}): () => Promise<void> {
  return async () => {
    await options.browserService?.close().catch(() => undefined);
    await options.bashJobService?.close().catch(() => undefined);

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

export async function bootstrapRuntime(
  options: RuntimeBootstrapOptions,
): Promise<RuntimeBootstrapResult> {
  const readOnlyDbUrl =
    trimNonEmptyString(options.readOnlyDbUrl)
    ?? trimNonEmptyString(process.env.READONLY_DATABASE_URL);

  let readonlyPool: Pool | null = null;
  let notificationClient: PoolClient | null = null;
  let notificationHandler: ((message: { channel: string; payload?: string }) => void) | null = null;
  let notificationChannel: string | null = null;
  let browserService: BrowserRunnerClient | null = null;
  const maxSubagentDepth = options.maxSubagentDepth ?? 1;

  const postgresPool = createPostgresPool(options.dbUrl);

  try {
    const identityStore = new PostgresIdentityStore({
      pool: postgresPool,
    });
    const agentStore = new PostgresAgentStore({
      pool: postgresPool,
    });
    const sessionStore = new PostgresSessionStore({
      pool: postgresPool,
    });
    const store = new PostgresThreadRuntimeStore({
      pool: postgresPool,
    });
    await ensureSchemas([
      identityStore,
      agentStore,
      sessionStore,
      store,
    ]);
    await store.markRunningBashJobsLost();
    const bashJobService = new BashJobService({
      store,
    });
    browserService = new BrowserRunnerClient({
      env: process.env,
    });
    const resolvedBrowserService = browserService;

    const credentialStore = new PostgresCredentialStore({
      pool: postgresPool,
    });

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
    });

    const watches = new PostgresWatchStore({
      pool: postgresPool,
    });
    const watchMutations = new WatchMutationService({
      store: watches,
      evaluateWatch: createWatchEvaluator({
        credentialResolver,
      }),
    });
    await ensureSchemas([
      credentialStore,
      scheduledTasks,
      watches,
    ]);

    await ensureReadonlySessionQuerySchema({
      queryable: postgresPool,
      readonlyRole: readOnlyDbUrl ? readDatabaseUsername(readOnlyDbUrl) : null,
    });

    if (readOnlyDbUrl) {
      readonlyPool = createPostgresPool(readOnlyDbUrl);
    }

    const toolRegistry = createDefaultAgentToolRegistry({
      bash: {
        jobService: bashJobService,
        credentialResolver,
      },
      browser: {
        service: resolvedBrowserService,
      },
      postgresReadonly: {
        pool: readonlyPool ?? postgresPool,
      },
    });
    const subagentToolsets = buildDefaultAgentToolsetsFromRegistry(toolRegistry);

    let mainTools: readonly Tool[] = [];
    const subagentService = new DefaultAgentSubagentService({
      store,
      resolveDefinition: (thread) => options.resolveDefinition(thread, {
        agentStore,
        bashJobService,
        browserService: resolvedBrowserService,
        credentialResolver,
        identityStore,
        sessionStore,
        store,
        mainTools,
      }),
      toolsets: {
        workspace: subagentToolsets.workspace,
        memory: subagentToolsets.memory,
        browser: subagentToolsets.browser,
      },
      agentStore,
      maxSubagentDepth,
    });

    mainTools = buildDefaultAgentToolsetsFromRegistry(toolRegistry, [
      new ThinkingSetTool({
        persistence: {
          updateThreadThinking: async (threadId, thinking) => {
            const thread = await store.updateThread(threadId, {thinking});
            return {
              thinking: thread.thinking,
            };
          },
        },
      }),
      new SpawnSubagentTool({
        service: subagentService,
      }),
      new AgentDocumentTool({
        store: agentStore,
      }),
      new AgentSkillTool({
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
      new ScheduledTaskCreateTool({
        store: scheduledTasks,
      }),
      new ScheduledTaskUpdateTool({
        store: scheduledTasks,
      }),
      new ScheduledTaskCancelTool({
        store: scheduledTasks,
      }),
      new WatchCreateTool({
        mutations: watchMutations,
        store: watches,
      }),
      new WatchUpdateTool({
        mutations: watchMutations,
        store: watches,
      }),
      new WatchDisableTool({
        mutations: watchMutations,
        store: watches,
      }),
    ]).main;

    if (options.onStoreNotification) {
      notificationChannel = buildThreadRuntimeNotificationChannel();
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
      bashJobService,
      browserService: resolvedBrowserService,
      credentialResolver,
      identityStore,
      sessionStore,
      store,
      scheduledTasks,
      watches,
      mainTools,
      pool: postgresPool,
      close: createCloseRuntime({
        bashJobService,
        browserService: resolvedBrowserService,
        postgresPool,
        readonlyPool,
        notificationClient,
        notificationChannel,
        notificationHandler,
      }),
    };
  } catch (error) {
    await createCloseRuntime({
      bashJobService: null,
      browserService,
      postgresPool,
      readonlyPool,
      notificationClient,
      notificationChannel,
      notificationHandler,
    })().catch(() => undefined);
    throw error;
  }
}
