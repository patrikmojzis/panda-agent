import {randomUUID} from "node:crypto";

import type {ThinkingLevel} from "@mariozechner/pi-ai";

import type {JsonValue, ProviderName} from "../agent-core/types.js";
import {createPandaRuntime, createPandaThreadDefinition, type PandaRuntimeServices,} from "../panda/runtime.js";
import {PostgresChannelCursorStore} from "../channel-cursors/index.js";
import {
  type ChannelOutboundDispatcher,
  type ChannelTypingDispatcher,
  FileSystemMediaStore
} from "../channels/core/index.js";
import {PostgresConversationThreadStore} from "../conversation-threads/index.js";
import {PostgresHomeThreadStore} from "../home-threads/index.js";
import {createDefaultIdentityInput, DEFAULT_IDENTITY_HANDLE, type IdentityRecord,} from "../identity/types.js";
import type {IdentityStore} from "../identity/store.js";
import {OutboundTool} from "../panda/tools/outbound-tool.js";
import {createChannelTypingEventHandler} from "../thread-runtime/channel-typing.js";
import {type TelegramReactionApi, TelegramReactTool} from "./telegram-react-tool.js";
import type {ThreadRuntimeCoordinator} from "../thread-runtime/coordinator.js";
import type {ThreadRuntimeStore} from "../thread-runtime/store.js";
import {isMissingThreadError, type ThreadRecord} from "../thread-runtime/types.js";
import {TELEGRAM_SOURCE} from "./config.js";

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
  typingDispatcher?: ChannelTypingDispatcher;
  telegramConnectorKey?: string;
  telegramReactionApi?: TelegramReactionApi;
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
  homeThreads: PostgresHomeThreadStore;
  channelCursors: PostgresChannelCursorStore;
  mediaStore: FileSystemMediaStore;
  pool: PandaRuntimeServices["pool"];
  createThread(options: CreateTelegramThreadOptions): Promise<ThreadRecord>;
  resolveOrCreateHomeThread(options: CreateTelegramThreadOptions): Promise<ThreadRecord>;
  setHomeThread(threadId: string, agentKey?: string): Promise<ThreadRecord>;
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

  let conversationThreads: PostgresConversationThreadStore;
  let homeThreads: PostgresHomeThreadStore;
  let channelCursors: PostgresChannelCursorStore;
  let mediaStore: FileSystemMediaStore;

  const pandaRuntime = await createPandaRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    tablePrefix: options.tablePrefix,
    onEvent: createChannelTypingEventHandler(options.typingDispatcher),
    resolveDefinition: async (thread, { identityStore, extraTools }) => {
      const identity = await identityStore.getIdentity(thread.identityId);
      const identityHandle = resolveDefaultIdentityHandle(identity);
      const channelTools = [
        ...(options.outboundDispatcher ? [new OutboundTool()] : []),
        ...(
          options.telegramReactionApi && options.telegramConnectorKey
            ? [new TelegramReactTool({
              api: options.telegramReactionApi,
              connectorKey: options.telegramConnectorKey,
            })]
            : []
        ),
      ];

      return createPandaThreadDefinition({
        thread,
        fallbackContext: {
          ...fallbackContext,
          identityId: identity.id,
          identityHandle,
        },
        extraTools: channelTools.length > 0 ? [...extraTools, ...channelTools] : extraTools,
        extraContext: {
          outboundDispatcher: options.outboundDispatcher,
          routeMemory: {
            getLastRoute: async () => homeThreads.resolveLastRoute({
              identityId: thread.identityId,
              agentKey: thread.agentKey,
            }),
            rememberLastRoute: async (route) => {
              await homeThreads.rememberLastRoute({
                identityId: thread.identityId,
                agentKey: thread.agentKey,
                route,
              });
            },
          },
        },
      });
    },
  });

  try {
    conversationThreads = new PostgresConversationThreadStore({
      pool: pandaRuntime.pool,
      tablePrefix: options.tablePrefix,
    });
    await conversationThreads.ensureSchema();

    homeThreads = new PostgresHomeThreadStore({
      pool: pandaRuntime.pool,
      tablePrefix: options.tablePrefix,
    });
    await homeThreads.ensureSchema();

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
    const defaultIdentity = createDefaultIdentityInput();
    const identity = createOptions.identityId === defaultIdentity.id
      ? await pandaRuntime.identityStore.ensureIdentity(defaultIdentity)
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

  const resolveOrCreateHomeThread = async (
    createOptions: CreateTelegramThreadOptions,
  ): Promise<ThreadRecord> => {
    const agentKey = createOptions.agentKey ?? "panda";
    const existing = await homeThreads.resolveHomeThread({
      identityId: createOptions.identityId,
      agentKey,
    });

    if (existing) {
      try {
        return await pandaRuntime.store.getThread(existing.threadId);
      } catch (error) {
        if (!isMissingThreadError(error, existing.threadId)) {
          throw error;
        }
      }
    }

    // Missing home means "create a fresh home", not "promote whatever thread was touched last".
    const thread = await createThread({
      ...createOptions,
      agentKey,
    });
    await homeThreads.bindHomeThread({
      identityId: thread.identityId,
      agentKey,
      threadId: thread.id,
    });
    return thread;
  };

  const setHomeThread = async (threadId: string, agentKey?: string): Promise<ThreadRecord> => {
    const thread = await pandaRuntime.store.getThread(threadId);
    await homeThreads.bindHomeThread({
      identityId: thread.identityId,
      agentKey: agentKey ?? thread.agentKey,
      threadId: thread.id,
    });
    return thread;
  };

  return {
    identityStore: pandaRuntime.identityStore,
    store: pandaRuntime.store,
    coordinator: pandaRuntime.coordinator,
    conversationThreads,
    homeThreads,
    channelCursors,
    mediaStore,
    pool: pandaRuntime.pool,
    createThread,
    resolveOrCreateHomeThread,
    setHomeThread,
    getThread: pandaRuntime.store.getThread.bind(pandaRuntime.store),
    close: pandaRuntime.close,
  };
}
