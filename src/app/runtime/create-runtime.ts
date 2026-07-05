import {Pool} from "pg";

import type {AgentStore} from "../../domain/agents/store.js";
import type {A2ASessionBindingRepo} from "../../domain/a2a/repo.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {SubagentProfileStore} from "../../domain/subagents/store.js";
import type {ScheduledTaskStore} from "../../domain/scheduling/tasks/store.js";
import type {WatchStore} from "../../domain/watches/store.js";
import type {RuntimeCommandLeaseService} from "./command-leases.js";
import type {RuntimeCommandDispatcher} from "./command-dispatcher.js";
import type {RuntimeCommandFileResolver} from "./command-files.js";
import type {EmailStore} from "../../domain/email/types.js";
import {ThreadRuntimeCoordinator, type ThreadRuntimeEvent} from "../../domain/threads/runtime/coordinator.js";
import {PostgresThreadLeaseManager} from "../../domain/threads/runtime/postgres-lease.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {ThreadShellStateStore} from "../../domain/threads/runtime/shell-state-store.js";
import type {ResolvedThreadDefinition, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeNotification} from "../../domain/threads/runtime/postgres-notifications.js";
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
import type {ControlOperatorService} from "../../domain/control/operator-service.js";
import type {ControlBriefingService} from "../../domain/control/briefing-service.js";
import type {ControlHeartbeatService} from "../../domain/control/heartbeat-service.js";
import type {ControlScheduledTasksService} from "../../domain/control/scheduled-tasks-service.js";
import type {ControlWatchesService} from "../../domain/control/watches-service.js";
import type {ControlRuntimeActivityService} from "../../domain/control/runtime-activity-service.js";
import type {ControlConnectorAccountsService} from "../../domain/control/connector-accounts-service.js";
import type {ControlModelCallTraceService} from "../../domain/control/model-call-trace-service.js";
import type {PostgresModelCallTraceStore} from "../../domain/model-call-traces/postgres.js";
import {createPostgresPool, requireDatabaseUrl, resolveDatabaseUrl,} from "./database.js";
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
import {buildSubagentCommandDependencies} from "./command-dependencies.js";

export {
  createPostgresPool,
  createThreadDefinition,
  DEFAULT_INFERENCE_PROJECTION,
  requireDatabaseUrl,
  resolveDatabaseUrl,
  resolveStoredContext,
};

export type {CreateThreadDefinitionOptions};

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

export interface DefinitionResolverContext {
  agentStore: AgentStore;
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
  maxSubagentDepth?: number;
  commandCatalog?: CommandCatalog<any, CommandCatalogModule<any>>;
  /** @deprecated Prefer commandCatalog. */
  commandModules?: readonly CommandCatalogModule<any>[];
  onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
  resolveDefinition: (
    thread: ThreadRecord,
    context: DefinitionResolverContext,
  ) => Promise<ResolvedThreadDefinition> | ResolvedThreadDefinition;
}

export interface RuntimeServices {
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
  commandExecutor: RuntimeCommandDispatcher;
  commandLeases: RuntimeCommandLeaseService;
  commandFileResolver: RuntimeCommandFileResolver;
  commandCatalog: CommandCatalog<any, CommandCatalogModule<any>>;
  /** @deprecated Prefer commandCatalog.modules when raw module metadata is truly needed. */
  commandModules: readonly CommandCatalogModule<any>[];
  subagentSessions: SubagentSessionService;
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

  const resolverContext: DefinitionResolverContext = {
    agentStore: runtime.agentStore,
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
    email: runtime.email,
    wikiBindingService: runtime.wikiBindingService,
    commandCatalog: runtime.commandCatalog,
    commandModules: runtime.commandModules,
    mainTools: runtime.mainTools,
    subagentTools: runtime.subagentTools,
  };

  const coordinator = new ThreadRuntimeCoordinator({
    store: runtime.store,
    leaseManager: new PostgresThreadLeaseManager(runtime.threadLeasePool),
    modelCallTracer: runtime.modelCallTraces,
    resolveDefinition: (thread) => options.resolveDefinition(thread, resolverContext),
    onEvent: options.onEvent,
  });
  const subagentSessions = new SubagentSessionService({
    pool: runtime.pool,
    sessions: runtime.sessionStore,
    threads: runtime.store,
    profiles: runtime.subagentProfiles,
    environments: runtime.executionEnvironmentService,
    a2aBindings: runtime.a2aBindings,
    commandCatalog: runtime.commandCatalog,
    coordinator,
  });
  runtime.commandExecutor.registerCommands([
    ...runtime.commandCatalog.createCommands(
      buildSubagentCommandDependencies(subagentSessions),
      {registrationPhase: "runtime.subagent", requireAll: true},
    ),
  ]);
  const mainTools: readonly Tool[] = runtime.mainTools;
  const subagentTools: readonly Tool[] = mergeToolsByName([
    mainTools,
    runtime.subagentTools,
  ]);
  resolverContext.mainTools = mainTools;
  resolverContext.subagentTools = subagentTools;

  runtime.backgroundJobService.setBackgroundCompletionHandler(async (record) => {
    await coordinator.submitInput(record.threadId, buildBackgroundToolThreadInput(record), "wake");
  });

  return {
    agentStore: runtime.agentStore,
    apps: runtime.apps,
    appAuth: runtime.appAuth,
    controlAuth: runtime.controlAuth,
    controlReads: runtime.controlReads,
    controlHome: runtime.controlHome,
    controlOperator: runtime.controlOperator,
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
    email: runtime.email,
    watches: runtime.watches,
    commandExecutor: runtime.commandExecutor,
    commandLeases: runtime.commandLeases,
    commandFileResolver: runtime.commandFileResolver,
    commandCatalog: runtime.commandCatalog,
    commandModules: runtime.commandModules,
    subagentSessions,
    a2aBindings: runtime.a2aBindings,
    coordinator,
    mainTools,
    subagentTools,
    pool: runtime.pool,
    notificationPool: runtime.notificationPool,
    close: runtime.close,
  };
}
