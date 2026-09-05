import {Pool} from "pg";

import type {AgentStore} from "../../domain/agents/store.js";
import type {A2ASessionBindingRepo} from "../../domain/a2a/repo.js";
import type {SessionLifecycle} from "../../domain/sessions/lifecycle.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {SubagentProfileStore} from "../../domain/subagents/store.js";
import type {ScheduledTaskStore} from "../../domain/scheduling/tasks/store.js";
import type {ScheduledCommandIntegrity} from "../../domain/scheduling/scheduled-commands/integrity.js";
import type {ScheduledCommandService} from "../../domain/scheduling/scheduled-commands/service.js";
import type {ScheduledCommandStore} from "../../domain/scheduling/scheduled-commands/store.js";
import type {WatchStore} from "../../domain/watches/store.js";
import type {RuntimeCommandLeaseService} from "./command-leases.js";
import type {RuntimeCommandDispatcher} from "./command-dispatcher.js";
import type {RuntimeCommandFileResolver} from "./command-files.js";
import type {EmailStore} from "../../domain/email/types.js";
import {ThreadRuntimeCoordinator, type ThreadRuntimeEvent} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {ThreadShellStateStore} from "../../domain/threads/runtime/shell-state-store.js";
import type {ResolvedThreadDefinition, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import type {WikiBindingService} from "../../domain/wiki/service.js";
import type {Tool} from "../../kernel/agent/tool.js";
import type {CredentialResolver} from "../../domain/credentials/resolver.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import type {BrowserRunnerClient} from "../../integrations/browser/client.js";
import type {AgentAppService} from "../../integrations/apps/sqlite-service.js";
import type {AgentAppAuthService} from "../../domain/apps/auth.js";
import type {PostgresControlAuthService} from "../../domain/control/auth.js";
import type {ControlReadService} from "../../domain/control/read-service.js";
import type {ControlHomeService} from "../../domain/control/home-service.js";
import type {ControlMcpService} from "../../domain/control/mcp-service.js";
import type {ControlOperatorService} from "../../domain/control/operator-service.js";
import type {ControlBriefingService} from "../../domain/control/briefing-service.js";
import type {ControlHeartbeatService} from "../../domain/control/heartbeat-service.js";
import type {ControlScheduledTasksService} from "../../domain/control/scheduled-tasks-service.js";
import type {ControlWatchesService} from "../../domain/control/watches-service.js";
import type {ControlRuntimeActivityService} from "../../domain/control/runtime-activity-service.js";
import type {ControlConnectorAccountsService} from "../../domain/control/connector-accounts-service.js";
import type {ControlModelCallTraceService} from "../../domain/control/model-call-trace-service.js";
import type {PostgresModelCallTraceStore} from "../../domain/model-call-traces/postgres.js";
import {
  createPostgresPool,
  readPositiveIntegerEnv,
  requireDatabaseUrl,
  resolveDatabaseUrl,
} from "../../lib/postgres-database.js";
import {bootstrapRuntime,} from "./runtime-bootstrap.js";
import {buildBackgroundToolThreadInput} from "./background-tool-thread-input.js";
import {
    createThreadDefinition,
    type CreateThreadDefinitionOptions,
    DEFAULT_INFERENCE_PROJECTION,
    resolveStoredContext,
} from "./thread-definition.js";
import type {ExecutionEnvironmentResolver} from "./execution-environment-resolver.js";
import type {ExecutionEnvironmentLifecycleService} from "./execution-environment-service.js";
import {SubagentSessionService} from "./subagent-session-service.js";
import type {CommandCatalog} from "../../domain/commands/modules.js";
import type {CommandCatalogModule} from "../../domain/commands/types.js";
import type {AgentCommandModuleDependencies} from "../../panda/commands/agent-command-modules.js";
import {SessionCompactionService} from "./session-compaction-service.js";
import {SessionArchiveService} from "./session-archive-service.js";
import {PostgresSessionArchive} from "../../domain/sessions/archive.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import {listenThreadRuntimeNotifications} from "./store-notifications.js";
import {runCleanupSteps} from "../../lib/cleanup.js";
import {
  PostgresPairedIdentityDirectory,
  type PairedIdentityDirectoryReader,
} from "../../domain/agents/paired-identity-directory.js";
import {closePiAiRuntimeResources} from "../../integrations/providers/shared/runtime.js";
import {resolveDefaultAgentModelSelector} from "../../panda/defaults.js";

const DEFAULT_THREAD_RUN_CONCURRENCY = 8;
const DEFAULT_THREAD_RUN_DRAIN_TIMEOUT_MS = 30_000;
const RUNTIME_CLOSE_STEP_TIMEOUT_MS = 5_000;

async function closeWithin(label: string, run: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not close within ${timeoutMs}ms.`)), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([run(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export {
  createPostgresPool,
  createThreadDefinition,
  DEFAULT_INFERENCE_PROJECTION,
  requireDatabaseUrl,
  resolveDatabaseUrl,
  resolveStoredContext,
};

export type {CreateThreadDefinitionOptions};

export interface DefinitionResolverContext {
  agentStore: AgentStore;
  backgroundJobService: BackgroundToolJobService;
  browserService: BrowserRunnerClient;
  credentialResolver: CredentialResolver;
  executionEnvironments: ExecutionEnvironmentStore;
  executionEnvironmentResolver: ExecutionEnvironmentResolver;
  executionEnvironmentService: ExecutionEnvironmentLifecycleService;
  pairedIdentities: PairedIdentityDirectoryReader;
  sessionStore: SessionStore;
  subagentProfiles: SubagentProfileStore;
  store: ThreadRuntimeStore;
  shellStateStore: ThreadShellStateStore;
  scheduledTasks: ScheduledTaskStore;
  email: EmailStore;
  wikiBindingService: WikiBindingService | null;
  commandCatalog: CommandCatalog<any, CommandCatalogModule<any>>;
  /** @deprecated Prefer commandCatalog.modules when raw module metadata is truly needed. */
  commandModules: readonly CommandCatalogModule<any>[];
  mainTools: readonly Tool[];
  subagentTools: readonly Tool[];
}

export interface RuntimeOptions {
  dbUrl?: string;
  readOnlyDbUrl?: string;
  cwd?: string;
  /** @deprecated Ignored. Durable subagents cannot spawn nested subagents. */
  maxSubagentDepth?: number;
  commandCatalog?: CommandCatalog<any, CommandCatalogModule<any>>;
  /** @deprecated Prefer commandCatalog. */
  commandModules?: readonly CommandCatalogModule<any>[];
  onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
  resolveDefinition: (
    thread: ThreadRecord,
    context: DefinitionResolverContext,
  ) => Promise<ResolvedThreadDefinition> | ResolvedThreadDefinition;
}

export interface RuntimeServices {
  sessionLifecycle: SessionLifecycle;
  agentStore: AgentStore;
  apps: AgentAppService;
  appAuth: AgentAppAuthService;
  controlAuth: PostgresControlAuthService;
  controlReads: ControlReadService;
  controlHome: ControlHomeService;
  controlOperator: ControlOperatorService;
  controlMcp: ControlMcpService;
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
  scheduledCommands: ScheduledCommandStore;
  scheduledCommandIntegrity: ScheduledCommandIntegrity | null;
  scheduledCommandService: ScheduledCommandService | null;
  email: EmailStore;
  watches: WatchStore;
  commandExecutor: RuntimeCommandDispatcher;
  commandLeases: RuntimeCommandLeaseService;
  commandFileResolver: RuntimeCommandFileResolver;
  commandCatalog: CommandCatalog<any, CommandCatalogModule<any>>;
  /** @deprecated Prefer commandCatalog.modules when raw module metadata is truly needed. */
  commandModules: readonly CommandCatalogModule<any>[];
  subagentSessions: SubagentSessionService;
  sessionCompaction: SessionCompactionService;
  sessionArchive: SessionArchiveService;
  a2aBindings: A2ASessionBindingRepo;
  coordinator: ThreadRuntimeCoordinator;
  mainTools: readonly Tool[];
  subagentTools: readonly Tool[];
  pool: Pool;
  notificationPool: Pool;
  close(): Promise<void>;
}

export async function createRuntime(options: RuntimeOptions): Promise<RuntimeServices> {
  const dbUrl = requireDatabaseUrl(options.dbUrl);
  const runtime = await bootstrapRuntime({
    ...options,
    dbUrl,
  });

  let coordinatorForCleanup: ThreadRuntimeCoordinator | null = null;
  let notificationUnsubscribe: (() => Promise<void>) | null = null;
  try {
    const resolverContext: DefinitionResolverContext = {
      agentStore: runtime.agentStore,
      backgroundJobService: runtime.backgroundJobService,
      browserService: runtime.browserService,
      credentialResolver: runtime.credentialResolver,
      executionEnvironments: runtime.executionEnvironments,
      executionEnvironmentResolver: runtime.executionEnvironmentResolver,
      executionEnvironmentService: runtime.executionEnvironmentService,
      pairedIdentities: new PostgresPairedIdentityDirectory({pool: runtime.pool}),
      sessionStore: runtime.sessionStore,
      subagentProfiles: runtime.subagentProfiles,
      store: runtime.store,
      shellStateStore: runtime.shellStateStore,
      scheduledTasks: runtime.scheduledTasks,
      email: runtime.email,
      wikiBindingService: runtime.wikiBindingService,
      commandCatalog: runtime.commandCatalog,
      commandModules: runtime.commandModules,
      mainTools: runtime.mainTools,
      subagentTools: runtime.subagentTools,
    };

    const coordinatorDrainTimeoutMs = readPositiveIntegerEnv(
      "PANDA_CORE_THREAD_RUN_DRAIN_TIMEOUT_MS",
      DEFAULT_THREAD_RUN_DRAIN_TIMEOUT_MS,
    );
    const coordinator = new ThreadRuntimeCoordinator({
      store: runtime.store,
      sessionCompactionRequests: runtime.sessionCompactionRequests,
      maxConcurrentRuns: readPositiveIntegerEnv(
        "PANDA_CORE_THREAD_RUN_CONCURRENCY",
        DEFAULT_THREAD_RUN_CONCURRENCY,
      ),
      shutdownDrainTimeoutMs: coordinatorDrainTimeoutMs,
      modelCallObserver: runtime.modelCallRecorder,
      resolveDefinition: async (thread) => {
        const definition = await options.resolveDefinition(thread, resolverContext);
        return {...definition, model: definition.model ?? resolveDefaultAgentModelSelector()};
      },
      onEvent: options.onEvent,
    });
    coordinatorForCleanup = coordinator;
    const subagentSessions = new SubagentSessionService({
      sessionLifecycle: runtime.sessionLifecycle,
      sessions: runtime.sessionStore,
      threads: runtime.store,
      profiles: runtime.subagentProfiles,
      environments: runtime.executionEnvironmentService,
      a2aBindings: runtime.a2aBindings,
      commandCatalog: runtime.commandCatalog,
      coordinator,
    });
    const sessionCompaction = new SessionCompactionService({
      sessions: runtime.sessionStore,
      threads: runtime.store,
      coordinator,
    });
    const archiveSessions = new PostgresSessionStore({pool: runtime.pool});
    const sessionArchive = new SessionArchiveService({
      sessions: archiveSessions,
      archiveStore: new PostgresSessionArchive({
        pool: runtime.pool,
        sessions: archiveSessions,
        threads: new PostgresThreadRuntimeStore({pool: runtime.pool}),
      }),
      coordinator,
      backgroundJobs: runtime.backgroundJobService,
    });
    runtime.commandExecutor.registerCommands(runtime.commandCatalog.createCommands(
      {subagentSessions} satisfies Required<Pick<AgentCommandModuleDependencies, "subagentSessions">>,
      {registrationPhase: "runtime.subagent", requireAll: true},
    ));

    runtime.backgroundJobService.setBackgroundCompletionHandler(async (record) => {
      await coordinator.submitInput(record.threadId, buildBackgroundToolThreadInput(record), "wake");
    });

    notificationUnsubscribe = await listenThreadRuntimeNotifications({
      pool: runtime.notificationPool,
      listener: (notification) => coordinator.handleStoreNotification(notification),
      onStateChange: (snapshot) => coordinator.handleStoreNotificationStatus(snapshot.status),
      onError: (error) => {
        console.error("Thread runtime notification listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    let closePromise: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (closePromise) {
        return closePromise;
      }

      const unsubscribe = notificationUnsubscribe;
      notificationUnsubscribe = null;
      closePromise = runCleanupSteps([
        {
          label: "thread-runtime-listener",
          run: () => closeWithin("thread runtime listener", async () => unsubscribe?.(), RUNTIME_CLOSE_STEP_TIMEOUT_MS),
        },
        {
          label: "thread-runtime-coordinator",
          run: () => closeWithin(
            "thread runtime coordinator",
            () => coordinator.stop(),
            coordinatorDrainTimeoutMs + RUNTIME_CLOSE_STEP_TIMEOUT_MS,
          ),
        },
        // Pi-AI caches provider transports by prompt-cache session. The daemon
        // owns one runtime, so process teardown must close that global cache
        // after model work settles or WebSockets keep the process alive.
        {label: "provider-runtime-resources", run: async () => closePiAiRuntimeResources()},
        {
          label: "runtime",
          run: () => closeWithin("runtime resources", () => runtime.close(), RUNTIME_CLOSE_STEP_TIMEOUT_MS),
        },
      ], undefined, {rethrow: true});
      return closePromise;
    };

    return {
      agentStore: runtime.agentStore,
      apps: runtime.apps,
      appAuth: runtime.appAuth,
      controlAuth: runtime.controlAuth,
      controlReads: runtime.controlReads,
      controlHome: runtime.controlHome,
      controlOperator: runtime.controlOperator,
      controlMcp: runtime.controlMcp,
      controlBriefings: runtime.controlBriefings,
      controlHeartbeats: runtime.controlHeartbeats,
      controlScheduledTasks: runtime.controlScheduledTasks,
      controlWatches: runtime.controlWatches,
      controlRuntimeActivity: runtime.controlRuntimeActivity,
      controlConnectorAccounts: runtime.controlConnectorAccounts,
      controlModelCallTraces: runtime.controlModelCallTraces,
      modelCallTraces: runtime.modelCallTraces,
      backgroundJobService: runtime.backgroundJobService,
      browserService: runtime.browserService,
      credentialResolver: runtime.credentialResolver,
      executionEnvironments: runtime.executionEnvironments,
      executionEnvironmentResolver: runtime.executionEnvironmentResolver,
      executionEnvironmentService: runtime.executionEnvironmentService,
      identityStore: runtime.identityStore,
      sessionStore: runtime.sessionStore,
      subagentProfiles: runtime.subagentProfiles,
      store: runtime.store,
      shellStateStore: runtime.shellStateStore,
      scheduledTasks: runtime.scheduledTasks,
      scheduledCommands: runtime.scheduledCommands,
      scheduledCommandIntegrity: runtime.scheduledCommandIntegrity,
      scheduledCommandService: runtime.scheduledCommandService,
      email: runtime.email,
      watches: runtime.watches,
      commandExecutor: runtime.commandExecutor,
      commandLeases: runtime.commandLeases,
      commandFileResolver: runtime.commandFileResolver,
      commandCatalog: runtime.commandCatalog,
      commandModules: runtime.commandModules,
      subagentSessions,
      sessionLifecycle: runtime.sessionLifecycle,
      sessionCompaction,
      sessionArchive,
      a2aBindings: runtime.a2aBindings,
      coordinator,
      mainTools: runtime.mainTools,
      subagentTools: runtime.subagentTools,
      pool: runtime.pool,
      notificationPool: runtime.notificationPool,
      close,
    };
  } catch (error) {
    await runCleanupSteps([
      {label: "thread-runtime-listener", run: () => notificationUnsubscribe?.()},
      {label: "thread-runtime-coordinator", run: () => coordinatorForCleanup?.stop()},
      {label: "runtime", run: () => runtime.close()},
    ]).catch(() => undefined);
    throw error;
  }
}
