import type {MediaDescriptor, RememberedRoute} from "../../../domain/channels/types.js";
import type {IdentityStore} from "../../../domain/identity/store.js";
import type {SessionRouteRepo} from "../../../domain/sessions/routes/repo.js";
import type {SessionStore} from "../../../domain/sessions/store.js";
import type {
  WhatsAppMessageRequestPayload,
  WhatsAppReactionRequestPayload,
} from "../../../domain/threads/requests/types.js";
import type {ThreadRuntimeCoordinator} from "../../../domain/threads/runtime/coordinator.js";
import type {ThreadRecord} from "../../../domain/threads/runtime/types.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {submitRememberedChannelInput} from "../inbound-delivery.js";
import {WHATSAPP_SOURCE} from "./config.js";
import {
  buildWhatsAppInboundMetadata,
  buildWhatsAppInboundText,
  buildWhatsAppReactionMetadata,
  buildWhatsAppReactionText,
} from "./helpers.js";

interface WhatsAppInboundThreadResolver {
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

interface WhatsAppInboundRequestHandlerOptions {
  coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
  identityStore: Pick<IdentityStore, "getIdentity" | "resolveIdentityBinding">;
  routes: Pick<SessionRouteRepo, "saveLastRoute">;
  sessions: Pick<SessionStore, "getSession">;
  threads: WhatsAppInboundThreadResolver;
}

function buildRoute(input: {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
}): RememberedRoute {
  return {
    source: WHATSAPP_SOURCE,
    connectorKey: input.connectorKey,
    externalConversationId: input.externalConversationId,
    externalActorId: input.externalActorId,
    externalMessageId: input.externalMessageId,
    capturedAt: Date.now(),
  };
}

async function resolveWhatsAppConversationThread(
  payload: Pick<WhatsAppMessageRequestPayload, "connectorKey" | "externalConversationId" | "remoteJid">,
  identityId: string,
  threads: WhatsAppInboundThreadResolver,
): Promise<ThreadRecord | null> {
  return threads.resolveOrCreateConversationThread({
    identityId,
    source: WHATSAPP_SOURCE,
    connectorKey: payload.connectorKey,
    externalConversationId: payload.externalConversationId,
  });
}

export async function handleWhatsAppMessageRequest(
  payload: WhatsAppMessageRequestPayload,
  options: WhatsAppInboundRequestHandlerOptions,
): Promise<Record<string, unknown>> {
  const binding = await options.identityStore.resolveIdentityBinding({
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

  const identity = await options.identityStore.getIdentity(binding.identityId);
  const thread = await resolveWhatsAppConversationThread(payload, binding.identityId, options.threads);
  if (!thread) {
    return {status: "dropped", reason: "conversation_identity_mismatch"};
  }

  const media = await options.threads.relocateThreadMedia(thread, payload.media);
  const sentAt = payload.sentAt ? new Date(payload.sentAt).toISOString() : undefined;
  const text = buildWhatsAppInboundText({
    connectorKey: payload.connectorKey,
    sentAt,
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

  const target = await submitRememberedChannelInput({
    coordinator: options.coordinator,
    routes: options.routes,
    sessions: options.sessions,
    sessionId: thread.sessionId,
    identityId: binding.identityId,
    route: buildRoute(payload),
    payload: {
      source: WHATSAPP_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      identityId: binding.identityId,
      message: stringToUserMessage(text),
      metadata: buildWhatsAppInboundMetadata({
        connectorKey: payload.connectorKey,
        sentAt,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        externalMessageId: payload.externalMessageId,
        remoteJid: payload.remoteJid,
        chatType: payload.chatType,
        pushName: payload.pushName,
        quotedMessageId: payload.quotedMessageId,
        media,
      }),
    },
  });
  return {status: "queued", threadId: target.threadId};
}

export async function handleWhatsAppReactionRequest(
  payload: WhatsAppReactionRequestPayload,
  options: WhatsAppInboundRequestHandlerOptions,
): Promise<Record<string, unknown>> {
  const binding = await options.identityStore.resolveIdentityBinding({
    source: WHATSAPP_SOURCE,
    connectorKey: payload.connectorKey,
    externalActorId: payload.externalActorId,
  });
  if (!binding) {
    return {status: "dropped", reason: "unpaired_actor"};
  }

  const identity = await options.identityStore.getIdentity(binding.identityId);
  const thread = await resolveWhatsAppConversationThread(payload, binding.identityId, options.threads);
  if (!thread) {
    return {status: "dropped", reason: "conversation_identity_mismatch"};
  }

  const sentAt = payload.sentAt ? new Date(payload.sentAt).toISOString() : undefined;
  const text = buildWhatsAppReactionText({
    connectorKey: payload.connectorKey,
    sentAt,
    externalConversationId: payload.externalConversationId,
    externalActorId: payload.externalActorId,
    externalMessageId: payload.externalMessageId,
    identityHandle: identity.handle,
    remoteJid: payload.remoteJid,
    chatType: payload.chatType,
    pushName: payload.pushName,
    targetMessageId: payload.targetMessageId,
    emoji: payload.emoji,
  });

  const target = await submitRememberedChannelInput({
    coordinator: options.coordinator,
    routes: options.routes,
    sessions: options.sessions,
    sessionId: thread.sessionId,
    identityId: binding.identityId,
    route: buildRoute(payload),
    payload: {
      source: WHATSAPP_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      identityId: binding.identityId,
      message: stringToUserMessage(text),
      metadata: buildWhatsAppReactionMetadata({
        connectorKey: payload.connectorKey,
        sentAt,
        externalConversationId: payload.externalConversationId,
        externalActorId: payload.externalActorId,
        externalMessageId: payload.externalMessageId,
        remoteJid: payload.remoteJid,
        chatType: payload.chatType,
        pushName: payload.pushName,
        targetMessageId: payload.targetMessageId,
        emoji: payload.emoji,
      }),
    },
  });
  return {status: "queued", threadId: target.threadId};
}
