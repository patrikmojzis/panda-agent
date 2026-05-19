import type {MediaDescriptor, RememberedRoute} from "../../../domain/channels/types.js";
import type {IdentityStore} from "../../../domain/identity/store.js";
import type {SessionRouteRepo} from "../../../domain/sessions/routes/repo.js";
import type {SessionStore} from "../../../domain/sessions/store.js";
import type {DiscordAttachmentSummary, DiscordMessageRequestPayload} from "../../../domain/threads/requests/types.js";
import type {ThreadRuntimeCoordinator} from "../../../domain/threads/runtime/coordinator.js";
import type {ThreadRecord} from "../../../domain/threads/runtime/types.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import type {JsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import {trimToUndefined} from "../../../lib/strings.js";
import {renderDiscordInboundText} from "../../../prompts/channels/discord.js";
import {submitRememberedChannelInput} from "../inbound-delivery.js";
import {describeMediaDescriptor, serializeMediaDescriptor} from "../media-shared.js";
import {DISCORD_SOURCE} from "./config.js";

interface DiscordBoundThreadResolver {
  relocateThreadMedia(
    thread: ThreadRecord,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]>;
  resolveBoundConversationThread(input: {
    source: string;
    connectorKey: string;
    externalConversationId: string;
  }): Promise<ThreadRecord | null>;
}

interface DiscordMessageRequestHandlerOptions {
  coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
  identityStore: Pick<IdentityStore, "getIdentity" | "resolveIdentityBinding">;
  routes: Pick<SessionRouteRepo, "saveLastRoute">;
  sessions: Pick<SessionStore, "getSession">;
  threads: DiscordBoundThreadResolver;
}

function readContextString(record: Record<string, unknown>, field: string): string | undefined {
  return trimToUndefined(record[field]);
}

function buildDiscordDeliveryContext(payload: DiscordMessageRequestPayload): JsonObject {
  const providedDiscord = isRecord(payload.deliveryContext?.discord)
    ? payload.deliveryContext.discord
    : undefined;

  const channelId = readContextString(providedDiscord ?? {}, "channelId")
    ?? readContextString(providedDiscord ?? {}, "actualChannelId")
    ?? payload.actualChannelId;
  const parentChannelId = readContextString(providedDiscord ?? {}, "parentChannelId")
    ?? payload.parentChannelId
    ?? payload.externalConversationId;
  const threadId = readContextString(providedDiscord ?? {}, "threadId")
    ?? payload.threadId;
  const guildId = readContextString(providedDiscord ?? {}, "guildId")
    ?? payload.guildId;
  const messageId = readContextString(providedDiscord ?? {}, "messageId")
    ?? payload.externalMessageId;
  const referencedMessageId = readContextString(providedDiscord ?? {}, "referencedMessageId")
    ?? payload.replyToMessageId;
  const replyTargetMessageId = readContextString(providedDiscord ?? {}, "replyTargetMessageId");

  return {
    discord: {
      channelId,
      parentChannelId,
      ...(threadId !== undefined ? {threadId} : {}),
      ...(guildId !== undefined ? {guildId} : {}),
      messageId,
      ...(referencedMessageId !== undefined ? {referencedMessageId} : {}),
      ...(replyTargetMessageId !== undefined ? {replyTargetMessageId} : {}),
    },
  };
}

function buildRoute(payload: DiscordMessageRequestPayload): RememberedRoute {
  return {
    source: DISCORD_SOURCE,
    connectorKey: payload.connectorKey,
    externalConversationId: payload.externalConversationId,
    externalActorId: payload.externalActorId,
    externalMessageId: payload.externalMessageId,
    capturedAt: Date.now(),
  };
}

function formatSentAt(sentAt: number | undefined): string | undefined {
  if (sentAt === undefined) {
    return undefined;
  }

  const date = new Date(sentAt);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function serializeAttachmentSummary(summary: DiscordAttachmentSummary): JsonObject {
  return {
    id: summary.id,
    filename: summary.filename ?? null,
    contentType: summary.contentType ?? null,
    sizeBytes: summary.sizeBytes ?? null,
  };
}

function buildMetadata(
  payload: DiscordMessageRequestPayload,
  sentAt: string | undefined,
  deliveryContext: JsonObject,
  media: readonly MediaDescriptor[],
): JsonObject {
  return {
    route: {
      source: DISCORD_SOURCE,
      connectorKey: payload.connectorKey,
      externalConversationId: payload.externalConversationId,
      externalActorId: payload.externalActorId,
      externalMessageId: payload.externalMessageId,
      deliveryContext,
    },
    deliveryContext,
    discord: {
      sentAt: sentAt ?? null,
      guildId: payload.guildId ?? null,
      parentChannelId: payload.parentChannelId ?? payload.externalConversationId,
      actualChannelId: payload.actualChannelId,
      threadId: payload.threadId ?? null,
      replyToMessageId: payload.replyToMessageId ?? null,
      author: {
        id: payload.externalActorId,
        username: payload.authorUsername ?? null,
        globalName: payload.authorGlobalName ?? null,
        displayName: payload.authorDisplayName ?? null,
        isBot: payload.authorIsBot ?? null,
      },
      attachments: payload.attachmentSummaries.map(serializeAttachmentSummary),
      media: media.map((descriptor) => serializeMediaDescriptor(descriptor)),
    },
  };
}

export async function handleDiscordMessageRequest(
  payload: DiscordMessageRequestPayload,
  options: DiscordMessageRequestHandlerOptions,
): Promise<Record<string, unknown>> {
  const thread = await options.threads.resolveBoundConversationThread({
    source: DISCORD_SOURCE,
    connectorKey: payload.connectorKey,
    externalConversationId: payload.externalConversationId,
  });
  if (!thread) {
    return {status: "dropped", reason: "unbound_conversation"};
  }

  if (!(payload.text?.trim()) && payload.attachmentSummaries.length === 0 && payload.media.length === 0) {
    return {status: "dropped", reason: "unsupported_message_shape"};
  }

  const media = await options.threads.relocateThreadMedia(thread, payload.media);

  const actorBinding = await options.identityStore.resolveIdentityBinding({
    source: DISCORD_SOURCE,
    connectorKey: payload.connectorKey,
    externalActorId: payload.externalActorId,
  });
  const identity = actorBinding ? await options.identityStore.getIdentity(actorBinding.identityId) : undefined;
  const sentAt = formatSentAt(payload.sentAt);
  const deliveryContext = buildDiscordDeliveryContext(payload);
  const text = renderDiscordInboundText({
    connectorKey: payload.connectorKey,
    conversationId: payload.externalConversationId,
    actualChannelId: payload.actualChannelId,
    threadId: payload.threadId,
    guildId: payload.guildId,
    actorId: payload.externalActorId,
    externalMessageId: payload.externalMessageId,
    sentAt,
    identityHandle: identity?.handle,
    authorUsername: payload.authorUsername,
    authorGlobalName: payload.authorGlobalName,
    authorDisplayName: payload.authorDisplayName,
    authorIsBot: payload.authorIsBot,
    replyToMessageId: payload.replyToMessageId,
    attachments: payload.attachmentSummaries,
    media: media.map((descriptor) => describeMediaDescriptor(descriptor)),
    body: payload.text,
  });
  const identityId = actorBinding?.identityId;

  const target = await submitRememberedChannelInput({
    coordinator: options.coordinator,
    routes: options.routes,
    sessions: options.sessions,
    sessionId: thread.sessionId,
    ...(identityId !== undefined ? {identityId} : {}),
    route: buildRoute(payload),
    payload: {
      source: DISCORD_SOURCE,
      channelId: payload.externalConversationId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.externalActorId,
      ...(identityId !== undefined ? {identityId} : {}),
      message: stringToUserMessage(text),
      metadata: buildMetadata(payload, sentAt, deliveryContext, media),
    },
  });

  return {status: "queued", threadId: target.threadId};
}
