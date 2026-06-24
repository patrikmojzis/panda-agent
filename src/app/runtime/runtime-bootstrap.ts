import {Pool} from "pg";

import {PostgresAgentStore} from "../../domain/agents/postgres.js";
import type {AgentStore} from "../../domain/agents/store.js";
import {CredentialResolver, CredentialService,} from "../../domain/credentials/resolver.js";
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
import type {ThreadShellStateStore} from "../../domain/threads/runtime/shell-state-store.js";
import type {Tool} from "../../kernel/agent/tool.js";
import {buildDefaultAgentToolsetsFromRegistry, createDefaultAgentToolRegistry,} from "../../panda/definition.js";
import {SessionPromptTool} from "../../panda/tools/session-prompt-tool.js";
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
import {ThinkingSetTool} from "../../panda/tools/thinking-set-tool.js";
import {TodoUpdateTool} from "../../panda/tools/todo-update-tool.js";
import {UpsertSubagentProfileTool} from "../../panda/tools/upsert-subagent-profile-tool.js";
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
import {RemoteExecutionEnvironmentSetupRunner} from "./execution-environment-setup-runner.js";
import {
    createExecutionEnvironmentManagerClientFromEnv
} from "../../integrations/shell/execution-environment-manager-client.js";
import {listenThreadRuntimeNotifications} from "./store-notifications.js";
import {A2ASessionBindingRepo} from "../../domain/a2a/repo.js";
import {PostgresControlAuthService} from "../../domain/control/auth.js";
import {ControlReadService} from "../../domain/control/read-service.js";
import {ControlHomeService} from "../../domain/control/home-service.js";
import {ControlOperatorService} from "../../domain/control/operator-service.js";
import {createTelegramBotIdentityClient} from "../../integrations/channels/telegram/account.js";
import {ControlBriefingService} from "../../domain/control/briefing-service.js";
import {ControlHeartbeatService} from "../../domain/control/heartbeat-service.js";
import {ControlScheduledTasksService} from "../../domain/control/scheduled-tasks-service.js";
import {ControlWatchesService} from "../../domain/control/watches-service.js";
import {ControlRuntimeActivityService} from "../../domain/control/runtime-activity-service.js";
import {ControlConnectorAccountsService} from "../../domain/control/connector-accounts-service.js";
import {ControlModelCallTraceService} from "../../domain/control/model-call-trace-service.js";
import {PostgresConnectorAccountStore} from "../../domain/connectors/postgres.js";
import {PostgresModelCallTraceStore, resolveModelCallTraceRetentionDays} from "../../domain/model-call-traces/postgres.js";
import {ConversationRepo} from "../../domain/sessions/conversations/repo.js";
import {PostgresGatewayStore} from "../../domain/gateway/postgres.js";

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
  controlAuth: PostgresControlAuthService;
  controlReads: ControlReadService;
  controlHome: ControlHomeService;
  controlOperator: ControlOperatorService;
  controlBriefings: ControlBriefingService;
  controlHeartbeats: ControlHeartbeatService;
  controlScheduledTasks: ControlScheduledTasksService;
  controlWatches: ControlWatchesService;
  controlRuntimeActivity: ControlRuntimeActivityService;
  controlConnectorAccounts: ControlConnectorAccountsService;
  controlModelCallTraces: ControlModelCallTraceService;
  modelCallTraces: PostgresModelCallTraceStore;
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
  shellStateStore: ThreadShellStateStore;
  scheduledTasks: ScheduledTaskStore;
  email: EmailStore;
  watches: WatchStore;
  wikiBindingService: WikiBindingService | null;
  a2aBindings: A2ASessionBindingRepo;
  postgresReadonly: PostgresReadonlyQueryToolOptions;
  mainTools: readonly Tool[];
  subagentTools: readonly Tool[];
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
    const a2aBindings = new A2ASessionBindingRepo({
      pool: postgresPool,
    });
    const conversationBindings = new ConversationRepo({
      pool: postgresPool,
    });
    const gatewayStore = new PostgresGatewayStore({
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
      a2aBindings,
      conversationBindings,
      gatewayStore,
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
    const connectorAccountStore = new PostgresConnectorAccountStore({
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
    const controlAuth = new PostgresControlAuthService({
      pool: postgresPool,
    });
    const controlReads = new ControlReadService({
      pool: postgresPool,
    });
    const controlHome = new ControlHomeService({
      pool: postgresPool,
      reads: controlReads,
    });
    const controlBriefings = new ControlBriefingService({
      pool: postgresPool,
      sessions: sessionStore,
    });
    const controlHeartbeats = new ControlHeartbeatService({
      pool: postgresPool,
      sessions: sessionStore,
    });
    const scheduledTasks = new PostgresScheduledTaskStore({
      pool: postgresPool,
    });
    const watches = new PostgresWatchStore({
      pool: postgresPool,
    });

    const controlScheduledTasks = new ControlScheduledTasksService({
      pool: postgresPool,
      store: scheduledTasks,
    });
    const controlWatches = new ControlWatchesService({
      pool: postgresPool,
      store: watches,
    });
    const controlRuntimeActivity = new ControlRuntimeActivityService({
      pool: postgresPool,
    });
    const controlConnectorAccounts = new ControlConnectorAccountsService({
      pool: postgresPool,
    });
    const modelCallTraces = new PostgresModelCallTraceStore({
      pool: postgresPool,
      retentionDays: resolveModelCallTraceRetentionDays(process.env),
    });
    const controlModelCallTraces = new ControlModelCallTraceService({
      pool: postgresPool,
    });

    const credentialCrypto = resolveCredentialCrypto();
    const credentialResolver = new CredentialResolver({
      store: credentialStore,
      crypto: credentialCrypto,
    });
    const executionEnvironmentManager = createExecutionEnvironmentManagerClientFromEnv(process.env);
    const executionEnvironmentSetupRunner = new RemoteExecutionEnvironmentSetupRunner({
      credentialResolver,
      env: process.env,
    });
    const executionEnvironmentService = new ExecutionEnvironmentLifecycleService({
      store: executionEnvironments,
      manager: executionEnvironmentManager,
      setupRunner: executionEnvironmentSetupRunner,
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
    const wikiBindingService = credentialCrypto
      ? new WikiBindingService({
        store: wikiBindingStore,
        crypto: credentialCrypto,
      })
      : null;
    const email = new PostgresEmailStore({
      pool: postgresPool,
    });
    const controlOperator = new ControlOperatorService({
      pool: postgresPool,
      reads: controlReads,
      a2aBindings,
      agents: agentStore,
      sessions: sessionStore,
      executionEnvironments,
      threads: store,
      identities: identityStore,
      credentials: credentialService,
      email,
      connectorAccounts: connectorAccountStore,
      connectorCrypto: credentialCrypto,
      conversations: conversationBindings,
      gateway: gatewayStore,
      subagents: subagentProfiles,
      wikiBindings: {
        store: wikiBindingStore,
        service: wikiBindingService,
      },
      telegramBotIdentityClient: createTelegramBotIdentityClient(),
    });

    const watchMutations = new WatchMutationService({
      store: watches,
      evaluateWatch: createWatchEvaluator({
        credentialResolver,
      }),
    });
    await ensureSchemas([
      credentialStore,
      connectorAccountStore,
      appAuth,
      email,
      scheduledTasks,
      watches,
      wikiBindingStore,
      controlAuth,
      modelCallTraces,
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
        shellStateStore: store,
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
      new SessionPromptTool({
        store: sessionStore,
      }),
      new UpsertSubagentProfileTool({
        store: subagentProfiles,
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
    const subagentTools = mergeToolsByName([
      mainTools,
      defaultToolsets.workspace,
      defaultToolsets.memory,
      defaultToolsets.browser,
      defaultToolsets.skill_maintainer,
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
      controlAuth,
      controlReads,
      controlHome,
      controlOperator,
      controlBriefings,
      controlHeartbeats,
      controlScheduledTasks,
      controlWatches,
      controlRuntimeActivity,
      controlConnectorAccounts,
      controlModelCallTraces,
      modelCallTraces,
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
      shellStateStore: store,
      scheduledTasks,
      email,
      watches,
      wikiBindingService,
      a2aBindings,
      postgresReadonly: postgresReadonlyToolOptions,
      mainTools,
      subagentTools,
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
