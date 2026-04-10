import {createHash, randomUUID} from "node:crypto";

import type {PoolClient} from "pg";

import {ChannelTypingDispatcher} from "../channels/core/index.js";
import {PostgresChannelActionStore} from "../channel-actions/index.js";
import {PostgresConversationThreadStore} from "../conversation-threads/index.js";
import {PostgresPandaDaemonStateStore} from "../daemon-state/index.js";
import {PostgresHomeThreadStore} from "../home-threads/index.js";
import {createDefaultIdentityInput, DEFAULT_IDENTITY_HANDLE, type IdentityRecord} from "../identity/index.js";
import {PostgresOutboundDeliveryStore} from "../outbound-deliveries/index.js";
import {createPandaRuntime, createPandaThreadDefinition} from "./runtime.js";
import {resolveDefaultPandaModel, resolveDefaultPandaProvider} from "./provider-defaults.js";
import type {
  AbortThreadRequestPayload,
  CompactThreadRequestPayload,
  CreateThreadRequestPayload,
  PandaRuntimeRequestRecord,
  ResetHomeThreadRequestPayload,
  ResolveHomeThreadRequestPayload,
  TelegramMessageRequestPayload,
  TelegramReactionRequestPayload,
  TuiInputRequestPayload,
  UpdateThreadRequestPayload,
  WhatsAppMessageRequestPayload,
} from "../runtime-requests/index.js";
import {PostgresPandaRuntimeRequestStore} from "../runtime-requests/index.js";
import {ScheduledTaskRunner} from "../scheduled-tasks/index.js";
import {createChannelTypingEventHandler} from "../thread-runtime/channel-typing.js";
import {compactThread, isMissingThreadError, type ThreadRecord} from "../thread-runtime/index.js";
import {type ProviderName, stringToUserMessage} from "../agent-core/index.js";
import type {JsonValue} from "../agent-core/types.js";
import {PostgresThreadRouteStore} from "../thread-routes/index.js";
import {
  buildTelegramInboundPersistence,
  buildTelegramInboundText,
  buildTelegramPairCommand,
  buildTelegramReactionText,
  normalizeTelegramCommand,
} from "../telegram/helpers.js";
import {TELEGRAM_SOURCE} from "../telegram/config.js";
import {TelegramReactTool} from "../telegram/telegram-react-tool.js";
import {buildWhatsAppInboundMetadata, buildWhatsAppInboundText} from "../whatsapp/helpers.js";
import {WHATSAPP_SOURCE} from "../whatsapp/config.js";
import {OutboundTool} from "./tools/outbound-tool.js";
import {resolveProviderApiKey} from "../agent-core/pi/auth.js";
import {getProviderConfig} from "../agent-core/provider.js";

export const DEFAULT_PANDA_DAEMON_KEY = "primary";
export const PANDA_DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;
export const PANDA_DAEMON_STALE_AFTER_MS = 15_000;
export const PANDA_DAEMON_REQUEST_TIMEOUT_MS = 30_000;

export interface PandaDaemonOptions {
  cwd: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
  maxSubagentDepth?: number;
  tablePrefix?: string;
}

export interface PandaDaemonServices {
  run(): Promise<void>;
  stop(): Promise<void>;
}

function trimNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function hashLockKey(value: string): readonly [number, number] {
  const digest = createHash("sha256").update(value).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)] as const;
}

function buildTelegramStartText(actorId: string, defaultIdentityHandle = DEFAULT_IDENTITY_HANDLE): string {
  return [
    "Pair this Telegram account with Panda by running:",
    buildTelegramPairCommand(actorId, defaultIdentityHandle),
    "",
    "Adjust the identity handle if you want a different Panda identity.",
  ].join("\n");
}

function missingApiKeyMessage(provider: ProviderName): string | null {
  return resolveProviderApiKey(provider) ? null : getProviderConfig(provider).missingApiKeyMessage;
}

function requireIdentityId(identityId: string | undefined, kind: string): string {
  const trimmed = trimNonEmptyString(identityId);
  if (!trimmed) {
    throw new Error(`Runtime request ${kind} is missing identityId.`);
  }

  return trimmed;
}

export async function createPandaDaemon(options: PandaDaemonOptions): Promise<PandaDaemonServices> {
  const fallbackContext = {
    cwd: options.cwd,
  } as const;
  const provider = resolveDefaultPandaProvider();
  const model = resolveDefaultPandaModel(provider);
  const daemonKey = DEFAULT_PANDA_DAEMON_KEY;

  let conversationThreads: PostgresConversationThreadStore;
  let homeThreads: PostgresHomeThreadStore;
  let threadRoutes: PostgresThreadRouteStore;
  let outboundDeliveries: PostgresOutboundDeliveryStore;
  let channelActions: PostgresChannelActionStore;
  let requests: PostgresPandaRuntimeRequestStore;
  let daemonState: PostgresPandaDaemonStateStore;
  let requestUnsubscribe: (() => Promise<void>) | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let scheduledTaskRunner: ScheduledTaskRunner | null = null;
  let lockClient: PoolClient | null = null;
  let drainPromise: Promise<void> | null = null;
  let pendingDrain = false;
  let stopped = false;

  const typingDispatcher = new ChannelTypingDispatcher([
    {
      channel: TELEGRAM_SOURCE,
      send: async (request) => {
        await channelActions.enqueueAction({
          channel: TELEGRAM_SOURCE,
          connectorKey: request.target.connectorKey,
          kind: "typing",
          payload: request,
        });
      },
    },
    {
      channel: WHATSAPP_SOURCE,
      send: async (request) => {
        await channelActions.enqueueAction({
          channel: WHATSAPP_SOURCE,
          connectorKey: request.target.connectorKey,
          kind: "typing",
          payload: request,
        });
      },
    },
  ]);

  const runtime = await createPandaRuntime({
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    maxSubagentDepth: options.maxSubagentDepth,
    tablePrefix: options.tablePrefix,
    onEvent: createChannelTypingEventHandler(typingDispatcher),
    resolveDefinition: async (thread, {agentStore, identityStore, extraTools}) => {
      const identity = await identityStore.getIdentity(thread.identityId);
      return createPandaThreadDefinition({
        thread,
        fallbackContext: {
          ...fallbackContext,
          identityId: identity.id,
          identityHandle: identity.handle,
        },
        agentStore,
        extraTools: [...extraTools, new OutboundTool(), new TelegramReactTool()],
        extraContext: {
          routeMemory: {
            getLastRoute: (channel) => threadRoutes.resolveLastRoute({
              threadId: thread.id,
              channel,
            }),
            rememberLastRoute: async (route) => {
              await threadRoutes.rememberLastRoute({
                threadId: thread.id,
                route,
              });
            },
          },
          outboundQueue: {
            enqueueDelivery: (input) => outboundDeliveries.enqueueDelivery(input),
          },
          channelActionQueue: {
            enqueueAction: (input) => channelActions.enqueueAction(input),
          },
        },
      });
    },
  });

  try {
    conversationThreads = new PostgresConversationThreadStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await conversationThreads.ensureSchema();

    homeThreads = new PostgresHomeThreadStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await homeThreads.ensureSchema();

    threadRoutes = new PostgresThreadRouteStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await threadRoutes.ensureSchema();

    outboundDeliveries = new PostgresOutboundDeliveryStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await outboundDeliveries.ensureSchema();

    channelActions = new PostgresChannelActionStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await channelActions.ensureSchema();

    requests = new PostgresPandaRuntimeRequestStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await requests.ensureSchema();

    daemonState = new PostgresPandaDaemonStateStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await daemonState.ensureSchema();

    scheduledTaskRunner = new ScheduledTaskRunner({
      tasks: runtime.scheduledTasks,
      homeThreads,
      threadRoutes,
      outboundDeliveries,
      threadStore: runtime.store,
      coordinator: runtime.coordinator,
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }

  const ensureIdentity = async (identityId: string): Promise<IdentityRecord> => {
    return identityId === createDefaultIdentityInput().id
      ? runtime.identityStore.ensureIdentity(createDefaultIdentityInput())
      : runtime.identityStore.getIdentity(identityId);
  };

  const requireDefaultAgentKey = async (identity: IdentityRecord, explicitAgentKey?: string): Promise<string> => {
    const agentKey = trimNonEmptyString(explicitAgentKey) ?? trimNonEmptyString(identity.defaultAgentKey);
    if (!agentKey) {
      throw new Error(`Identity ${identity.handle} has no default agent. Set one explicitly before creating a home thread.`);
    }

    await runtime.agentStore.getAgent(agentKey);
    return agentKey;
  };

  const createThread = async (input: {
    identity: IdentityRecord;
    id?: string;
    agentKey?: string;
    provider?: ProviderName;
    model?: string;
    thinking?: CreateThreadRequestPayload["thinking"];
    context?: Record<string, unknown>;
  }): Promise<ThreadRecord> => {
    const agentKey = await requireDefaultAgentKey(input.identity, input.agentKey);
    return runtime.store.createThread({
      id: input.id ?? randomUUID(),
      identityId: input.identity.id,
      agentKey,
      context: {
        ...fallbackContext,
        identityId: input.identity.id,
        identityHandle: input.identity.handle,
        ...(input.context ?? {}),
      },
      provider: input.provider ?? provider,
      model: input.model ?? model,
      thinking: input.thinking,
    });
  };

  const bindHomeThread = async (thread: ThreadRecord): Promise<void> => {
    await homeThreads.bindHomeThread({
      identityId: thread.identityId,
      threadId: thread.id,
    });
  };

  const resolveExistingHomeThread = async (identityId: string): Promise<ThreadRecord | null> => {
    const existing = await homeThreads.resolveHomeThread({identityId});
    if (!existing) {
      return null;
    }

    try {
      const thread = await runtime.store.getThread(existing.threadId);
      return thread.identityId === identityId ? thread : null;
    } catch (error) {
      if (isMissingThreadError(error, existing.threadId)) {
        return null;
      }

      throw error;
    }
  };

  const resolveOrCreateHomeThread = async (input: ResolveHomeThreadRequestPayload): Promise<ThreadRecord> => {
    const identity = await ensureIdentity(requireIdentityId(input.identityId, "resolve_home_thread"));
    const existing = await resolveExistingHomeThread(identity.id);
    if (existing) {
      return existing;
    }

    const thread = await createThread({
      identity,
      agentKey: input.agentKey,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
    });
    await bindHomeThread(thread);
    return thread;
  };

  const resolveOrCreateConversationThread = async (input: {
    identityId: string;
    source: string;
    connectorKey: string;
    externalConversationId: string;
    context?: Record<string, unknown>;
    metadata?: JsonValue;
  }): Promise<ThreadRecord | null> => {
    const existing = await conversationThreads.resolveConversationThread({
      source: input.source,
      connectorKey: input.connectorKey,
      externalConversationId: input.externalConversationId,
    });
    if (existing) {
      try {
        const thread = await runtime.store.getThread(existing.threadId);
        return thread.identityId === input.identityId ? thread : null;
      } catch (error) {
        if (!isMissingThreadError(error, existing.threadId)) {
          throw error;
        }
      }
    }

    const identity = await ensureIdentity(input.identityId);
    const home = await resolveExistingHomeThread(identity.id);
    const thread = home ?? await createThread({
      identity,
      context: input.context,
    });
    if (!home) {
      await bindHomeThread(thread);
    }

    await conversationThreads.bindConversationThread({
      source: input.source,
      connectorKey: input.connectorKey,
      externalConversationId: input.externalConversationId,
      threadId: thread.id,
      metadata: input.metadata,
    });
    return thread;
  };

  const queueSystemReply = async (input: {
    channel: string;
    connectorKey: string;
    externalConversationId: string;
    externalActorId?: string;
    text: string;
    replyToMessageId?: string;
    threadId?: string;
  }): Promise<void> => {
    await outboundDeliveries.enqueueDelivery({
      threadId: input.threadId,
      channel: input.channel,
      target: {
        source: input.channel,
        connectorKey: input.connectorKey,
        externalConversationId: input.externalConversationId,
        externalActorId: input.externalActorId,
        replyToMessageId: input.replyToMessageId,
      },
      items: [{
        type: "text",
        text: input.text,
      }],
    });
  };

  const handleResetHomeThread = async (payload: ResetHomeThreadRequestPayload): Promise<Record<string, unknown>> => {
    const identityId = requireIdentityId(payload.identityId, "reset_home_thread");
    const previousHome = await resolveExistingHomeThread(identityId);
    if (previousHome) {
      await runtime.coordinator.abort(previousHome.id, `Reset requested from ${payload.source}.`);
      await runtime.coordinator.waitForCurrentRun(previousHome.id);
      await runtime.store.discardPendingInputs(previousHome.id);
    }

    const identity = await ensureIdentity(identityId);
    const thread = await createThread({
      identity,
      provider: payload.provider,
      model: payload.model,
      context: payload.source === TELEGRAM_SOURCE && payload.externalConversationId
        ? {source: TELEGRAM_SOURCE}
        : undefined,
    });
    await bindHomeThread(thread);

    if (payload.source === TELEGRAM_SOURCE && payload.connectorKey && payload.externalConversationId) {
      await conversationThreads.bindConversationThread({
        source: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        threadId: thread.id,
        metadata: payload.commandExternalMessageId
          ? {
            kind: "telegram_reset_receipt",
            commandExternalMessageId: payload.commandExternalMessageId,
          }
          : undefined,
      });
      await threadRoutes.rememberLastRoute({
        threadId: thread.id,
        route: {
          source: TELEGRAM_SOURCE,
          connectorKey: payload.connectorKey,
          externalConversationId: payload.externalConversationId,
          externalActorId: payload.externalActorId,
          externalMessageId: payload.commandExternalMessageId,
          capturedAt: Date.now(),
        },
      });
    }

    return {
      threadId: thread.id,
      previousThreadId: previousHome?.id ?? null,
    };
  };

  const handleTelegramMessage = async (payload: TelegramMessageRequestPayload): Promise<Record<string, unknown>> => {
    const command = normalizeTelegramCommand(payload.text, payload.botUsername);
    const binding = await runtime.identityStore.resolveIdentityBinding({
      source: TELEGRAM_SOURCE,
      connectorKey: payload.connectorKey,
      externalActorId: payload.externalActorId,
    });

    if (command === "start" && !binding) {
      await queueSystemReply({
        channel: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        text: buildTelegramStartText(payload.externalActorId),
        replyToMessageId: payload.externalMessageId,
      });
      return {status: "replied", reason: "start_unpaired"};
    }

    if (!binding) {
      return {status: "dropped", reason: "unpaired_actor"};
    }

    if (command === "new") {
      await queueSystemReply({
        channel: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        text: "/new is TUI-only. Use /reset here to start fresh.",
        replyToMessageId: payload.externalMessageId,
      });
      return {status: "replied", reason: "new_is_tui_only"};
    }

    if (command === "reset") {
      const result = await handleResetHomeThread({
        identityId: binding.identityId,
        source: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        commandExternalMessageId: payload.externalMessageId,
      });
      await queueSystemReply({
        channel: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        text: "Reset Panda. Fresh home thread started.",
        replyToMessageId: payload.externalMessageId,
        threadId: typeof result.threadId === "string" ? result.threadId : undefined,
      });
      return result;
    }

    if (!(payload.text?.trim()) && payload.media.length === 0) {
      return {status: "dropped", reason: "unsupported_message_shape"};
    }

    const text = buildTelegramInboundText({
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      externalMessageId: payload.externalMessageId,
      chatId: payload.chatId,
      chatType: payload.chatType,
      text: payload.text,
      username: payload.username,
      firstName: payload.firstName,
      lastName: payload.lastName,
      replyToMessageId: payload.replyToMessageId,
      media: payload.media,
    });
    const persistence = buildTelegramInboundPersistence({
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      externalMessageId: payload.externalMessageId,
      chatId: payload.chatId,
      chatType: payload.chatType,
      messageId: Number.parseInt(payload.externalMessageId, 10) || null,
      username: payload.username,
      firstName: payload.firstName,
      lastName: payload.lastName,
      media: payload.media,
    });

    const thread = await resolveOrCreateConversationThread({
      identityId: binding.identityId,
      source: TELEGRAM_SOURCE,
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      context: {
        source: TELEGRAM_SOURCE,
        chatId: payload.chatId,
      },
    });
    if (!thread) {
      return {status: "dropped", reason: "conversation_identity_mismatch"};
    }

    await runtime.coordinator.submitInput(thread.id, {
      source: TELEGRAM_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      message: stringToUserMessage(text),
      metadata: persistence.metadata,
    });
    await threadRoutes.rememberLastRoute({
      threadId: thread.id,
      route: persistence.rememberedRoute,
    });
    return {status: "queued", threadId: thread.id};
  };

  const handleTelegramReaction = async (payload: TelegramReactionRequestPayload): Promise<Record<string, unknown>> => {
    const binding = await runtime.identityStore.resolveIdentityBinding({
      source: TELEGRAM_SOURCE,
      connectorKey: payload.connectorKey,
      externalActorId: payload.externalActorId,
    });
    if (!binding) {
      return {status: "dropped", reason: "unpaired_actor"};
    }

    const syntheticExternalMessageId = `telegram-reaction:${payload.updateId}`;
    const text = buildTelegramReactionText({
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      externalMessageId: syntheticExternalMessageId,
      chatId: payload.chatId,
      chatType: payload.chatType,
      username: payload.username,
      firstName: payload.firstName,
      lastName: payload.lastName,
      targetMessageId: payload.targetMessageId,
      addedEmojis: payload.addedEmojis,
    });
    const persistence = buildTelegramInboundPersistence({
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      externalMessageId: syntheticExternalMessageId,
      chatId: payload.chatId,
      chatType: payload.chatType,
      messageId: null,
      username: payload.username,
      firstName: payload.firstName,
      lastName: payload.lastName,
      media: [],
      reaction: {
        updateId: payload.updateId,
        targetMessageId: payload.targetMessageId,
        addedEmojis: payload.addedEmojis,
        actorId: payload.externalActorId,
        username: payload.username,
      },
    });

    const thread = await resolveOrCreateConversationThread({
      identityId: binding.identityId,
      source: TELEGRAM_SOURCE,
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      context: {
        source: TELEGRAM_SOURCE,
        chatId: payload.chatId,
      },
    });
    if (!thread) {
      return {status: "dropped", reason: "conversation_identity_mismatch"};
    }

    await runtime.coordinator.submitInput(thread.id, {
      source: TELEGRAM_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: syntheticExternalMessageId,
      actorId: payload.externalActorId,
      message: stringToUserMessage(text),
      metadata: persistence.metadata,
    });
    await threadRoutes.rememberLastRoute({
      threadId: thread.id,
      route: persistence.rememberedRoute,
    });
    return {status: "queued", threadId: thread.id};
  };

  const handleWhatsAppMessage = async (payload: WhatsAppMessageRequestPayload): Promise<Record<string, unknown>> => {
    const binding = await runtime.identityStore.resolveIdentityBinding({
      source: WHATSAPP_SOURCE,
      connectorKey: payload.connectorKey,
      externalActorId: payload.externalActorId,
    });
    if (!binding) {
      return {status: "dropped", reason: "unpaired_actor"};
    }

    if (!(payload.text?.trim()) && payload.media.length === 0) {
      return {status: "dropped", reason: "unsupported_message_shape"};
    }

    const text = buildWhatsAppInboundText({
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      externalMessageId: payload.externalMessageId,
      remoteJid: payload.remoteJid,
      chatType: payload.chatType,
      text: payload.text,
      pushName: payload.pushName,
      quotedMessageId: payload.quotedMessageId,
      media: payload.media,
    });

    const thread = await resolveOrCreateConversationThread({
      identityId: binding.identityId,
      source: WHATSAPP_SOURCE,
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      context: {
        source: WHATSAPP_SOURCE,
        remoteJid: payload.remoteJid,
      },
    });
    if (!thread) {
      return {status: "dropped", reason: "conversation_identity_mismatch"};
    }

    await runtime.coordinator.submitInput(thread.id, {
      source: WHATSAPP_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      message: stringToUserMessage(text),
      metadata: buildWhatsAppInboundMetadata({
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        externalMessageId: payload.externalMessageId,
        remoteJid: payload.remoteJid,
        chatType: payload.chatType,
        pushName: payload.pushName,
        quotedMessageId: payload.quotedMessageId,
        media: payload.media,
      }),
    });
    await threadRoutes.rememberLastRoute({
      threadId: thread.id,
      route: {
        source: WHATSAPP_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        externalMessageId: payload.externalMessageId,
        capturedAt: Date.now(),
      },
    });
    return {status: "queued", threadId: thread.id};
  };

  const handleTuiInput = async (payload: TuiInputRequestPayload): Promise<Record<string, unknown>> => {
    const thread = payload.threadId
      ? await runtime.store.getThread(payload.threadId)
      : await resolveOrCreateHomeThread({
        identityId: requireIdentityId(payload.identityId, "tui_input"),
      });
    await runtime.coordinator.submitInput(thread.id, {
      message: stringToUserMessage(payload.text),
      source: "tui",
      channelId: "terminal",
      externalMessageId: payload.externalMessageId,
      actorId: payload.actorId,
    });
    return {status: "queued", threadId: thread.id};
  };

  const handleCreateThread = async (payload: CreateThreadRequestPayload): Promise<Record<string, unknown>> => {
    const identity = await ensureIdentity(requireIdentityId(payload.identityId, "create_thread"));
    const thread = await createThread({
      identity,
      id: payload.id,
      agentKey: payload.agentKey,
      provider: payload.provider,
      model: payload.model,
      thinking: payload.thinking,
    });
    return {threadId: thread.id};
  };

  const handleAbortThread = async (payload: AbortThreadRequestPayload): Promise<Record<string, unknown>> => {
    const aborted = await runtime.coordinator.abort(payload.threadId, payload.reason);
    return {aborted};
  };

  const handleCompactThread = async (payload: CompactThreadRequestPayload): Promise<Record<string, unknown>> => {
    const compacted = await runtime.coordinator.runExclusively(payload.threadId, async () => {
      const thread = await runtime.store.getThread(payload.threadId);
      const providerName = thread.provider ?? provider;
      const modelName = thread.model ?? model;
      const apiKeyMessage = missingApiKeyMessage(providerName);
      if (apiKeyMessage) {
        throw new Error(apiKeyMessage);
      }

      if (await runtime.store.hasRunnableInputs(payload.threadId)) {
        throw new Error("Wait for queued input to run before compacting.");
      }

      return compactThread({
        store: runtime.store,
        thread,
        providerName,
        model: modelName,
        thinking: thread.thinking,
        customInstructions: payload.customInstructions,
        trigger: "manual",
      });
    });

    if (!compacted) {
      return {compacted: false};
    }

    return {
      compacted: true,
      tokensBefore: compacted.tokensBefore,
      tokensAfter: compacted.tokensAfter,
    };
  };

  const handleUpdateThread = async (payload: UpdateThreadRequestPayload): Promise<Record<string, unknown>> => {
    const thread = await runtime.store.updateThread(payload.threadId, payload.update);
    return {threadId: thread.id};
  };

  const processRequest = async (request: PandaRuntimeRequestRecord): Promise<unknown> => {
    switch (request.kind) {
      case "telegram_message":
        return handleTelegramMessage(request.payload as TelegramMessageRequestPayload);
      case "telegram_reaction":
        return handleTelegramReaction(request.payload as TelegramReactionRequestPayload);
      case "whatsapp_message":
        return handleWhatsAppMessage(request.payload as WhatsAppMessageRequestPayload);
      case "tui_input":
        return handleTuiInput(request.payload as TuiInputRequestPayload);
      case "create_thread":
        return handleCreateThread(request.payload as CreateThreadRequestPayload);
      case "resolve_home_thread": {
        const thread = await resolveOrCreateHomeThread(request.payload as ResolveHomeThreadRequestPayload);
        return {threadId: thread.id};
      }
      case "reset_home_thread":
        return handleResetHomeThread(request.payload as ResetHomeThreadRequestPayload);
      case "abort_thread":
        return handleAbortThread(request.payload as AbortThreadRequestPayload);
      case "compact_thread":
        return handleCompactThread(request.payload as CompactThreadRequestPayload);
      case "update_thread":
        return handleUpdateThread(request.payload as UpdateThreadRequestPayload);
      default:
        throw new Error(`Unsupported runtime request ${(request as {kind: string}).kind}.`);
    }
  };

  const triggerDrain = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    if (drainPromise) {
      pendingDrain = true;
      return;
    }

    drainPromise = (async () => {
      while (!stopped) {
        const request = await requests.claimNextPendingRequest();
        if (!request) {
          return;
        }

        try {
          const result = await processRequest(request);
          await requests.completeRequest(request.id, result);
        } catch (error) {
          await requests.failRequest(request.id, error instanceof Error ? error.message : String(error));
        }
      }
    })();

    try {
      await drainPromise;
    } finally {
      drainPromise = null;
      if (pendingDrain && !stopped) {
        pendingDrain = false;
        await triggerDrain();
      }
    }
  };

  const acquireLock = async (): Promise<void> => {
    const client = await runtime.pool.connect();
    const [keyA, keyB] = hashLockKey(`panda-daemon:${daemonKey}`);
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [keyA, keyB],
    );
    const acquired = Boolean((result.rows[0] as Record<string, unknown> | undefined)?.acquired);
    if (!acquired) {
      client.release();
      throw new Error(`panda run (${daemonKey}) is already active.`);
    }

    lockClient = client;
  };

  const releaseLock = async (): Promise<void> => {
    if (!lockClient) {
      return;
    }

    const client = lockClient;
    lockClient = null;
    const [keyA, keyB] = hashLockKey(`panda-daemon:${daemonKey}`);
    try {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [keyA, keyB]);
    } finally {
      client.release();
    }
  };

  const heartbeat = async (): Promise<void> => {
    await daemonState.heartbeat(daemonKey);
  };

  return {
    run: async () => {
      stopped = false;
      await acquireLock();
      await heartbeat();
      heartbeatTimer = setInterval(() => {
        void heartbeat();
      }, PANDA_DAEMON_HEARTBEAT_INTERVAL_MS);
      requestUnsubscribe = await requests.listenPendingRequests(async () => {
        await triggerDrain();
      });
      await scheduledTaskRunner?.start();
      await runtime.coordinator.recoverOrphanedRuns("Run marked failed before recovery.");
      await triggerDrain();

      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, PANDA_DAEMON_HEARTBEAT_INTERVAL_MS));
      }
    },
    stop: async () => {
      stopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (requestUnsubscribe) {
        await requestUnsubscribe();
        requestUnsubscribe = null;
      }
      await scheduledTaskRunner?.stop();
      await releaseLock();
      await runtime.close();
    },
  };
}
