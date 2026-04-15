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
import type {BrowserSessionService} from "../../personas/panda/tools/browser-service.js";
import {createPandaPool, requirePandaDatabaseUrl, resolvePandaDatabaseUrl,} from "./database.js";
import {bootstrapPandaRuntime,} from "./runtime-bootstrap.js";
import {buildBackgroundBashRuntimeMessage} from "./background-bash-runtime-note.js";
import {
    createPandaThreadDefinition,
    type CreatePandaThreadDefinitionOptions,
    DEFAULT_PANDA_INFERENCE_PROJECTION,
    resolveStoredPandaContext,
} from "./thread-definition.js";

export {
  createPandaPool,
  createPandaThreadDefinition,
  DEFAULT_PANDA_INFERENCE_PROJECTION,
  requirePandaDatabaseUrl,
  resolvePandaDatabaseUrl,
  resolveStoredPandaContext,
};

export type {CreatePandaThreadDefinitionOptions};

export interface PandaDefinitionResolverContext {
  agentStore: AgentStore;
  bashJobService: BashJobService;
  browserService: BrowserSessionService;
  credentialResolver: CredentialResolver;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  store: ThreadRuntimeStore;
  extraTools: readonly Tool[];
}

export interface PandaRuntimeOptions {
  dbUrl?: string;
  readOnlyDbUrl?: string;
  maxSubagentDepth?: number;
  tablePrefix?: string;
  onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
  resolveDefinition: (
    thread: ThreadRecord,
    context: PandaDefinitionResolverContext,
  ) => Promise<ResolvedThreadDefinition> | ResolvedThreadDefinition;
}

export interface PandaRuntimeServices {
  agentStore: AgentStore;
  bashJobService: BashJobService;
  browserService: BrowserSessionService;
  credentialResolver: CredentialResolver;
  identityStore: IdentityStore;
  sessionStore: SessionStore;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
  watches: WatchStore;
  coordinator: ThreadRuntimeCoordinator;
  extraTools: readonly Tool[];
  pool: Pool;
  close(): Promise<void>;
}

export async function createPandaRuntime(options: PandaRuntimeOptions): Promise<PandaRuntimeServices> {
  const dbUrl = requirePandaDatabaseUrl(options.dbUrl);
  const runtime = await bootstrapPandaRuntime({
    ...options,
    dbUrl,
  });

  const resolverContext: PandaDefinitionResolverContext = {
    agentStore: runtime.agentStore,
    bashJobService: runtime.bashJobService,
    browserService: runtime.browserService,
    credentialResolver: runtime.credentialResolver,
    identityStore: runtime.identityStore,
    sessionStore: runtime.sessionStore,
    store: runtime.store,
    extraTools: runtime.extraTools,
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
    extraTools: runtime.extraTools,
    pool: runtime.pool,
    close: runtime.close,
  };
}
