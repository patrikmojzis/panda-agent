import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {IdentityStore} from "../../../domain/identity/store.js";
import type {SessionRouteRepo} from "../../../domain/sessions/routes/repo.js";
import type {SessionStore} from "../../../domain/sessions/store.js";
import type {
  ResetSessionRequestPayload,
  ResetSessionResult,
  TelegramMessageRequestPayload,
  TelegramReactionRequestPayload,
} from "../../../domain/threads/requests/types.js";
import type {ThreadRuntimeCoordinator} from "../../../domain/threads/runtime/coordinator.js";
import type {ThreadRecord} from "../../../domain/threads/runtime/types.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {submitRememberedChannelInput} from "../inbound-delivery.js";
import {TELEGRAM_SOURCE} from "./config.js";
import {
  buildTelegramPairCommand,
  buildTelegramInboundPersistence,
  buildTelegramInboundText,
  buildTelegramReactionText,
  normalizeTelegramCommand,
} from "./helpers.js";

interface TelegramInboundThreadResolver {
  relocateThreadMedia(
    thread: ThreadRecord,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]>;
  resolveOrCreateConversationThread(input: {
    identityId: string;
    source: string;
    connectorKey: string;
    externalConversationId: string;
    context?: Record<string, unknown>;
  }): Promise<ThreadRecord | null>;
}

interface TelegramRuntimeMessageThreadResolver extends TelegramInboundThreadResolver {
  queueSystemReply(input: {
    channel: string;
    connectorKey: string;
    externalConversationId: string;
    externalActorId?: string;
    text: string;
    replyToMessageId?: string;
    threadId?: string;
  }): Promise<void>;
  handleResetSession(payload: ResetSessionRequestPayload): Promise<ResetSessionResult>;
}

interface TelegramInboundRequestHandlerOptions {
  coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
  identityStore: Pick<IdentityStore, "getIdentity" | "resolveIdentityBinding">;
  routes: Pick<SessionRouteRepo, "saveLastRoute">;
  sessions: Pick<SessionStore, "getSession">;
  threads: TelegramInboundThreadResolver;
}

interface TelegramRuntimeMessageRequestHandlerOptions extends Omit<TelegramInboundRequestHandlerOptions, "threads"> {
  threads: TelegramRuntimeMessageThreadResolver;
}

type TelegramConversationTarget = Pick<
  TelegramMessageRequestPayload,
  "chatId" | "connectorKey" | "externalConversationId"
>;

function buildTelegramStartText(
  actorId: string,
  defaultIdentityHandle = "<identity-handle>",
): string {
  return [
    "Pair this Telegram account with Panda by running:",
    buildTelegramPairCommand(actorId, defaultIdentityHandle),
    "",
    "Adjust the identity handle if you want a different Panda identity.",
  ].join("\n");
}

async function resolveTelegramConversationThread(
  payload: TelegramConversationTarget,
  identityId: string,
  threads: TelegramInboundThreadResolver,
): Promise<ThreadRecord | null> {
  return threads.resolveOrCreateConversationThread({
    identityId,
    source: TELEGRAM_SOURCE,
    connectorKey: payload.connectorKey,
    externalConversationId: payload.externalConversationId,
    context: {
      source: TELEGRAM_SOURCE,
      chatId: payload.chatId,
    },
  });
}

export async function handleTelegramMessageRequest(
  payload: TelegramMessageRequestPayload,
  identityId: string,
  options: TelegramInboundRequestHandlerOptions,
): Promise<Record<string, unknown>> {
  if (!(payload.text?.trim()) && payload.media.length === 0) {
    return {status: "dropped", reason: "unsupported_message_shape"};
  }

  const identity = await options.identityStore.getIdentity(identityId);
  const thread = await resolveTelegramConversationThread(payload, identityId, options.threads);
  if (!thread) {
    return {status: "dropped", reason: "conversation_identity_mismatch"};
  }

  const media = await options.threads.relocateThreadMedia(thread, payload.media);
  const sentAt = payload.sentAt ? new Date(payload.sentAt).toISOString() : undefined;
  const text = buildTelegramInboundText({
    connectorKey: payload.connectorKey,
    sentAt,
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
    sentAt,
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

  const target = await submitRememberedChannelInput({
    coordinator: options.coordinator,
    routes: options.routes,
    sessions: options.sessions,
    sessionId: thread.sessionId,
    identityId,
    route: persistence.rememberedRoute,
    payload: {
      source: TELEGRAM_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      identityId,
      message: stringToUserMessage(text),
      metadata: persistence.metadata,
    },
  });
  return {status: "queued", threadId: target.threadId};
}

export async function handleTelegramRuntimeMessageRequest(
  payload: TelegramMessageRequestPayload,
  options: TelegramRuntimeMessageRequestHandlerOptions,
): Promise<Record<string, unknown>> {
  const command = normalizeTelegramCommand(payload.text, payload.botUsername);
  const binding = await options.identityStore.resolveIdentityBinding({
    source: TELEGRAM_SOURCE,
    connectorKey: payload.connectorKey,
    externalActorId: payload.externalActorId,
  });

  if (command === "start" && !binding) {
    await options.threads.queueSystemReply({
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
    await options.threads.queueSystemReply({
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
    const result = await options.threads.handleResetSession({
      identityId: binding.identityId,
      source: TELEGRAM_SOURCE,
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      externalMessageId: payload.externalMessageId,
    });
    await options.threads.queueSystemReply({
      channel: TELEGRAM_SOURCE,
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      text: "Reset Panda. Fresh session started.",
      replyToMessageId: payload.externalMessageId,
      threadId: result.threadId,
    });
    return result;
  }

  return handleTelegramMessageRequest(payload, binding.identityId, options);
}

export async function handleTelegramReactionRequest(
  payload: TelegramReactionRequestPayload,
  options: TelegramInboundRequestHandlerOptions,
): Promise<Record<string, unknown>> {
  const binding = await options.identityStore.resolveIdentityBinding({
    source: TELEGRAM_SOURCE,
    connectorKey: payload.connectorKey,
    externalActorId: payload.externalActorId,
  });
  if (!binding) {
    return {status: "dropped", reason: "unpaired_actor"};
  }

  const identity = await options.identityStore.getIdentity(binding.identityId);
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

  const thread = await resolveTelegramConversationThread(payload, binding.identityId, options.threads);
  if (!thread) {
    return {status: "dropped", reason: "conversation_identity_mismatch"};
  }

  const target = await submitRememberedChannelInput({
    coordinator: options.coordinator,
    routes: options.routes,
    sessions: options.sessions,
    sessionId: thread.sessionId,
    identityId: binding.identityId,
    route: persistence.rememberedRoute,
    payload: {
      source: TELEGRAM_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: syntheticExternalMessageId,
      actorId: payload.externalActorId,
      identityId: binding.identityId,
      message: stringToUserMessage(text),
      metadata: persistence.metadata,
    },
  });
  return {status: "queued", threadId: target.threadId};
}
