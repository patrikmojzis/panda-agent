import {Pool} from "pg";

import {type AgentStore} from "../../domain/agents/index.js";
import type {ScheduledTaskStore} from "../../domain/scheduling/tasks/index.js";
import {PostgresThreadLeaseManager, ThreadRuntimeCoordinator,} from "../../domain/threads/runtime/index.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {ResolvedThreadDefinition, ThreadRecord,} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeEvent} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadRuntimeNotification} from "../../domain/threads/runtime/postgres.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import type {Tool} from "../../kernel/agent/tool.js";
import type {CredentialResolver} from "../../domain/credentials/index.js";
import {createPandaPool, requirePandaDatabaseUrl, resolvePandaDatabaseUrl,} from "./database.js";
import {bootstrapPandaRuntime,} from "./runtime-bootstrap.js";
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
  credentialResolver: CredentialResolver;
  identityStore: IdentityStore;
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
  identityStore: IdentityStore;
  store: ThreadRuntimeStore;
  scheduledTasks: ScheduledTaskStore;
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
    credentialResolver: runtime.credentialResolver,
    identityStore: runtime.identityStore,
    store: runtime.store,
    extraTools: runtime.extraTools,
  };

  const coordinator = new ThreadRuntimeCoordinator({
    store: runtime.store,
    leaseManager: new PostgresThreadLeaseManager(runtime.pool),
    resolveDefinition: (thread) => options.resolveDefinition(thread, resolverContext),
    onEvent: options.onEvent,
  });

  return {
    agentStore: runtime.agentStore,
    identityStore: runtime.identityStore,
    store: runtime.store,
    scheduledTasks: runtime.scheduledTasks,
    coordinator,
    extraTools: runtime.extraTools,
    pool: runtime.pool,
    close: runtime.close,
  };
}
