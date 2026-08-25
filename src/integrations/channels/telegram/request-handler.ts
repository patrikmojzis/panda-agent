import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {IdentityStore} from "../../../domain/identity/store.js";
import type {
  ResetSessionRequestPayload,
  ResetSessionResult,
  TelegramMessageRequestPayload,
  TelegramReactionRequestPayload,
} from "../../../domain/threads/requests/types.js";
import type {ThreadRuntimeCoordinator} from "../../../domain/threads/runtime/coordinator.js";
import type {ThreadEnqueueOptions, ThreadRecord} from "../../../domain/threads/runtime/types.js";
import type {OutboundDeliveryRecord} from "../../../domain/channels/deliveries/types.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {RetryableRuntimeRequestError} from "../../../domain/threads/requests/errors.js";
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
  }): Promise<ThreadRecord | null>;
}

interface TelegramRuntimeMessageThreadResolver extends TelegramInboundThreadResolver {
  queueSystemReply(input: {
    idempotencyKey: string;
    channel: string;
    connectorKey: string;
    externalConversationId: string;
    externalActorId?: string;
    text: string;
    replyToMessageId?: string;
    threadId?: string;
  }): Promise<void>;
  findSystemReply(input: {
    idempotencyKey: string;
    channel: string;
    connectorKey: string;
    externalConversationId: string;
    externalActorId?: string;
    text: string;
    replyToMessageId?: string;
  }): Promise<OutboundDeliveryRecord | null>;
  handleResetSession(
    payload: ResetSessionRequestPayload,
    requestId: string,
    capturedAt: number,
    replayAttempt: boolean,
  ): Promise<ResetSessionResult>;
  reconcileResetSession(
    payload: ResetSessionRequestPayload,
    requestId: string,
    capturedAt: number,
  ): Promise<ResetSessionResult | null>;
}

interface TelegramInboundRequestHandlerOptions {
  capturedAt: number;
  coordinator: Pick<ThreadRuntimeCoordinator, "submitSessionInput">;
  enqueueOptions?: ThreadEnqueueOptions;
  identityStore: Pick<IdentityStore, "getIdentity" | "resolveIdentityBinding">;
  threads: TelegramInboundThreadResolver;
}

interface TelegramRuntimeMessageRequestHandlerOptions extends Omit<TelegramInboundRequestHandlerOptions, "threads"> {
  replayAttempt?: boolean;
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
    capturedAt: payload.sentAt ?? options.capturedAt,
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
    ...(options.enqueueOptions === undefined ? {} : {enqueueOptions: options.enqueueOptions}),
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
  const systemReplyIdempotencyKey = (): string => {
    const requestId = options.enqueueOptions?.inputId;
    if (!requestId) {
      throw new Error("Telegram control replies require the durable runtime request id.");
    }
    return `runtime-request:${requestId}:system-reply`;
  };
  const resetPayload = (identityId?: string): ResetSessionRequestPayload => ({
    ...(identityId ? {identityId} : {}),
    source: TELEGRAM_SOURCE,
    connectorKey: payload.connectorKey,
    externalConversationId: payload.externalConversationId,
    externalActorId: payload.externalActorId,
    externalMessageId: payload.externalMessageId,
  });
  const systemReply = (text: string) => ({
    idempotencyKey: systemReplyIdempotencyKey(),
    channel: TELEGRAM_SOURCE,
    connectorKey: payload.connectorKey,
    externalConversationId: payload.externalConversationId,
    externalActorId: payload.externalActorId,
    text,
    replyToMessageId: payload.externalMessageId,
  });
  const persistSystemReply = async (input: Parameters<typeof options.threads.queueSystemReply>[0]): Promise<void> => {
    try {
      await options.threads.queueSystemReply(input);
    } catch (error) {
      if (error instanceof RetryableRuntimeRequestError) throw error;
      throw new RetryableRuntimeRequestError(
        `Telegram control reply ${input.idempotencyKey} could not be reconciled after persistence failed.`,
        {cause: error},
      );
    }
  };
  const queueResetConfirmation = async (result: ResetSessionResult): Promise<ResetSessionResult> => {
    await persistSystemReply({
      ...systemReply("Reset Panda. Fresh session started."),
      threadId: result.threadId,
    });
    return result;
  };

  if (options.replayAttempt && command === "start") {
    const reply = await options.threads.findSystemReply(systemReply(buildTelegramStartText(payload.externalActorId)));
    if (reply) return {status: "replied", reason: "start_unpaired"};
  }
  if (options.replayAttempt && command === "new") {
    const reply = await options.threads.findSystemReply(systemReply("/new is TUI-only. Use /reset here to start fresh."));
    if (reply) return {status: "replied", reason: "new_is_tui_only"};
  }
  if (command === "reset" && options.replayAttempt) {
    const requestId = options.enqueueOptions?.inputId;
    if (!requestId) throw new Error("Telegram reset requires the durable runtime request id.");
    const confirmation = await options.threads.findSystemReply(systemReply("Reset Panda. Fresh session started."));
    const replay = await options.threads.reconcileResetSession(
      resetPayload(),
      requestId,
      payload.sentAt ?? options.capturedAt,
    );
    if (confirmation && !replay) {
      throw new Error(`Telegram reset ${requestId} has a confirmation without durable reset lineage.`);
    }
    if (replay) {
      if (confirmation?.threadId && confirmation.threadId !== replay.threadId) {
        throw new Error(`Telegram reset ${requestId} confirmation targets another thread.`);
      }
      return confirmation ? replay : queueResetConfirmation(replay);
    }
  }
  const binding = await options.identityStore.resolveIdentityBinding({
    source: TELEGRAM_SOURCE,
    connectorKey: payload.connectorKey,
    externalActorId: payload.externalActorId,
  });

  if (command === "start" && !binding) {
    await persistSystemReply(systemReply(buildTelegramStartText(payload.externalActorId)));
    return {status: "replied", reason: "start_unpaired"};
  }

  if (!binding) {
    return {status: "dropped", reason: "unpaired_actor"};
  }

  if (command === "new") {
    await persistSystemReply(systemReply("/new is TUI-only. Use /reset here to start fresh."));
    return {status: "replied", reason: "new_is_tui_only"};
  }

  if (command === "reset") {
    const requestId = options.enqueueOptions?.inputId;
    if (!requestId) {
      throw new Error("Telegram reset requires the durable runtime request id.");
    }
    const result = await options.threads.handleResetSession(
      resetPayload(binding.identityId),
      requestId,
      payload.sentAt ?? options.capturedAt,
      options.replayAttempt ?? false,
    );
    return queueResetConfirmation(result);
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
    capturedAt: options.capturedAt,
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
    ...(options.enqueueOptions === undefined ? {} : {enqueueOptions: options.enqueueOptions}),
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
