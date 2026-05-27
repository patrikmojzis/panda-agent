import {Pool} from "pg";

import {PostgresAgentStore} from "../../domain/agents/postgres.js";
import type {AgentStore} from "../../domain/agents/store.js";
import {
    CredentialResolver,
    CredentialService,
} from "../../domain/credentials/resolver.js";
import {PostgresCredentialStore} from "../../domain/credentials/postgres.js";
import {resolveCredentialCrypto} from "../../domain/credentials/crypto.js";
import {PostgresExecutionEnvironmentStore} from "../../domain/execution-environments/postgres.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import {PostgresIdentityStore} from "../../domain/identity/postgres.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import {PostgresScheduledTaskStore} from "../../domain/scheduling/tasks/postgres.js";
import type {ScheduledTaskStore} from "../../domain/scheduling/tasks/store.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {PostgresSubagentProfileStore} from "../../domain/subagents/postgres.js";
import type {SubagentProfileStore} from "../../domain/subagents/store.js";
import {PostgresEmailStore} from "../../domain/email/postgres.js";
import type {EmailStore} from "../../domain/email/types.js";
import {WatchMutationService} from "../../domain/watches/mutation-service.js";
import {PostgresWatchStore} from "../../domain/watches/postgres.js";
import type {WatchStore} from "../../domain/watches/store.js";
import {PostgresWikiBindingStore} from "../../domain/wiki/postgres.js";
import {WikiBindingService} from "../../domain/wiki/service.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import {type AgentAppAuthService, PostgresAgentAppAuthService} from "../../domain/apps/auth.js";
import {
    ensureReadonlySessionQuerySchema,
    readDatabaseUsername,
} from "../../domain/threads/runtime/postgres-readonly.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {Tool} from "../../kernel/agent/tool.js";
import {buildDefaultAgentToolsetsFromRegistry, createDefaultAgentToolRegistry,} from "../../panda/definition.js";
import {AgentPromptTool} from "../../panda/tools/agent-prompt-tool.js";
import {AgentSkillTool} from "../../panda/tools/agent-skill-tool.js";
import type {PostgresReadonlyQueryToolOptions} from "../../panda/tools/postgres-readonly-query-tool.js";
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
import {TodoUpdateTool} from "../../panda/tools/todo-update-tool.js";
import {DefaultAgentSubagentService} from "../../panda/subagents/service.js";
import {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
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
import {ExecutionEnvironmentResolver} from "./execution-environment-resolver.js";
import {ExecutionEnvironmentLifecycleService} from "./execution-environment-service.js";
import {createExecutionEnvironmentManagerClientFromEnv} from "../../integrations/shell/execution-environment-manager-client.js";
import {listenThreadRuntimeNotifications} from "./store-notifications.js";

const CORE_POSTGRES_APPLICATION_NAME = "panda/core";
const CORE_NOTIFICATION_POSTGRES_APPLICATION_NAME = "panda/core-notify";
const CORE_THREAD_LEASE_POSTGRES_APPLICATION_NAME = "panda/core-lease";
const CORE_READONLY_POSTGRES_APPLICATION_NAME = "panda/core-ro";
const CORE_POSTGRES_POOL_MAX_FALLBACK = 5;
const CORE_NOTIFICATION_POSTGRES_POOL_MAX_FALLBACK = 4;
const CORE_THREAD_LEASE_POSTGRES_POOL_MAX_FALLBACK = 4;
const CORE_READONLY_POSTGRES_POOL_MAX_FALLBACK = 2;

function logRuntimeEvent(event: string, payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    source: "runtime",
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  })}\n`);
}

function mergeToolsByName(toolGroups: readonly (readonly Tool[])[]): readonly Tool[] {
  const seen = new Set<string>();
  const merged: Tool[] = [];
  for (const tools of toolGroups) {
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        continue;
      }
      seen.add(tool.name);
      merged.push(tool);
    }
  }
  return merged;
}

interface RuntimeBootstrapOptions extends Omit<RuntimeOptions, "dbUrl"> {
  dbUrl: string;
}

interface RuntimeBootstrapResult {
  agentStore: AgentStore;
  apps: AgentAppService;
  appAuth: AgentAppAuthService;
  backgroundJobService: BackgroundToolJobService;
  browserService: BrowserRunnerClient;
  credentialResolver: CredentialResolver;
  executionEnvironments: ExecutionEnvironmentStore;
  executionEnvironmentResolver: ExecutionEnvironmentResolver;
  executionEnvironmentService: ExecutionEnvironmentLifecycleService;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  subagentProfiles: SubagentProfileStore;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
  email: EmailStore;
  watches: WatchStore;
  wikiBindingService: WikiBindingService | null;
  postgresReadonly: PostgresReadonlyQueryToolOptions;
  mainTools: readonly Tool[];
  workerTools: readonly Tool[];
  pool: Pool;
  notificationPool: Pool;
  threadLeasePool: Pool;
  close(): Promise<void>;
}

interface ObservedPoolState {
  pool: Pool | null;
  observer: PostgresPoolObserver | null;
  initializing: Promise<Pool> | null;
}

interface ObservedPoolHandle {
  pool: Pool;
  observer: PostgresPoolObserver;
}

function createObservedPoolHandle(input: {
  connectionString: string;
  applicationName: string;
  maxEnvKey: string;
  fallbackMax: number;
}): ObservedPoolHandle {
  const config = buildObservedPoolConfig(
    input.applicationName,
    input.maxEnvKey,
    input.fallbackMax,
  );
  const pool = createPostgresPool({
    connectionString: input.connectionString,
    applicationName: config.applicationName,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.acquireTimeoutMillis,
  });
  const observer = observePostgresPool({
    pool,
    applicationName: config.applicationName,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    waitingLogIntervalMs: config.waitingLogIntervalMs,
    log: logRuntimeEvent,
  });

  logRuntimeEvent("postgres_pool_ready", {
    applicationName: config.applicationName,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    acquireTimeoutMillis: config.acquireTimeoutMillis,
  });

  return {pool, observer};
}

function createCloseRuntime(options: {
  backgroundJobService: BackgroundToolJobService | null;
  browserService: BrowserRunnerClient | null;
  postgresPool: Pool;
  postgresPoolObserver: PostgresPoolObserver;
  notificationPool: Pool;
  notificationPoolObserver: PostgresPoolObserver;
  threadLeasePool: Pool;
  threadLeasePoolObserver: PostgresPoolObserver;
  readonlyPoolState: ObservedPoolState;
  notificationUnsubscribe: (() => Promise<void>) | null;
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
        label: "browser-service",
        run: async () => {
          await options.browserService?.close();
        },
      },
      {
        label: "background-job-service",
        run: async () => {
          await options.backgroundJobService?.close();
        },
      },
      {
        label: "runtime-listener",
        run: async () => {
          await options.notificationUnsubscribe?.();
        },
      },
      {
        label: "postgres-pool-observer",
        run: async () => {
          await resolveReadonlyPool();
          options.postgresPoolObserver.stop();
          options.notificationPoolObserver.stop();
          options.threadLeasePoolObserver.stop();
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
        label: "notification-postgres-pool",
        run: async () => {
          await options.notificationPool.end();
        },
      },
      {
        label: "thread-lease-postgres-pool",
        run: async () => {
          await options.threadLeasePool.end();
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
  let notificationUnsubscribe: (() => Promise<void>) | null = null;
  let browserService: BrowserRunnerClient | null = null;
  const maxSubagentDepth = options.maxSubagentDepth ?? 1;
  const postgresPoolHandle = createObservedPoolHandle({
    connectionString: options.dbUrl,
    applicationName: CORE_POSTGRES_APPLICATION_NAME,
    maxEnvKey: "PANDA_CORE_DB_POOL_MAX",
    fallbackMax: CORE_POSTGRES_POOL_MAX_FALLBACK,
  });
  const notificationPoolHandle = createObservedPoolHandle({
    connectionString: options.dbUrl,
    applicationName: CORE_NOTIFICATION_POSTGRES_APPLICATION_NAME,
    maxEnvKey: "PANDA_CORE_NOTIFICATION_DB_POOL_MAX",
    fallbackMax: CORE_NOTIFICATION_POSTGRES_POOL_MAX_FALLBACK,
  });
  const threadLeasePoolHandle = createObservedPoolHandle({
    connectionString: options.dbUrl,
    applicationName: CORE_THREAD_LEASE_POSTGRES_APPLICATION_NAME,
    maxEnvKey: "PANDA_CORE_THREAD_LEASE_DB_POOL_MAX",
    fallbackMax: CORE_THREAD_LEASE_POSTGRES_POOL_MAX_FALLBACK,
  });
  const postgresPool = postgresPoolHandle.pool;
  const postgresPoolObserver = postgresPoolHandle.observer;
  const notificationPool = notificationPoolHandle.pool;
  const notificationPoolObserver = notificationPoolHandle.observer;
  const threadLeasePool = threadLeasePoolHandle.pool;
  const threadLeasePoolObserver = threadLeasePoolHandle.observer;
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
          connectionTimeoutMillis: readonlyPoolConfig.acquireTimeoutMillis,
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
          acquireTimeoutMillis: readonlyPoolConfig.acquireTimeoutMillis,
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
    const subagentProfiles = new PostgresSubagentProfileStore({
      pool: postgresPool,
    });
    const executionEnvironments = new PostgresExecutionEnvironmentStore({
      pool: postgresPool,
    });
    const store = new PostgresThreadRuntimeStore({
      pool: postgresPool,
    });
    await ensureSchemas([
      identityStore,
      agentStore,
      subagentProfiles,
      sessionStore,
      executionEnvironments,
      store,
    ]);
    await subagentProfiles.seedBuiltinProfiles();
    await store.markRunningToolJobsLost();
    const backgroundJobService = new BackgroundToolJobService({
      store,
    });
    browserService = new BrowserRunnerClient({
      env: process.env,
    });
    const resolvedBrowserService = browserService;
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
    const executionEnvironmentManager = createExecutionEnvironmentManagerClientFromEnv(process.env);
    const executionEnvironmentService = new ExecutionEnvironmentLifecycleService({
      store: executionEnvironments,
      manager: executionEnvironmentManager,
    });
    const executionEnvironmentResolver = new ExecutionEnvironmentResolver({
      store: executionEnvironments,
      lifecycle: executionEnvironmentService,
      env: process.env,
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

    const email = new PostgresEmailStore({
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
      email,
      scheduledTasks,
      watches,
      wikiBindingStore,
    ]);

    await ensureReadonlySessionQuerySchema({
      queryable: postgresPool,
      readonlyRole: readOnlyDbUrl ? readDatabaseUsername(readOnlyDbUrl) : null,
    });

    const postgresReadonlyToolOptions: PostgresReadonlyQueryToolOptions = readOnlyDbUrl
      ? {
        getPool: getReadonlyPool,
        usesReadonlyRole: true,
      }
      : {
        pool: postgresPool,
        usesReadonlyRole: false,
      };
    const toolRegistry = createDefaultAgentToolRegistry({
      bash: {
        jobService: backgroundJobService,
        credentialResolver,
      },
      imageGenerate: {
        jobService: backgroundJobService,
      },
      browser: {
        service: resolvedBrowserService,
      },
      postgresReadonly: postgresReadonlyToolOptions,
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
    const defaultToolsets = buildDefaultAgentToolsetsFromRegistry(
      toolRegistry,
      [],
      wikiTool ? [wikiTool] : [],
      [agentSkillTool],
      [agentSkillTool],
    );

    let mainTools: readonly Tool[] = [];
    let workerTools: readonly Tool[] = defaultToolsets.worker;
    const subagentService = new DefaultAgentSubagentService({
      store,
      resolveDefinition: (thread) => options.resolveDefinition(thread, {
        agentStore,
        backgroundJobService,
        browserService: resolvedBrowserService,
        credentialResolver,
        executionEnvironments,
        executionEnvironmentResolver,
        executionEnvironmentService,
        identityStore,
        sessionStore,
        subagentProfiles,
        store,
        scheduledTasks,
        email,
        wikiBindingService,
        mainTools,
        workerTools,
      }),
      toolsets: {
        workspace: defaultToolsets.workspace,
        memory: defaultToolsets.memory,
        browser: defaultToolsets.browser,
        skill_maintainer: defaultToolsets.skill_maintainer,
      },
      agentStore,
      wikiBindings: wikiBindingService ?? undefined,
      maxSubagentDepth,
    });

    mainTools = buildDefaultAgentToolsetsFromRegistry(toolRegistry, [
      new ThinkingSetTool({
        persistence: {
          updateSessionThinkingForThread: async (threadId, thinking) => {
            const thread = await store.getThread(threadId);
            const runtimeConfig = await sessionStore.updateSessionRuntimeConfig({
              sessionId: thread.sessionId,
              thinking,
            });
            return {
              thinking: runtimeConfig.thinking,
            };
          },
        },
      }),
      new SpawnSubagentTool({
        service: subagentService,
        jobService: backgroundJobService,
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
      new TodoUpdateTool({
        store: sessionStore,
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
    workerTools = mergeToolsByName([
      defaultToolsets.worker,
      mainTools,
    ]);

    if (options.onStoreNotification) {
      notificationUnsubscribe = await listenThreadRuntimeNotifications({
        pool: notificationPool,
        listener: options.onStoreNotification,
      });
    }

    return {
      agentStore,
      apps,
      appAuth,
      backgroundJobService,
      browserService: resolvedBrowserService,
      credentialResolver,
      executionEnvironments,
      executionEnvironmentResolver,
      executionEnvironmentService,
      identityStore,
      sessionStore,
      subagentProfiles,
      store,
      scheduledTasks,
      email,
      watches,
      wikiBindingService,
      postgresReadonly: postgresReadonlyToolOptions,
      mainTools,
      workerTools,
      pool: postgresPool,
      notificationPool,
      threadLeasePool,
      close: createCloseRuntime({
        backgroundJobService,
        browserService: resolvedBrowserService,
        postgresPool,
        postgresPoolObserver,
        notificationPool,
        notificationPoolObserver,
        threadLeasePool,
        threadLeasePoolObserver,
        readonlyPoolState,
        notificationUnsubscribe,
      }),
    };
  } catch (error) {
    await createCloseRuntime({
      backgroundJobService: null,
      browserService,
      postgresPool,
      postgresPoolObserver,
      notificationPool,
      notificationPoolObserver,
      threadLeasePool,
      threadLeasePoolObserver,
      readonlyPoolState,
      notificationUnsubscribe,
    })().catch(() => undefined);
    throw error;
  }
}
