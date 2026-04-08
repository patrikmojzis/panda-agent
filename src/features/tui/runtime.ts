import { randomUUID } from "node:crypto";

import type { ThinkingLevel } from "@mariozechner/pi-ai";

import { Agent } from "../agent-core/agent.js";
import type { Tool } from "../agent-core/tool.js";
import type { ProviderName } from "../agent-core/types.js";
import { buildPandaTools } from "../panda/agent.js";
import { DateTimeContext, EnvironmentContext } from "../panda/contexts/index.js";
import { buildPandaPrompt } from "../panda/prompts.js";
import type { PandaSessionContext } from "../panda/types.js";
import {
  createPandaRuntime,
  resolveStoredPandaContext,
  type StorageMode,
} from "../panda/runtime.js";
import {
  createDefaultIdentityInput,
  DEFAULT_IDENTITY_HANDLE,
  type IdentityRecord,
} from "../identity/index.js";
import type { IdentityStore } from "../identity/store.js";
import {
  type ThreadRuntimeCoordinator,
  type ThreadRuntimeEvent,
  type ThreadRunRecord,
  type ThreadRecord,
  type ThreadSummaryRecord,
} from "../thread-runtime/index.js";
import type { ThreadRuntimeNotification } from "../thread-runtime/postgres.js";
import type { ThreadRuntimeStore } from "../thread-runtime/store.js";

export interface ChatRuntimeOptions {
  cwd: string;
  locale: string;
  timezone: string;
  instructions?: string;
  provider?: ProviderName;
  model?: string;
  identity?: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
  tablePrefix?: string;
  onEvent?: (event: ThreadRuntimeEvent) => Promise<void> | void;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}

export interface CreateChatThreadOptions {
  id?: string;
  agentKey?: string;
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface ChatRuntimeServices {
  mode: StorageMode;
  identity: IdentityRecord;
  identityStore: IdentityStore;
  store: ThreadRuntimeStore;
  coordinator: ThreadRuntimeCoordinator;
  extraTools: readonly Tool[];
  createThread(options?: CreateChatThreadOptions): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  listThreadSummaries(limit?: number): Promise<readonly ThreadSummaryRecord[]>;
  recoverOrphanedRuns(reason?: string): Promise<readonly ThreadRunRecord[]>;
  close(): Promise<void>;
}

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}
function assertIdentityThreadAccess(thread: ThreadRecord, identity: IdentityRecord): ThreadRecord {
  if (thread.identityId !== identity.id) {
    throw new Error(`Thread ${thread.id} does not belong to identity ${identity.handle}.`);
  }

  return thread;
}

export async function createChatRuntime(options: ChatRuntimeOptions): Promise<ChatRuntimeServices> {
  const fallbackContext = {
    cwd: options.cwd,
    locale: options.locale,
    timezone: options.timezone,
  } as const;
  const requestedIdentityHandle = trimNonEmptyString(options.identity) ?? DEFAULT_IDENTITY_HANDLE;
  let identity: IdentityRecord | null = null;
  const runtime = await createPandaRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    tablePrefix: options.tablePrefix,
    onEvent: options.onEvent,
    onStoreNotification: options.onStoreNotification,
    resolveDefinition: (thread, { extraTools }) => {
      if (!identity) {
        throw new Error("Chat runtime identity has not been initialized yet.");
      }

      const context: PandaSessionContext = {
        ...resolveStoredPandaContext(thread.context, {
          ...fallbackContext,
          identityId: identity.id,
          identityHandle: identity.handle,
        }),
        threadId: thread.id,
        agentKey: thread.agentKey,
        identityId: identity.id,
        identityHandle: identity.handle,
      };
      return {
        agent: new Agent({
          name: thread.agentKey,
          instructions: buildPandaPrompt(options.instructions),
          tools: buildPandaTools(extraTools),
        }),
        context,
        llmContexts: [
          new DateTimeContext({
            locale: context.locale ?? options.locale,
            timeZone: context.timezone ?? options.timezone,
          }),
          new EnvironmentContext({
            cwd: context.cwd ?? options.cwd,
          }),
        ],
      };
    },
  });

  try {
    identity = requestedIdentityHandle === DEFAULT_IDENTITY_HANDLE
      ? await runtime.identityStore.ensureIdentity(createDefaultIdentityInput())
      : await runtime.identityStore.getIdentityByHandle(requestedIdentityHandle);
  } catch (error) {
    await runtime.close();
    throw error;
  }

  const createThread = async (createOptions: CreateChatThreadOptions = {}): Promise<ThreadRecord> => {
    return runtime.store.createThread({
      id: createOptions.id ?? randomUUID(),
      identityId: identity.id,
      agentKey: createOptions.agentKey ?? "panda",
      context: {
        ...fallbackContext,
        identityId: identity.id,
        identityHandle: identity.handle,
      },
      provider: createOptions.provider ?? options.provider,
      model: createOptions.model ?? options.model,
      thinking: createOptions.thinking,
    });
  };

  return {
    mode: runtime.mode,
    identity,
    identityStore: runtime.identityStore,
    store: runtime.store,
    coordinator: runtime.coordinator,
    extraTools: runtime.extraTools,
    createThread,
    getThread: async (threadId) => assertIdentityThreadAccess(await runtime.store.getThread(threadId), identity),
    listThreadSummaries: (limit = 20) => runtime.store.listThreadSummaries(limit, identity.id),
    recoverOrphanedRuns: (reason) => runtime.coordinator.recoverOrphanedRuns(reason),
    close: runtime.close,
  };
}
