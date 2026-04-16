import {Pool} from "pg";

import {type AgentStore} from "../../domain/agents/index.js";
import type {SessionStore} from "../../domain/sessions/index.js";
import type {ScheduledTaskStore} from "../../domain/scheduling/tasks/index.js";
import type {WatchStore} from "../../domain/watches/index.js";
import {PostgresThreadLeaseManager, ThreadRuntimeCoordinator,} from "../../domain/threads/runtime/index.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {ResolvedThreadDefinition, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeEvent} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadRuntimeNotification} from "../../domain/threads/runtime/postgres.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import type {Tool} from "../../kernel/agent/tool.js";
import type {CredentialResolver} from "../../domain/credentials/index.js";
import type {BashJobService} from "../../integrations/shell/bash-job-service.js";
import type {BrowserRunnerClient} from "../../integrations/browser/client.js";
import {createPostgresPool, requireDatabaseUrl, resolveDatabaseUrl,} from "./database.js";
import {bootstrapRuntime,} from "./runtime-bootstrap.js";
import {buildBackgroundBashRuntimeMessage} from "./background-bash-runtime-note.js";
import {
    createThreadDefinition,
    type CreateThreadDefinitionOptions,
    DEFAULT_INFERENCE_PROJECTION,
    resolveStoredContext,
} from "./thread-definition.js";

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
  bashJobService: BashJobService;
  browserService: BrowserRunnerClient;
  credentialResolver: CredentialResolver;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  store: ThreadRuntimeStore;
  mainTools: readonly Tool[];
}

export interface RuntimeOptions {
  dbUrl?: string;
  readOnlyDbUrl?: string;
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
  bashJobService: BashJobService;
  browserService: BrowserRunnerClient;
  credentialResolver: CredentialResolver;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
  watches: WatchStore;
  coordinator: ThreadRuntimeCoordinator;
  mainTools: readonly Tool[];
  pool: Pool;
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
    bashJobService: runtime.bashJobService,
    browserService: runtime.browserService,
    credentialResolver: runtime.credentialResolver,
    identityStore: runtime.identityStore,
    sessionStore: runtime.sessionStore,
    store: runtime.store,
    mainTools: runtime.mainTools,
  };

  const coordinator = new ThreadRuntimeCoordinator({
    store: runtime.store,
    leaseManager: new PostgresThreadLeaseManager(runtime.pool),
    resolveDefinition: (thread) => options.resolveDefinition(thread, resolverContext),
    onEvent: options.onEvent,
  });
  runtime.bashJobService.setBackgroundCompletionHandler(async (record) => {
    await runtime.store.appendRuntimeMessage(record.threadId, buildBackgroundBashRuntimeMessage(record));
    await coordinator.wake(record.threadId);
  });

  return {
    agentStore: runtime.agentStore,
    bashJobService: runtime.bashJobService,
    browserService: runtime.browserService,
    credentialResolver: runtime.credentialResolver,
    identityStore: runtime.identityStore,
    sessionStore: runtime.sessionStore,
    store: runtime.store,
    scheduledTasks: runtime.scheduledTasks,
    watches: runtime.watches,
    coordinator,
    mainTools: runtime.mainTools,
    pool: runtime.pool,
    close: runtime.close,
  };
}
