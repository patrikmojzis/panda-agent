import {createHash, randomUUID} from "node:crypto";

import type {PoolClient} from "pg";

import {ChannelTypingDispatcher, type MediaDescriptor, relocateMediaDescriptor,} from "../../domain/channels/index.js";
import {PostgresChannelActionStore} from "../../domain/channels/actions/index.js";
import {ConversationRepo} from "../../domain/threads/conversations/repo.js";
import {PandaDaemonStateRepo} from "./state/repo.js";
import {HeartbeatRunner} from "../../domain/scheduling/heartbeats/runner.js";
import {PostgresHomeThreadStore} from "../../domain/threads/home/index.js";
import {
    createDefaultIdentityInput,
    DEFAULT_IDENTITY_HANDLE,
    type IdentityRecord,
} from "../../domain/identity/index.js";
import {PostgresOutboundDeliveryStore} from "../../domain/channels/deliveries/index.js";
import {createPandaRuntime, createPandaThreadDefinition} from "./create-runtime.js";
import {resolveDefaultPandaModelSelector} from "../../personas/panda/defaults.js";
import type {
    AbortThreadRequestPayload,
    CompactThreadRequestPayload,
    CreateThreadRequestPayload,
    PandaRuntimeRequestRecord,
    ResetHomeThreadRequestPayload,
    ResolveHomeThreadRequestPayload,
    SwitchHomeAgentRequestPayload,
    TelegramMessageRequestPayload,
    TelegramReactionRequestPayload,
    TuiInputRequestPayload,
    UpdateThreadRequestPayload,
    WhatsAppMessageRequestPayload,
} from "../../domain/threads/requests/index.js";
import {PandaRuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {ScheduledTaskRunner} from "../../domain/scheduling/tasks/index.js";
import {createChannelTypingEventHandler} from "../../domain/threads/runtime/channel-typing.js";
import {compactThread, isMissingThreadError, type ThreadRecord,} from "../../domain/threads/runtime/index.js";
import {resolveModelSelector, stringToUserMessage} from "../../kernel/agent/index.js";
import type {JsonValue} from "../../kernel/agent/types.js";
import {ThreadRouteRepo} from "../../domain/threads/routes/repo.js";
import {
    buildTelegramInboundPersistence,
    buildTelegramInboundText,
    buildTelegramPairCommand,
    buildTelegramReactionText,
    normalizeTelegramCommand,
} from "../../integrations/channels/telegram/helpers.js";
import {TELEGRAM_SOURCE} from "../../integrations/channels/telegram/config.js";
import {TelegramReactTool} from "../../integrations/channels/telegram/telegram-react-tool.js";
import {buildWhatsAppInboundMetadata, buildWhatsAppInboundText} from "../../integrations/channels/whatsapp/helpers.js";
import {WHATSAPP_SOURCE} from "../../integrations/channels/whatsapp/config.js";
import {OutboundTool} from "../../personas/panda/tools/outbound-tool.js";
import {resolveProviderApiKey} from "../../integrations/providers/shared/auth.js";
import {getProviderConfig} from "../../integrations/providers/shared/provider.js";
import {resolvePandaAgentMediaDir} from "./data-dir.js";

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

function missingApiKeyMessage(modelSelector: string): string | null {
  const selection = resolveModelSelector(modelSelector);
  return resolveProviderApiKey(selection.providerName)
    ? null
    : getProviderConfig(selection.providerName).missingApiKeyMessage;
}

function requireIdentityId(identityId: string | undefined, kind: string): string {
  const trimmed = trimNonEmptyString(identityId);
  if (!trimmed) {
    throw new Error(`Runtime request ${kind} is missing identityId.`);
  }

  return trimmed;
}

function buildHomeAgentMismatchMessage(identity: IdentityRecord, existingAgentKey: string, requestedAgentKey: string): string {
  return `Identity ${identity.handle} already has a home thread on agent ${existingAgentKey}. Use 'panda identity switch-home-agent ${identity.handle} ${requestedAgentKey}' to replace it.`;
}

export function resolveImplicitHomeThreadReplacementAgent(input: {
  requestedAgentKey?: string;
  existingAgentKey: string;
  identityDefaultAgentKey?: string;
}): string | undefined {
  const requestedAgentKey = trimNonEmptyString(input.requestedAgentKey);
  const defaultAgentKey = trimNonEmptyString(input.identityDefaultAgentKey);
  if (requestedAgentKey || !defaultAgentKey || input.existingAgentKey === defaultAgentKey) {
    return undefined;
  }

  // "Open chat without --agent" should follow the identity default now, not
  // whatever agent happened to own the home thread some time in the past.
  return defaultAgentKey;
}

export async function createPandaDaemon(options: PandaDaemonOptions): Promise<PandaDaemonServices> {
  const fallbackContext = {
    cwd: options.cwd,
  } as const;
  const model = resolveDefaultPandaModelSelector();
  const daemonKey = DEFAULT_PANDA_DAEMON_KEY;

  let conversationBindings: ConversationRepo;
  let homeThreads: PostgresHomeThreadStore;
  let threadRoutes: ThreadRouteRepo;
  let outboundDeliveries: PostgresOutboundDeliveryStore;
  let channelActions: PostgresChannelActionStore;
  let requests: PandaRuntimeRequestRepo;
  let daemonState: PandaDaemonStateRepo;
  let requestUnsubscribe: (() => Promise<void>) | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let scheduledTaskRunner: ScheduledTaskRunner | null = null;
  let relationshipHeartbeatRunner: HeartbeatRunner | null = null;
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
    resolveDefinition: async (thread, {agentStore, credentialResolver, identityStore, extraTools}) => {
      const identity = await identityStore.getIdentity(thread.identityId);
      return createPandaThreadDefinition({
        thread,
        fallbackContext: {
          ...fallbackContext,
          identityId: identity.id,
          identityHandle: identity.handle,
        },
        agentStore,
        bashToolOptions: {
          credentialResolver,
        },
        extraTools: [...extraTools, new OutboundTool(), new TelegramReactTool()],
        extraContext: {
          routeMemory: {
            getLastRoute: (channel) => threadRoutes.getLastRoute({
              threadId: thread.id,
              channel,
            }),
            saveLastRoute: async (route) => {
              await threadRoutes.saveLastRoute({
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
    conversationBindings = new ConversationRepo({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await conversationBindings.ensureSchema();

    homeThreads = new PostgresHomeThreadStore({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await homeThreads.ensureSchema();

    threadRoutes = new ThreadRouteRepo({
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

    requests = new PandaRuntimeRequestRepo({
      pool: runtime.pool,
      tablePrefix: options.tablePrefix,
    });
    await requests.ensureSchema();

    daemonState = new PandaDaemonStateRepo({
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
    relationshipHeartbeatRunner = new HeartbeatRunner({
      homeThreads,
      coordinator: runtime.coordinator,
      resolveInstructions: async (home) => {
        const thread = await runtime.store.getThread(home.threadId);
        const heartbeatDoc = await runtime.agentStore.readAgentDocument(thread.agentKey, "heartbeat");
        return heartbeatDoc?.content?.trim() || null;
      },
      onError: (error, identityId) => {
        console.error("Relationship heartbeat runner failed", {
          identityId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
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

  const updateIdentityDefaultAgent = async (identity: IdentityRecord, agentKey: string): Promise<IdentityRecord> => {
    if (identity.defaultAgentKey === agentKey) {
      return identity;
    }

    return runtime.identityStore.updateIdentity({
      identityId: identity.id,
      defaultAgentKey: agentKey,
    });
  };

  const createThread = async (input: {
    identity: IdentityRecord;
    id?: string;
    agentKey?: string;
    model?: string;
    thinking?: CreateThreadRequestPayload["thinking"];
    inferenceProjection?: CreateThreadRequestPayload["inferenceProjection"];
    context?: Record<string, unknown>;
  }): Promise<ThreadRecord> => {
    const agentKey = await requireDefaultAgentKey(input.identity, input.agentKey);
    return runtime.store.createThread({
      id: input.id ?? randomUUID(),
      identityId: input.identity.id,
      agentKey,
      context: {
        ...fallbackContext,
        // Do not persist the runner's synthetic home cwd here. Threads survive
        // restarts and deployment changes, so baking a container-only path into
        // stored thread state breaks later local resumes and other path layouts.
        identityId: input.identity.id,
        identityHandle: input.identity.handle,
        ...(input.context ?? {}),
      },
      model: input.model ?? model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
    });
  };

  const relocateThreadMedia = async (
    thread: ThreadRecord,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]> => {
    if (media.length === 0) {
      return media;
    }

    // Move inbound channel media into the agent's home so that remote bash can
    // reach the files through the agent's mounted home directory.
    const rootDir = resolvePandaAgentMediaDir(thread.agentKey);
    return Promise.all(media.map((descriptor) => relocateMediaDescriptor(descriptor, {rootDir})));
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
    const requestedAgentKey = trimNonEmptyString(input.agentKey);
    const existing = await resolveExistingHomeThread(identity.id);
    if (existing) {
      if (!requestedAgentKey || existing.agentKey === requestedAgentKey) {
        const replacementAgentKey = resolveImplicitHomeThreadReplacementAgent({
          requestedAgentKey,
          existingAgentKey: existing.agentKey,
          identityDefaultAgentKey: identity.defaultAgentKey,
        });
        if (replacementAgentKey) {
          const result = await replaceHomeThread({
            identity,
            source: "identity",
            agentKey: replacementAgentKey,
            model: input.model,
            thinking: input.thinking,
            inferenceProjection: input.inferenceProjection,
          });
          return result.thread;
        }

        return existing;
      }

      throw new Error(buildHomeAgentMismatchMessage(identity, existing.agentKey, requestedAgentKey));
    }

    const thread = await createThread({
      identity,
      agentKey: requestedAgentKey,
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
    });
    if (requestedAgentKey) {
      await updateIdentityDefaultAgent(identity, thread.agentKey);
    }
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
    const existing = await conversationBindings.getConversationBinding({
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

    await conversationBindings.bindConversation({
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

  const replaceHomeThread = async (input: {
    identity: IdentityRecord;
    source: ResetHomeThreadRequestPayload["source"] | "identity";
    agentKey?: string;
    model?: string;
    thinking?: CreateThreadRequestPayload["thinking"];
    inferenceProjection?: CreateThreadRequestPayload["inferenceProjection"];
    context?: Record<string, unknown>;
  }): Promise<{thread: ThreadRecord; previousThreadId?: string | null}> => {
    const previousHome = await resolveExistingHomeThread(input.identity.id);
    if (previousHome) {
      await runtime.coordinator.abort(previousHome.id, `Reset requested from ${input.source}.`);
      await runtime.coordinator.waitForCurrentRun(previousHome.id);
      await runtime.store.discardPendingInputs(previousHome.id);
    }

    const thread = await createThread({
      identity: input.identity,
      agentKey: input.agentKey,
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
      context: input.context,
    });
    if (trimNonEmptyString(input.agentKey)) {
      await updateIdentityDefaultAgent(input.identity, thread.agentKey);
    }
    await bindHomeThread(thread);

    return {
      thread,
      previousThreadId: previousHome?.id ?? null,
    };
  };

  const handleResetHomeThread = async (payload: ResetHomeThreadRequestPayload): Promise<Record<string, unknown>> => {
    const identity = await ensureIdentity(requireIdentityId(payload.identityId, "reset_home_thread"));
    const result = await replaceHomeThread({
      identity,
      source: payload.source,
      agentKey: payload.agentKey,
      model: payload.model,
      thinking: payload.thinking,
      inferenceProjection: payload.inferenceProjection,
      context: payload.source === TELEGRAM_SOURCE && payload.externalConversationId
        ? {source: TELEGRAM_SOURCE}
        : undefined,
    });

    if (payload.source === TELEGRAM_SOURCE && payload.connectorKey && payload.externalConversationId) {
      await conversationBindings.bindConversation({
        source: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        threadId: result.thread.id,
        metadata: payload.commandExternalMessageId
          ? {
            kind: "telegram_reset_receipt",
            commandExternalMessageId: payload.commandExternalMessageId,
          }
          : undefined,
      });
      await threadRoutes.saveLastRoute({
        threadId: result.thread.id,
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
      threadId: result.thread.id,
      previousThreadId: result.previousThreadId,
    };
  };

  const handleSwitchHomeAgent = async (payload: SwitchHomeAgentRequestPayload): Promise<Record<string, unknown>> => {
    const identity = await ensureIdentity(requireIdentityId(payload.identityId, "switch_home_agent"));
    const requestedAgentKey = trimNonEmptyString(payload.agentKey);
    if (!requestedAgentKey) {
      throw new Error("Runtime request switch_home_agent is missing agentKey.");
    }

    await runtime.agentStore.getAgent(requestedAgentKey);
    const updatedIdentity = await updateIdentityDefaultAgent(identity, requestedAgentKey);
    const result = await replaceHomeThread({
      identity: updatedIdentity,
      source: "identity",
      agentKey: requestedAgentKey,
    });

    return {
      threadId: result.thread.id,
      previousThreadId: result.previousThreadId,
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

    const media = await relocateThreadMedia(thread, payload.media);
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
      media,
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
      media,
    });

    await runtime.coordinator.submitInput(thread.id, {
      source: TELEGRAM_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      message: stringToUserMessage(text),
      metadata: persistence.metadata,
    });
    await threadRoutes.saveLastRoute({
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
    await threadRoutes.saveLastRoute({
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

    const media = await relocateThreadMedia(thread, payload.media);
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
      media,
    });

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
        media,
      }),
    });
    await threadRoutes.saveLastRoute({
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
      model: payload.model,
      thinking: payload.thinking,
      inferenceProjection: payload.inferenceProjection,
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
      const modelName = thread.model ?? model;
      const apiKeyMessage = missingApiKeyMessage(modelName);
      if (apiKeyMessage) {
        throw new Error(apiKeyMessage);
      }

      if (await runtime.store.hasRunnableInputs(payload.threadId)) {
        throw new Error("Wait for queued input to run before compacting.");
      }

      return compactThread({
        store: runtime.store,
        thread,
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
      case "switch_home_agent":
        return handleSwitchHomeAgent(request.payload as SwitchHomeAgentRequestPayload);
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
      await relationshipHeartbeatRunner?.start();
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
      await relationshipHeartbeatRunner?.stop();
      await releaseLock();
      await runtime.close();
    },
  };
}
