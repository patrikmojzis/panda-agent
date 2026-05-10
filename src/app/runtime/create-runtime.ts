import {Pool} from "pg";

import {type AgentStore} from "../../domain/agents/index.js";
import type {SessionStore} from "../../domain/sessions/index.js";
import type {ScheduledTaskStore} from "../../domain/scheduling/tasks/index.js";
import type {WatchStore} from "../../domain/watches/index.js";
import type {EmailStore} from "../../domain/email/index.js";
import {PostgresThreadLeaseManager, ThreadRuntimeCoordinator,} from "../../domain/threads/runtime/index.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {ResolvedThreadDefinition, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeEvent} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadRuntimeNotification} from "../../domain/threads/runtime/postgres.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import type {WikiBindingService} from "../../domain/wiki/index.js";
import type {Tool} from "../../kernel/agent/tool.js";
import type {CredentialResolver} from "../../domain/credentials/index.js";
import type {ExecutionEnvironmentStore,} from "../../domain/execution-environments/index.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import type {BrowserRunnerClient} from "../../integrations/browser/client.js";
import type {AgentAppService} from "../../integrations/apps/sqlite-service.js";
import type {AgentAppAuthService} from "../../domain/apps/auth.js";
import type {TelepathyHub} from "../../integrations/telepathy/hub.js";
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
import {WorkerSessionService} from "./worker-session-service.js";
import {EnvironmentCreateTool, EnvironmentStopTool, WorkerSpawnTool} from "../../panda/tools/worker-tools.js";

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
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
  email: EmailStore;
  telepathyService: TelepathyHub | null;
  wikiBindingService: WikiBindingService | null;
  mainTools: readonly Tool[];
}

export interface RuntimeOptions {
  dbUrl?: string;
  readOnlyDbUrl?: string;
  cwd?: string;
  maxSubagentDepth?: number;
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
  backgroundJobService: BackgroundToolJobService;
  browserService: BrowserRunnerClient;
  credentialResolver: CredentialResolver;
  executionEnvironments: ExecutionEnvironmentStore;
  executionEnvironmentResolver: ExecutionEnvironmentResolver;
  executionEnvironmentService: ExecutionEnvironmentLifecycleService;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
  email: EmailStore;
  telepathyService: TelepathyHub | null;
  watches: WatchStore;
  workerSessions: WorkerSessionService;
  coordinator: ThreadRuntimeCoordinator;
  mainTools: readonly Tool[];
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
    store: runtime.store,
    scheduledTasks: runtime.scheduledTasks,
    email: runtime.email,
    telepathyService: runtime.telepathyService,
    wikiBindingService: runtime.wikiBindingService,
    mainTools: runtime.mainTools,
  };

  const coordinator = new ThreadRuntimeCoordinator({
    store: runtime.store,
    leaseManager: new PostgresThreadLeaseManager(runtime.threadLeasePool),
    resolveDefinition: (thread) => options.resolveDefinition(thread, resolverContext),
    onEvent: options.onEvent,
  });
  const workerSessions = new WorkerSessionService({
    pool: runtime.pool,
    sessions: runtime.sessionStore,
    threads: runtime.store,
    coordinator,
    environments: runtime.executionEnvironmentService,
    fallbackContext: {
      cwd: options.cwd ?? process.cwd(),
    },
  });
  let mainTools: readonly Tool[] = [];
  const workerSpawnTool = new WorkerSpawnTool({
    workerSessions,
    availableToolNames: () => mainTools.map((tool) => tool.name),
  });
  mainTools = [
    ...runtime.mainTools,
    new EnvironmentCreateTool({
      lifecycle: runtime.executionEnvironmentService,
    }),
    new EnvironmentStopTool({
      environments: runtime.executionEnvironments,
      lifecycle: runtime.executionEnvironmentService,
    }),
    workerSpawnTool,
  ];
  resolverContext.mainTools = mainTools;

  runtime.backgroundJobService.setBackgroundCompletionHandler(async (record) => {
    await coordinator.submitInput(record.threadId, buildBackgroundToolThreadInput(record), "queue");
    await coordinator.wake(record.threadId);
  });

  return {
    agentStore: runtime.agentStore,
    apps: runtime.apps,
    appAuth: runtime.appAuth,
    backgroundJobService: runtime.backgroundJobService,
    browserService: runtime.browserService,
    credentialResolver: runtime.credentialResolver,
    executionEnvironments: runtime.executionEnvironments,
    executionEnvironmentResolver: runtime.executionEnvironmentResolver,
    executionEnvironmentService: runtime.executionEnvironmentService,
    identityStore: runtime.identityStore,
    sessionStore: runtime.sessionStore,
    store: runtime.store,
    scheduledTasks: runtime.scheduledTasks,
    email: runtime.email,
    telepathyService: runtime.telepathyService,
    watches: runtime.watches,
    workerSessions,
    coordinator,
    mainTools,
    pool: runtime.pool,
    notificationPool: runtime.notificationPool,
    close: runtime.close,
  };
}
