import {randomUUID} from "node:crypto";

import type {ThinkingLevel} from "@mariozechner/pi-ai";

import type {JsonValue, ProviderName} from "../agent-core/types.js";
import {createPandaRuntime, createPandaThreadDefinition, type PandaRuntimeServices,} from "../panda/runtime.js";
import {PostgresChannelCursorStore} from "../channel-cursors/index.js";
import {type ChannelTypingDispatcher, FileSystemMediaStore} from "../channels/core/index.js";
import {PostgresConversationThreadStore} from "../conversation-threads/index.js";
import {PostgresHomeThreadStore} from "../home-threads/index.js";
import {createDefaultIdentityInput, DEFAULT_IDENTITY_HANDLE, type IdentityRecord,} from "../identity/types.js";
import type {IdentityStore} from "../identity/store.js";
import {PostgresOutboundDeliveryStore} from "../outbound-deliveries/index.js";
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
  agent?: string;
  tablePrefix?: string;
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
  agentKey: string;
  identityStore: IdentityStore;
  store: ThreadRuntimeStore;
  coordinator: ThreadRuntimeCoordinator;
  conversationThreads: PostgresConversationThreadStore;
  homeThreads: PostgresHomeThreadStore;
  channelCursors: PostgresChannelCursorStore;
  outboundDeliveries: PostgresOutboundDeliveryStore;
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
  const defaultAgentKey = options.agent?.trim() || "panda";

  let conversationThreads: PostgresConversationThreadStore;
  let homeThreads: PostgresHomeThreadStore;
  let channelCursors: PostgresChannelCursorStore;
  let outboundDeliveries: PostgresOutboundDeliveryStore;
  let mediaStore: FileSystemMediaStore;

  const pandaRuntime = await createPandaRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    tablePrefix: options.tablePrefix,
    onEvent: createChannelTypingEventHandler(options.typingDispatcher),
    resolveDefinition: async (thread, { agentStore, identityStore, extraTools }) => {
      const identity = await identityStore.getIdentity(thread.identityId);
      const identityHandle = resolveDefaultIdentityHandle(identity);
      const channelTools = [
        new OutboundTool(),
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
        agentStore,
        extraTools: channelTools.length > 0 ? [...extraTools, ...channelTools] : extraTools,
        extraContext: {
          routeMemory: {
            getLastRoute: async (channel) => homeThreads.resolveLastRoute({
              identityId: thread.identityId,
              agentKey: thread.agentKey,
            }, channel),
            rememberLastRoute: async (route) => {
              await homeThreads.rememberLastRoute({
                identityId: thread.identityId,
                agentKey: thread.agentKey,
                route,
              });
            },
          },
          outboundQueue: {
            enqueueDelivery: async (input) => outboundDeliveries.enqueueDelivery(input),
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
    await pandaRuntime.agentStore.getAgent(defaultAgentKey);

    channelCursors = new PostgresChannelCursorStore({
      pool: pandaRuntime.pool,
      tablePrefix: options.tablePrefix,
    });
    await channelCursors.ensureSchema();

    outboundDeliveries = new PostgresOutboundDeliveryStore({
      pool: pandaRuntime.pool,
      tablePrefix: options.tablePrefix,
    });
    await outboundDeliveries.ensureSchema();

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
    const agentKey = createOptions.agentKey ?? defaultAgentKey;
    await pandaRuntime.agentStore.getAgent(agentKey);

    return pandaRuntime.store.createThread({
      id: createOptions.id ?? randomUUID(),
      identityId: identity.id,
      agentKey,
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
    const agentKey = createOptions.agentKey ?? defaultAgentKey;
    await pandaRuntime.agentStore.getAgent(agentKey);
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
    // Home bindings are keyed by (identity, agent). Rebinding a thread under a
    // different agent would make that home slot resolve the wrong persona/memory.
    if (agentKey && agentKey !== thread.agentKey) {
      throw new Error(
        `Cannot bind thread ${thread.id} with agent ${thread.agentKey} under home agent ${agentKey}.`,
      );
    }
    await homeThreads.bindHomeThread({
      identityId: thread.identityId,
      agentKey: thread.agentKey,
      threadId: thread.id,
    });
    return thread;
  };

  return {
    agentKey: defaultAgentKey,
    identityStore: pandaRuntime.identityStore,
    store: pandaRuntime.store,
    coordinator: pandaRuntime.coordinator,
    conversationThreads,
    homeThreads,
    channelCursors,
    outboundDeliveries,
    mediaStore,
    pool: pandaRuntime.pool,
    createThread,
    resolveOrCreateHomeThread,
    setHomeThread,
    getThread: pandaRuntime.store.getThread.bind(pandaRuntime.store),
    close: pandaRuntime.close,
  };
}
