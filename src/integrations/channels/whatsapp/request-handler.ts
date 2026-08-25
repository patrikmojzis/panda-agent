import type {MediaDescriptor, RememberedRoute} from "../../../domain/channels/types.js";
import type {
  WhatsAppMessageRequestPayload,
  WhatsAppReactionRequestPayload,
} from "../../../domain/threads/requests/types.js";
import type {ThreadRuntimeCoordinator} from "../../../domain/threads/runtime/coordinator.js";
import type {ThreadEnqueueOptions, ThreadRecord} from "../../../domain/threads/runtime/types.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {submitRememberedChannelInput} from "../inbound-delivery.js";
import {WHATSAPP_SOURCE} from "./config.js";
import type {AuthorizedWhatsAppActor, WhatsAppActorAuthorizer} from "./authorization.js";
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
    authorizedAgentKey: string;
    authorizedActorBindingId: string;
    source: string;
    connectorKey: string;
    externalConversationId: string;
  }): Promise<ThreadRecord | null>;
}

interface WhatsAppInboundRequestHandlerOptions {
  capturedAt: number;
  coordinator: Pick<ThreadRuntimeCoordinator, "submitSessionInput">;
  enqueueOptions?: ThreadEnqueueOptions;
  authorizer: WhatsAppActorAuthorizer;
  threads: WhatsAppInboundThreadResolver;
}

function buildRoute(input: {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
}, capturedAt: number): RememberedRoute {
  return {
    source: WHATSAPP_SOURCE,
    connectorKey: input.connectorKey,
    externalConversationId: input.externalConversationId,
    externalActorId: input.externalActorId,
    externalMessageId: input.externalMessageId,
    capturedAt,
  };
}

async function resolveWhatsAppConversationThread(
  payload: Pick<WhatsAppMessageRequestPayload, "connectorKey" | "externalConversationId" | "remoteJid">,
  authorization: AuthorizedWhatsAppActor,
  threads: WhatsAppInboundThreadResolver,
): Promise<ThreadRecord | null> {
  return threads.resolveOrCreateConversationThread({
    identityId: authorization.identityId,
    authorizedAgentKey: authorization.agentKey,
    authorizedActorBindingId: authorization.actorBindingId,
    source: WHATSAPP_SOURCE,
    connectorKey: payload.connectorKey,
    externalConversationId: payload.externalConversationId,
  });
}

async function reauthorizeWhatsAppPayload(
  payload: Pick<WhatsAppMessageRequestPayload, "authorization" | "connectorKey" | "externalActorId">,
  authorizer: WhatsAppActorAuthorizer,
): Promise<AuthorizedWhatsAppActor | null> {
  if (!payload.authorization) return null;
  const current = await authorizer.authorizeActor({
    connectorKey: payload.connectorKey,
    externalActorId: payload.externalActorId,
  });
  if (!current.authorized) return null;
  const admitted = payload.authorization;
  if (
    current.identityId !== admitted.identityId
    || current.agentKey !== admitted.agentKey
    || current.actorBindingId !== admitted.actorBindingId
    || current.authorizationVersion !== admitted.authorizationVersion
  ) return null;
  return current;
}

export async function handleWhatsAppMessageRequest(
  payload: WhatsAppMessageRequestPayload,
  options: WhatsAppInboundRequestHandlerOptions,
): Promise<Record<string, unknown>> {
  const authorization = await reauthorizeWhatsAppPayload(payload, options.authorizer);
  if (!authorization) return {status: "dropped", reason: "authorization_revoked"};

  if (!(payload.text?.trim()) && payload.media.length === 0) {
    return {status: "dropped", reason: "unsupported_message_shape"};
  }

  const thread = await resolveWhatsAppConversationThread(payload, authorization, options.threads);
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
    identityHandle: authorization.identityHandle,
    remoteJid: payload.remoteJid,
    chatType: payload.chatType,
    text: payload.text,
    pushName: payload.pushName,
    quotedMessageId: payload.quotedMessageId,
    media,
  });

  const target = await submitRememberedChannelInput({
    coordinator: options.coordinator,
    ...(options.enqueueOptions === undefined ? {} : {enqueueOptions: options.enqueueOptions}),
    sessionId: thread.sessionId,
    identityId: authorization.identityId,
    route: buildRoute(payload, payload.sentAt ?? options.capturedAt),
    payload: {
      source: WHATSAPP_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      identityId: authorization.identityId,
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
  const authorization = await reauthorizeWhatsAppPayload(payload, options.authorizer);
  if (!authorization) return {status: "dropped", reason: "authorization_revoked"};
  const thread = await resolveWhatsAppConversationThread(payload, authorization, options.threads);
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
    identityHandle: authorization.identityHandle,
    remoteJid: payload.remoteJid,
    chatType: payload.chatType,
    pushName: payload.pushName,
    targetMessageId: payload.targetMessageId,
    emoji: payload.emoji,
  });

  const target = await submitRememberedChannelInput({
    coordinator: options.coordinator,
    ...(options.enqueueOptions === undefined ? {} : {enqueueOptions: options.enqueueOptions}),
    sessionId: thread.sessionId,
    identityId: authorization.identityId,
    route: buildRoute(payload, payload.sentAt ?? options.capturedAt),
    payload: {
      source: WHATSAPP_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      identityId: authorization.identityId,
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
