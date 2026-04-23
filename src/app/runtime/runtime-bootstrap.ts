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
import {PostgresTelepathyDeviceStore} from "../../domain/telepathy/index.js";
import {WatchMutationService} from "../../domain/watches/mutation-service.js";
import {PostgresWatchStore, type WatchStore,} from "../../domain/watches/index.js";
import {PostgresWikiBindingStore, WikiBindingService} from "../../domain/wiki/index.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/index.js";
import {PostgresAgentAppAuthService, type AgentAppAuthService} from "../../domain/apps/auth.js";
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
import {AgentPromptTool} from "../../panda/tools/agent-prompt-tool.js";
import {AgentSkillTool} from "../../panda/tools/agent-skill-tool.js";
import {BrowserRunnerClient} from "../../integrations/browser/client.js";
import {AgentAppService} from "../../integrations/apps/sqlite-service.js";
import {createWatchEvaluator} from "../../integrations/watches/evaluator.js";
import {ClearEnvValueTool, SetEnvValueTool} from "../../panda/tools/env-value-tools.js";
import {
  AppActionTool,
  AppCheckTool,
  AppCreateTool,
  AppLinkCreateTool,
  AppListTool,
  AppViewTool,
} from "../../panda/tools/app-tools.js";
import {WikiTool} from "../../panda/tools/wiki-tool.js";
import {
  resolveTelepathyEnabled,
  TelepathyHub,
} from "../../integrations/telepathy/hub.js";
import {
  ScheduledTaskCancelTool,
  ScheduledTaskCreateTool,
  ScheduledTaskUpdateTool,
} from "../../panda/tools/scheduled-task-tools.js";
import {
  WatchCreateTool,
  WatchDisableTool,
  WatchSchemaGetTool,
  WatchUpdateTool,
} from "../../panda/tools/watch-tools.js";
import {SpawnSubagentTool} from "../../panda/tools/spawn-subagent-tool.js";
import {ThinkingSetTool} from "../../panda/tools/thinking-set-tool.js";
import {DefaultAgentSubagentService} from "../../panda/subagents/service.js";
import {BashJobService} from "../../integrations/shell/bash-job-service.js";
import {
  buildObservedPoolConfig,
  createPostgresPool,
  observePostgresPool,
  type PostgresPoolObserver,
} from "./database.js";
import {runCleanupSteps} from "../../lib/cleanup.js";
import {trimToNull} from "../../lib/strings.js";
import {ensureSchemas} from "./postgres-bootstrap.js";
import type {RuntimeOptions} from "./create-runtime.js";

const CORE_POSTGRES_APPLICATION_NAME = "panda/core";
const CORE_READONLY_POSTGRES_APPLICATION_NAME = "panda/core-ro";
const CORE_POSTGRES_POOL_MAX_FALLBACK = 7;
const CORE_READONLY_POSTGRES_POOL_MAX_FALLBACK = 2;

function logRuntimeEvent(event: string, payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    source: "runtime",
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  })}\n`);
}

export interface RuntimeBootstrapOptions extends Omit<RuntimeOptions, "dbUrl"> {
  dbUrl: string;
}

export interface RuntimeBootstrapResult {
  agentStore: AgentStore;
  apps: AgentAppService;
  appAuth: AgentAppAuthService;
  bashJobService: BashJobService;
  browserService: BrowserRunnerClient;
  credentialResolver: CredentialResolver;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
  telepathyService: TelepathyHub | null;
  watches: WatchStore;
  wikiBindingService: WikiBindingService | null;
  mainTools: readonly Tool[];
  pool: Pool;
  close(): Promise<void>;
}

interface ObservedPoolState {
  pool: Pool | null;
  observer: PostgresPoolObserver | null;
  initializing: Promise<Pool> | null;
}

function createCloseRuntime(options: {
  bashJobService: BashJobService | null;
  browserService: BrowserRunnerClient | null;
  telepathyService: TelepathyHub | null;
  postgresPool: Pool;
  postgresPoolObserver: PostgresPoolObserver;
  readonlyPoolState: ObservedPoolState;
  notificationClient: PoolClient | null;
  notificationChannel: string | null;
  notificationHandler: ((message: { channel: string; payload?: string }) => void) | null;
}): () => Promise<void> {
  return async () => {
    let readonlyPool = options.readonlyPoolState.pool;
    let readonlyPoolObserver = options.readonlyPoolState.observer;
    const readonlyPoolInitializing = options.readonlyPoolState.initializing;
    const resolveReadonlyPool = async (): Promise<void> => {
      if (readonlyPool || !readonlyPoolInitializing) {
        return;
      }

      try {
        readonlyPool = await readonlyPoolInitializing;
        readonlyPoolObserver = options.readonlyPoolState.observer;
      } catch {
        // Ignore lazy readonly bootstrap failures during shutdown.
      }
    };

    await runCleanupSteps([
      {
        label: "telepathy-service",
        run: async () => {
          await options.telepathyService?.close();
        },
      },
      {
        label: "browser-service",
        run: async () => {
          await options.browserService?.close();
        },
      },
      {
        label: "bash-job-service",
        run: async () => {
          await options.bashJobService?.close();
        },
      },
      {
        label: "runtime-listener",
        run: async () => {
          if (!options.notificationClient || !options.notificationHandler || !options.notificationChannel) {
            return;
          }

          options.notificationClient.off("notification", options.notificationHandler);
          try {
            await options.notificationClient.query(`UNLISTEN ${options.notificationChannel}`);
          } catch (error) {
            logRuntimeEvent("runtime_cleanup_error", {
              step: "runtime-listener-unlisten",
              message: error instanceof Error ? error.message : String(error),
            });
          } finally {
            options.notificationClient.release();
          }
        },
      },
      {
        label: "postgres-pool-observer",
        run: async () => {
          await resolveReadonlyPool();
          options.postgresPoolObserver.stop();
          readonlyPoolObserver?.stop();
        },
      },
      {
        label: "readonly-postgres-pool",
        run: async () => {
          await resolveReadonlyPool();
          await readonlyPool?.end();
        },
      },
      {
        label: "postgres-pool",
        run: async () => {
          await options.postgresPool.end();
        },
      },
    ], (step, error) => {
      logRuntimeEvent("runtime_cleanup_error", {
        step: step.label,
        message: error instanceof Error ? error.message : String(error),
      });
    });

    options.readonlyPoolState.pool = null;
    options.readonlyPoolState.observer = null;
    options.readonlyPoolState.initializing = null;
  };
}

export async function bootstrapRuntime(
  options: RuntimeBootstrapOptions,
): Promise<RuntimeBootstrapResult> {
  const readOnlyDbUrl =
    trimToNull(options.readOnlyDbUrl)
    ?? trimToNull(process.env.READONLY_DATABASE_URL);

  const readonlyPoolState: ObservedPoolState = {
    pool: null,
    observer: null,
    initializing: null,
  };
  let notificationClient: PoolClient | null = null;
  let notificationHandler: ((message: { channel: string; payload?: string }) => void) | null = null;
  let notificationChannel: string | null = null;
  let browserService: BrowserRunnerClient | null = null;
  let telepathyService: TelepathyHub | null = null;
  const maxSubagentDepth = options.maxSubagentDepth ?? 1;
  const postgresPoolConfig = buildObservedPoolConfig(
    CORE_POSTGRES_APPLICATION_NAME,
    "PANDA_CORE_DB_POOL_MAX",
    CORE_POSTGRES_POOL_MAX_FALLBACK,
  );
  const postgresPool = createPostgresPool({
    connectionString: options.dbUrl,
    applicationName: postgresPoolConfig.applicationName,
    max: postgresPoolConfig.max,
    idleTimeoutMillis: postgresPoolConfig.idleTimeoutMillis,
  });
  const postgresPoolObserver = observePostgresPool({
    pool: postgresPool,
    applicationName: postgresPoolConfig.applicationName,
    max: postgresPoolConfig.max,
    idleTimeoutMillis: postgresPoolConfig.idleTimeoutMillis,
    waitingLogIntervalMs: postgresPoolConfig.waitingLogIntervalMs,
    log: logRuntimeEvent,
  });

  logRuntimeEvent("postgres_pool_ready", {
    applicationName: postgresPoolConfig.applicationName,
    max: postgresPoolConfig.max,
    idleTimeoutMillis: postgresPoolConfig.idleTimeoutMillis,
  });
  const readonlyPoolConfig = readOnlyDbUrl
    ? buildObservedPoolConfig(
      CORE_READONLY_POSTGRES_APPLICATION_NAME,
      "PANDA_CORE_READONLY_DB_POOL_MAX",
      CORE_READONLY_POSTGRES_POOL_MAX_FALLBACK,
    )
    : null;
  const getReadonlyPool = async (): Promise<Pool> => {
    const connectionString = readOnlyDbUrl;
    if (!readonlyPoolConfig || !connectionString) {
      return postgresPool;
    }

    if (readonlyPoolState.pool) {
      return readonlyPoolState.pool;
    }

    if (!readonlyPoolState.initializing) {
      readonlyPoolState.initializing = Promise.resolve().then(() => {
        const pool = createPostgresPool({
          connectionString,
          applicationName: readonlyPoolConfig.applicationName,
          max: readonlyPoolConfig.max,
          idleTimeoutMillis: readonlyPoolConfig.idleTimeoutMillis,
        });
        readonlyPoolState.pool = pool;
        readonlyPoolState.observer = observePostgresPool({
          pool,
          applicationName: readonlyPoolConfig.applicationName,
          max: readonlyPoolConfig.max,
          idleTimeoutMillis: readonlyPoolConfig.idleTimeoutMillis,
          waitingLogIntervalMs: readonlyPoolConfig.waitingLogIntervalMs,
          log: logRuntimeEvent,
        });
        logRuntimeEvent("postgres_pool_ready", {
          applicationName: readonlyPoolConfig.applicationName,
          max: readonlyPoolConfig.max,
          idleTimeoutMillis: readonlyPoolConfig.idleTimeoutMillis,
        });
        return pool;
      }).finally(() => {
        readonlyPoolState.initializing = null;
      });
    }

    return readonlyPoolState.initializing;
  };

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
    const telepathyDeviceStore = new PostgresTelepathyDeviceStore({
      pool: postgresPool,
    });
    const store = new PostgresThreadRuntimeStore({
      pool: postgresPool,
    });
    await ensureSchemas([
      identityStore,
      agentStore,
      sessionStore,
      telepathyDeviceStore,
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
    const telepathyEnabled = resolveTelepathyEnabled(process.env);
    telepathyService = telepathyEnabled
      ? new TelepathyHub({
        env: process.env,
        store: telepathyDeviceStore,
      })
      : null;
    await telepathyService?.start();

    const credentialStore = new PostgresCredentialStore({
      pool: postgresPool,
    });
    const apps = new AgentAppService({
      env: process.env,
    });
    const appAuth = new PostgresAgentAppAuthService({
      pool: postgresPool,
    });
    const wikiBindingStore = new PostgresWikiBindingStore({
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
      appAuth,
      scheduledTasks,
      watches,
      wikiBindingStore,
    ]);

    await ensureReadonlySessionQuerySchema({
      queryable: postgresPool,
      readonlyRole: readOnlyDbUrl ? readDatabaseUsername(readOnlyDbUrl) : null,
    });

    const toolRegistry = createDefaultAgentToolRegistry({
      bash: {
        jobService: bashJobService,
        credentialResolver,
      },
      browser: {
        service: resolvedBrowserService,
      },
      ...(telepathyService
        ? {
          telepathy: {
            service: telepathyService,
          },
        }
        : {}),
      postgresReadonly: readOnlyDbUrl
        ? {
          getPool: getReadonlyPool,
        }
        : {
          pool: postgresPool,
        },
    });
    const agentSkillTool = new AgentSkillTool({
      store: agentStore,
    });
    const appCreateTool = new AppCreateTool(apps);
    const appListTool = new AppListTool(apps);
    const appLinkCreateTool = new AppLinkCreateTool(apps, appAuth);
    const appCheckTool = new AppCheckTool(apps);
    const appViewTool = new AppViewTool(apps);
    const appActionTool = new AppActionTool(apps);
    const wikiEnabled = Boolean(
      trimToNull(process.env.WIKI_DB_URL)
      || trimToNull(process.env.WIKI_URL),
    );
    const wikiBindingService = credentialCrypto
      ? new WikiBindingService({
        store: wikiBindingStore,
        crypto: credentialCrypto,
      })
      : null;
    if (wikiEnabled && !wikiBindingService) {
      throw new Error("Wiki bindings require CREDENTIALS_MASTER_KEY when WIKI_URL or WIKI_DB_URL is set.");
    }
    const wikiTool = wikiEnabled && wikiBindingService
      ? new WikiTool({
        env: process.env,
        bindings: wikiBindingService,
      })
      : null;
    const subagentToolsets = buildDefaultAgentToolsetsFromRegistry(
      toolRegistry,
      [],
      wikiTool ? [wikiTool] : [],
      [agentSkillTool],
    );

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
        telepathyService,
        wikiBindingService,
        mainTools,
      }),
      toolsets: {
        workspace: subagentToolsets.workspace,
        memory: subagentToolsets.memory,
        browser: subagentToolsets.browser,
        skill_maintainer: subagentToolsets.skill_maintainer,
      },
      agentStore,
      wikiBindings: wikiBindingService ?? undefined,
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
      new AgentPromptTool({
        store: agentStore,
      }),
      appCreateTool,
      appListTool,
      appLinkCreateTool,
      appCheckTool,
      appViewTool,
      appActionTool,
      ...(wikiTool ? [wikiTool] : []),
      agentSkillTool,
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
      new WatchSchemaGetTool(),
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
      apps,
      appAuth,
      bashJobService,
      browserService: resolvedBrowserService,
      credentialResolver,
      identityStore,
      sessionStore,
      store,
      scheduledTasks,
      telepathyService,
      watches,
      wikiBindingService,
      mainTools,
      pool: postgresPool,
      close: createCloseRuntime({
        bashJobService,
        browserService: resolvedBrowserService,
        telepathyService,
        postgresPool,
        postgresPoolObserver,
        readonlyPoolState,
        notificationClient,
        notificationChannel,
        notificationHandler,
      }),
    };
  } catch (error) {
    await createCloseRuntime({
      bashJobService: null,
      browserService,
      telepathyService,
      postgresPool,
      postgresPoolObserver,
      readonlyPoolState,
      notificationClient,
      notificationChannel,
      notificationHandler,
    })().catch(() => undefined);
    throw error;
  }
}
