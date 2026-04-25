import type {
    A2AMessageRequestPayload,
    AbortThreadRequestPayload,
    CompactThreadRequestPayload,
    CreateBranchSessionRequestPayload,
    ResetSessionRequestPayload,
    ResolveMainSessionThreadRequestPayload,
    ResolveThreadRunConfigRequestPayload,
    RuntimeRequestRecord,
    TelegramMessageRequestPayload,
    TelegramReactionRequestPayload,
    TuiInputRequestPayload,
    UpdateThreadRequestPayload,
    WhatsAppMessageRequestPayload,
} from "../../domain/threads/requests/index.js";
import {compactThread} from "../../domain/threads/runtime/index.js";
import {stringToUserMessage} from "../../kernel/agent/index.js";
import {buildA2AInboundPersistence, buildA2AInboundText} from "../../integrations/channels/a2a/helpers.js";
import {A2A_SOURCE} from "../../integrations/channels/a2a/config.js";
import {
    buildTelegramInboundPersistence,
    buildTelegramInboundText,
    buildTelegramReactionText,
    normalizeTelegramCommand,
} from "../../integrations/channels/telegram/helpers.js";
import {TELEGRAM_SOURCE} from "../../integrations/channels/telegram/config.js";
import {buildTuiInboundPersistence, buildTuiInboundText, TUI_SOURCE,} from "../../integrations/channels/tui/helpers.js";
import {buildWhatsAppInboundMetadata, buildWhatsAppInboundText,} from "../../integrations/channels/whatsapp/helpers.js";
import {WHATSAPP_SOURCE} from "../../integrations/channels/whatsapp/config.js";
import {readMissingApiKeyMessageForModel} from "../../integrations/providers/shared/missing-api-key.js";
import type {DaemonContext} from "./daemon-bootstrap.js";
import {
    buildQueuedInputCompactionMessage,
    buildTelegramNewIsTuiOnlyText,
    buildTelegramResetText,
    buildTelegramStartText,
    buildUnsupportedRuntimeRequestMessage,
} from "./daemon-copy.js";
import type {DaemonThreadHelpers} from "./daemon-threads.js";
import {requireIdentityId} from "./daemon-shared.js";

export function createDaemonRequestProcessor(
  context: DaemonContext,
  threads: DaemonThreadHelpers,
): (request: RuntimeRequestRecord) => Promise<unknown> {
  const handleTelegramMessage = async (
    payload: TelegramMessageRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const command = normalizeTelegramCommand(payload.text, payload.botUsername);
    const binding = await context.runtime.identityStore.resolveIdentityBinding({
      source: TELEGRAM_SOURCE,
      connectorKey: payload.connectorKey,
      externalActorId: payload.externalActorId,
    });

    if (command === "start" && !binding) {
      await threads.queueSystemReply({
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
      await threads.queueSystemReply({
        channel: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        text: buildTelegramNewIsTuiOnlyText(),
        replyToMessageId: payload.externalMessageId,
      });
      return {status: "replied", reason: "new_is_tui_only"};
    }

    if (command === "reset") {
      const result = await threads.handleResetSession({
        identityId: binding.identityId,
        source: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        commandExternalMessageId: payload.externalMessageId,
      });
      await threads.queueSystemReply({
        channel: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        text: buildTelegramResetText(),
        replyToMessageId: payload.externalMessageId,
        threadId: typeof result.threadId === "string" ? result.threadId : undefined,
      });
      return result;
    }

    if (!(payload.text?.trim()) && payload.media.length === 0) {
      return {status: "dropped", reason: "unsupported_message_shape"};
    }

    const identity = await context.runtime.identityStore.getIdentity(binding.identityId);
    const thread = await threads.resolveOrCreateConversationThread({
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

    const media = await threads.relocateThreadMedia(thread, payload.media);
    const text = buildTelegramInboundText({
      connectorKey: payload.connectorKey,
      sentAt: payload.sentAt ? new Date(payload.sentAt).toISOString() : undefined,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      externalMessageId: payload.externalMessageId,
      identityHandle: identity.handle,
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
      sentAt: payload.sentAt ? new Date(payload.sentAt).toISOString() : undefined,
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

    await context.runtime.coordinator.submitInput(thread.id, {
      source: TELEGRAM_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      identityId: binding.identityId,
      message: stringToUserMessage(text),
      metadata: persistence.metadata,
    });
    await context.sessionRoutes.saveLastRoute({
      sessionId: thread.sessionId,
      identityId: binding.identityId,
      route: persistence.rememberedRoute,
    });
    return {status: "queued", threadId: thread.id};
  };

  const handleA2AMessage = async (
    payload: A2AMessageRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const allowed = await context.a2aBindings.hasBinding({
      senderSessionId: payload.fromSessionId,
      recipientSessionId: payload.toSessionId,
    });
    if (!allowed) {
      return {status: "dropped", reason: "unbound_session_pair"};
    }

    const session = await context.runtime.sessionStore.getSession(payload.toSessionId);
    if (session.agentKey !== payload.toAgentKey) {
      return {status: "dropped", reason: "recipient_session_agent_mismatch"};
    }
    const duplicate = await context.a2aBindings.hasReceivedMessage({
      recipientSessionId: payload.toSessionId,
      senderSessionId: payload.fromSessionId,
      messageId: payload.externalMessageId,
    });
    if (duplicate) {
      return {status: "dropped", reason: "duplicate_message"};
    }

    const thread = await context.runtime.store.getThread(session.currentThreadId);
    const persistence = buildA2AInboundPersistence(payload);
    await context.runtime.coordinator.submitInput(thread.id, {
      source: A2A_SOURCE,
      channelId: payload.fromSessionId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.fromAgentKey,
      message: stringToUserMessage(buildA2AInboundText(payload)),
      metadata: persistence.metadata,
    });
    return {status: "queued", threadId: thread.id};
  };

  const handleTelegramReaction = async (
    payload: TelegramReactionRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const binding = await context.runtime.identityStore.resolveIdentityBinding({
      source: TELEGRAM_SOURCE,
      connectorKey: payload.connectorKey,
      externalActorId: payload.externalActorId,
    });
    if (!binding) {
      return {status: "dropped", reason: "unpaired_actor"};
    }

    const identity = await context.runtime.identityStore.getIdentity(binding.identityId);
    const syntheticExternalMessageId = `telegram-reaction:${payload.updateId}`;
    const text = buildTelegramReactionText({
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      externalMessageId: syntheticExternalMessageId,
      identityHandle: identity.handle,
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

    const thread = await threads.resolveOrCreateConversationThread({
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

    await context.runtime.coordinator.submitInput(thread.id, {
      source: TELEGRAM_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: syntheticExternalMessageId,
      actorId: payload.externalActorId,
      identityId: binding.identityId,
      message: stringToUserMessage(text),
      metadata: persistence.metadata,
    });
    await context.sessionRoutes.saveLastRoute({
      sessionId: thread.sessionId,
      identityId: binding.identityId,
      route: persistence.rememberedRoute,
    });
    return {status: "queued", threadId: thread.id};
  };

  const handleWhatsAppMessage = async (
    payload: WhatsAppMessageRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const binding = await context.runtime.identityStore.resolveIdentityBinding({
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

    const identity = await context.runtime.identityStore.getIdentity(binding.identityId);
    const thread = await threads.resolveOrCreateConversationThread({
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

    const media = await threads.relocateThreadMedia(thread, payload.media);
    const text = buildWhatsAppInboundText({
      connectorKey: payload.connectorKey,
      sentAt: payload.sentAt ? new Date(payload.sentAt).toISOString() : undefined,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      externalMessageId: payload.externalMessageId,
      identityHandle: identity.handle,
      remoteJid: payload.remoteJid,
      chatType: payload.chatType,
      text: payload.text,
      pushName: payload.pushName,
      quotedMessageId: payload.quotedMessageId,
      media,
    });

    await context.runtime.coordinator.submitInput(thread.id, {
      source: WHATSAPP_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      identityId: binding.identityId,
      message: stringToUserMessage(text),
      metadata: buildWhatsAppInboundMetadata({
        connectorKey: payload.connectorKey,
        sentAt: payload.sentAt ? new Date(payload.sentAt).toISOString() : undefined,
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
    await context.sessionRoutes.saveLastRoute({
      sessionId: thread.sessionId,
      identityId: binding.identityId,
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

  const handleTuiInput = async (
    payload: TuiInputRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const thread = payload.threadId
      ? await context.runtime.store.getThread(payload.threadId)
      : await threads.openMainSession({
        identityId: requireIdentityId(payload.identityId, "tui_input"),
      });
    const sentAt = payload.sentAt ? new Date(payload.sentAt).toISOString() : undefined;
    const persistence = buildTuiInboundPersistence({
      sentAt,
      actorId: payload.actorId,
      externalMessageId: payload.externalMessageId,
    });
    await context.runtime.coordinator.submitInput(thread.id, {
      message: stringToUserMessage(buildTuiInboundText({
        actorId: payload.actorId,
        externalMessageId: payload.externalMessageId,
        identityHandle: payload.identityHandle,
        sentAt,
        body: payload.text,
      })),
      source: TUI_SOURCE,
      channelId: "terminal",
      externalMessageId: payload.externalMessageId,
      actorId: payload.actorId,
      identityId: payload.identityId,
      metadata: persistence.metadata,
    });
    await context.sessionRoutes.saveLastRoute({
      sessionId: thread.sessionId,
      identityId: requireIdentityId(payload.identityId, "tui_input"),
      route: persistence.rememberedRoute,
    });
    return {status: "queued", threadId: thread.id};
  };

  const handleCreateBranchSession = async (
    payload: CreateBranchSessionRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const identity = await threads.ensureIdentity(requireIdentityId(payload.identityId, "create_branch_session"));
    const thread = await threads.createBranchSession({
      identity,
      sessionId: payload.sessionId,
      agentKey: payload.agentKey,
      model: payload.model,
      thinking: payload.thinking,
      inferenceProjection: payload.inferenceProjection,
    });
    return {threadId: thread.id};
  };

  const handleAbortThread = async (
    payload: AbortThreadRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const aborted = await context.runtime.coordinator.abort(payload.threadId, payload.reason);
    return {aborted};
  };

  const handleCompactThread = async (
    payload: CompactThreadRequestPayload,
  ): Promise<Record<string, unknown>> => {
      const compacted = await context.runtime.coordinator.runExclusively(payload.threadId, async () => {
        const thread = await context.runtime.store.getThread(payload.threadId);
        const runConfig = await context.runtime.coordinator.resolveThreadRunConfig(thread);
        const modelName = runConfig.model;
        const apiKeyMessage = readMissingApiKeyMessageForModel(modelName);
        if (apiKeyMessage) {
          throw new Error(apiKeyMessage);
        }

        if (await context.runtime.store.hasRunnableInputs(payload.threadId)) {
          throw new Error(buildQueuedInputCompactionMessage());
        }

      return compactThread({
        store: context.runtime.store,
        thread,
        model: modelName,
        thinking: runConfig.thinking,
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

  const handleResolveThreadRunConfig = async (
    payload: ResolveThreadRunConfigRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const config = await context.runtime.coordinator.resolveThreadRunConfig(payload.threadId);
    return {
      model: config.model,
      thinking: config.thinking ?? null,
    };
  };

  const handleUpdateThread = async (
    payload: UpdateThreadRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const thread = await context.runtime.store.updateThread(payload.threadId, payload.update);
    return {threadId: thread.id};
  };

  return async (request: RuntimeRequestRecord): Promise<unknown> => {
    switch (request.kind) {
      case "a2a_message":
        return handleA2AMessage(request.payload as A2AMessageRequestPayload);
      case "telegram_message":
        return handleTelegramMessage(request.payload as TelegramMessageRequestPayload);
      case "telegram_reaction":
        return handleTelegramReaction(request.payload as TelegramReactionRequestPayload);
      case "whatsapp_message":
        return handleWhatsAppMessage(request.payload as WhatsAppMessageRequestPayload);
      case "tui_input":
        return handleTuiInput(request.payload as TuiInputRequestPayload);
      case "create_branch_session":
        return handleCreateBranchSession(request.payload as CreateBranchSessionRequestPayload);
      case "resolve_main_session_thread": {
        const thread = await threads.openMainSession(
          request.payload as ResolveMainSessionThreadRequestPayload,
        );
        return {threadId: thread.id};
      }
      case "resolve_thread_run_config":
        return handleResolveThreadRunConfig(request.payload as ResolveThreadRunConfigRequestPayload);
      case "reset_session":
        return threads.handleResetSession(request.payload as ResetSessionRequestPayload);
      case "abort_thread":
        return handleAbortThread(request.payload as AbortThreadRequestPayload);
      case "compact_thread":
        return handleCompactThread(request.payload as CompactThreadRequestPayload);
      case "update_thread":
        return handleUpdateThread(request.payload as UpdateThreadRequestPayload);
      default:
        throw new Error(buildUnsupportedRuntimeRequestMessage((request as {kind: string}).kind));
    }
  };
}
