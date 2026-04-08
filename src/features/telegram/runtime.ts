import { randomUUID } from "node:crypto";

import type { ThinkingLevel } from "@mariozechner/pi-ai";

import { Agent } from "../agent-core/agent.js";
import type { ProviderName, JsonValue } from "../agent-core/types.js";
import { buildPandaTools } from "../panda/agent.js";
import { DateTimeContext, EnvironmentContext } from "../panda/contexts/index.js";
import { PANDA_PROMPT } from "../panda/prompts.js";
import {
  createPandaRuntime,
  resolveStoredPandaContext,
  type PandaRuntimeServices,
} from "../panda/runtime.js";
import type { PandaSessionContext } from "../panda/types.js";
import { PostgresChannelCursorStore } from "../channel-cursors/index.js";
import { type ChannelOutboundDispatcher, FileSystemMediaStore } from "../channels/core/index.js";
import { PostgresConversationThreadStore } from "../conversation-threads/index.js";
import {
  createDefaultIdentityInput,
  DEFAULT_IDENTITY_HANDLE,
  type IdentityRecord,
} from "../identity/types.js";
import type { IdentityStore } from "../identity/store.js";
import { OutboundTool } from "../panda/tools/outbound-tool.js";
import type { ThreadRuntimeCoordinator } from "../thread-runtime/coordinator.js";
import type { ThreadRuntimeStore } from "../thread-runtime/store.js";
import type { ThreadRecord } from "../thread-runtime/types.js";
import { TELEGRAM_SOURCE } from "./config.js";

export interface TelegramRuntimeOptions {
  cwd: string;
  locale: string;
  timezone: string;
  dataDir: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
  provider?: ProviderName;
  model?: string;
  tablePrefix?: string;
  outboundDispatcher?: ChannelOutboundDispatcher;
}

export interface CreateTelegramThreadOptions {
  identityId: string;
  id?: string;
  agentKey?: string;
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingLevel;
  context?: JsonValue;
}

export interface TelegramRuntimeServices {
  identityStore: IdentityStore;
  store: ThreadRuntimeStore;
  coordinator: ThreadRuntimeCoordinator;
  conversationThreads: PostgresConversationThreadStore;
  channelCursors: PostgresChannelCursorStore;
  mediaStore: FileSystemMediaStore;
  pool: PandaRuntimeServices["pool"];
  createThread(options: CreateTelegramThreadOptions): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  close(): Promise<void>;
}

function resolveDefaultIdentityHandle(identity: IdentityRecord): string {
  return identity.handle || DEFAULT_IDENTITY_HANDLE;
}

export async function createTelegramRuntime(options: TelegramRuntimeOptions): Promise<TelegramRuntimeServices> {
  const fallbackContext = {
    cwd: options.cwd,
    locale: options.locale,
    timezone: options.timezone,
  } as const;

  const pandaRuntime = await createPandaRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    tablePrefix: options.tablePrefix,
    resolveDefinition: async (thread, { identityStore, extraTools }) => {
      const identity = await identityStore.getIdentity(thread.identityId);
      const context: PandaSessionContext = {
        ...resolveStoredPandaContext(thread.context, {
          ...fallbackContext,
          identityId: identity.id,
          identityHandle: resolveDefaultIdentityHandle(identity),
        }),
        threadId: thread.id,
        agentKey: thread.agentKey,
        identityId: identity.id,
        identityHandle: resolveDefaultIdentityHandle(identity),
        outboundDispatcher: options.outboundDispatcher,
      };

      return {
        agent: new Agent({
          name: thread.agentKey,
          instructions: PANDA_PROMPT,
          tools: buildPandaTools([
            ...extraTools,
            ...(options.outboundDispatcher ? [new OutboundTool<PandaSessionContext>()] : []),
          ]),
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

  let conversationThreads: PostgresConversationThreadStore;
  let channelCursors: PostgresChannelCursorStore;
  let mediaStore: FileSystemMediaStore;

  try {
    conversationThreads = new PostgresConversationThreadStore({
      pool: pandaRuntime.pool,
      tablePrefix: options.tablePrefix,
    });
    await conversationThreads.ensureSchema();

    channelCursors = new PostgresChannelCursorStore({
      pool: pandaRuntime.pool,
      tablePrefix: options.tablePrefix,
    });
    await channelCursors.ensureSchema();

    mediaStore = new FileSystemMediaStore({
      rootDir: options.dataDir,
    });
  } catch (error) {
    await pandaRuntime.close();
    throw error;
  }

  const createThread = async (createOptions: CreateTelegramThreadOptions): Promise<ThreadRecord> => {
    const identity = createOptions.identityId === createDefaultIdentityInput().id
      ? await pandaRuntime.identityStore.ensureIdentity(createDefaultIdentityInput())
      : await pandaRuntime.identityStore.getIdentity(createOptions.identityId);

    return pandaRuntime.store.createThread({
      id: createOptions.id ?? randomUUID(),
      identityId: identity.id,
      agentKey: createOptions.agentKey ?? "panda",
      context: {
        ...fallbackContext,
        identityId: identity.id,
        identityHandle: resolveDefaultIdentityHandle(identity),
        source: TELEGRAM_SOURCE,
        ...(createOptions.context && typeof createOptions.context === "object" && !Array.isArray(createOptions.context)
          ? createOptions.context
          : {}),
      },
      provider: createOptions.provider ?? options.provider,
      model: createOptions.model ?? options.model,
      thinking: createOptions.thinking,
    });
  };

  return {
    identityStore: pandaRuntime.identityStore,
    store: pandaRuntime.store,
    coordinator: pandaRuntime.coordinator,
    conversationThreads,
    channelCursors,
    mediaStore,
    pool: pandaRuntime.pool,
    createThread,
    getThread: pandaRuntime.store.getThread.bind(pandaRuntime.store),
    close: pandaRuntime.close,
  };
}
