import {Pool} from "pg";

import {type AgentStore} from "../../domain/agents/index.js";
import type {PostgresSidecarRepo} from "../../domain/sidecars/index.js";
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
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import type {BrowserRunnerClient} from "../../integrations/browser/client.js";
import type {AgentAppService} from "../../integrations/apps/sqlite-service.js";
import type {AgentAppAuthService} from "../../domain/apps/auth.js";
import type {TelepathyHub} from "../../integrations/telepathy/hub.js";
import type {AgentCalendarService} from "../../integrations/calendar/types.js";
import {createPostgresPool, requireDatabaseUrl, resolveDatabaseUrl,} from "./database.js";
import {bootstrapRuntime,} from "./runtime-bootstrap.js";
import {buildBackgroundToolThreadInput} from "./background-tool-thread-input.js";
import {
    createThreadDefinition,
    type CreateThreadDefinitionOptions,
    DEFAULT_INFERENCE_PROJECTION,
    resolveStoredContext,
} from "./thread-definition.js";
import {SidecarService} from "./sidecars.js";

export {
  createPostgresPool,
  createThreadDefinition,
  DEFAULT_INFERENCE_PROJECTION,
  requireDatabaseUrl,
  resolveDatabaseUrl,
  resolveStoredContext,
};

export type {CreateThreadDefinitionOptions};

function scheduleSidecarHook(work: Promise<void> | void): void {
  void Promise.resolve(work).catch(() => {
    // Sidecars are opportunistic. They must never slow down or fail the main run.
  });
}

export interface DefinitionResolverContext {
  agentStore: AgentStore;
  backgroundJobService: BackgroundToolJobService;
  browserService: BrowserRunnerClient;
  credentialResolver: CredentialResolver;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  sidecarRepo: PostgresSidecarRepo;
  store: ThreadRuntimeStore;
  email: EmailStore;
  telepathyService: TelepathyHub | null;
  wikiBindingService: WikiBindingService | null;
  calendarService: AgentCalendarService | null;
  mainTools: readonly Tool[];
}

export interface RuntimeOptions {
  dbUrl?: string;
  readOnlyDbUrl?: string;
  maxSubagentDepth?: number;
  sidecars?: boolean;
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
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  sidecarRepo: PostgresSidecarRepo;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
  email: EmailStore;
  telepathyService: TelepathyHub | null;
  watches: WatchStore;
  calendarService: AgentCalendarService | null;
  coordinator: ThreadRuntimeCoordinator;
  sidecars: SidecarService | null;
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
    identityStore: runtime.identityStore,
    sessionStore: runtime.sessionStore,
    sidecarRepo: runtime.sidecarRepo,
    store: runtime.store,
    email: runtime.email,
    telepathyService: runtime.telepathyService,
    wikiBindingService: runtime.wikiBindingService,
    calendarService: runtime.calendarService,
    mainTools: runtime.mainTools,
  };

  let coordinator!: ThreadRuntimeCoordinator;
  const sidecars = options.sidecars === false
    ? null
    : new SidecarService({
      sessionStore: runtime.sessionStore,
      threadStore: runtime.store,
      sidecarRepo: runtime.sidecarRepo,
      runtime: {
        submitInput: (threadId, payload, mode) => coordinator.submitInput(threadId, payload, mode),
      },
      pool: runtime.pool,
      postgresReadonly: runtime.postgresReadonly,
      agentStore: runtime.agentStore,
      wikiBindings: runtime.wikiBindingService ?? undefined,
      env: process.env,
    });

  coordinator = new ThreadRuntimeCoordinator({
    store: runtime.store,
    leaseManager: new PostgresThreadLeaseManager(runtime.threadLeasePool),
    resolveDefinition: async (thread) => {
      const session = await runtime.sessionStore.getSession(thread.sessionId);
      if (session.kind === "sidecar" && sidecars?.isSidecarThread(thread)) {
        return sidecars.resolveDefinition(thread, session);
      }

      return options.resolveDefinition(thread, resolverContext);
    },
    beforeRunStep: (input) => scheduleSidecarHook(sidecars?.beforeRunStep(input)),
    afterCheckpoint: (input) => scheduleSidecarHook(sidecars?.afterCheckpoint(input)),
    afterRunFinish: (input) => scheduleSidecarHook(sidecars?.afterRunFinish(input)),
    onEvent: options.onEvent,
  });
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
    identityStore: runtime.identityStore,
    sessionStore: runtime.sessionStore,
    sidecarRepo: runtime.sidecarRepo,
    store: runtime.store,
    scheduledTasks: runtime.scheduledTasks,
    email: runtime.email,
    telepathyService: runtime.telepathyService,
    watches: runtime.watches,
    calendarService: runtime.calendarService,
    coordinator,
    sidecars,
    mainTools: runtime.mainTools,
    pool: runtime.pool,
    notificationPool: runtime.notificationPool,
    close: runtime.close,
  };
}
