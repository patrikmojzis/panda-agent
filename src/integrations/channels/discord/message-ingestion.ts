import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {DiscordMessageRequestPayload, DiscordAttachmentSummary} from "../../../domain/threads/requests/types.js";
import type {ConversationBinding, ConversationLookup} from "../../../domain/sessions/conversations/types.js";
import type {JsonObject} from "../../../lib/json.js";
import {firstNonEmptyString, requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {DISCORD_SOURCE} from "./config.js";
import type {DiscordAttachmentDownloadResult} from "./media.js";

export interface DiscordMessageAuthorPayload {
  id?: unknown;
  username?: unknown;
  global_name?: unknown;
  display_name?: unknown;
  bot?: unknown;
  [key: string]: unknown;
}

export interface DiscordMessageAttachmentPayload {
  id?: unknown;
  filename?: unknown;
  content_type?: unknown;
  contentType?: unknown;
  mime_type?: unknown;
  mimeType?: unknown;
  size?: unknown;
  size_bytes?: unknown;
  sizeBytes?: unknown;
  [key: string]: unknown;
}

export interface DiscordMessageCreatePayload {
  id?: unknown;
  channel_id?: unknown;
  guild_id?: unknown;
  author?: DiscordMessageAuthorPayload;
  content?: unknown;
  timestamp?: unknown;
  attachments?: unknown;
  message_reference?: unknown;
  [key: string]: unknown;
}

export interface DiscordMessageRouteEnvelope {
  source: typeof DISCORD_SOURCE;
  connectorKey: string;
  accountKey: string;
  externalConversationId: string;
  actualChannelId: string;
  threadId?: string;
  guildId?: string;
  externalMessageId: string;
}

export interface DiscordParentChannelResolution {
  parentChannelId: string;
  threadId?: string;
  guildId?: string;
}

export interface DiscordBoundMessage {
  binding: ConversationBinding;
  requestPayload: DiscordMessageRequestPayload;
  route: DiscordMessageRouteEnvelope;
}

export type DiscordBoundMessageHandler = (message: DiscordBoundMessage) => Promise<void> | void;

export interface DiscordConversationBindingReader {
  getConversationBinding(lookup: ConversationLookup): Promise<ConversationBinding | null>;
}

export interface IngestDiscordMessageCreateOptions {
  accountKey: string;
  connectorKey: string;
  conversationRepo: DiscordConversationBindingReader;
  downloadAttachments?: (attachments: unknown) => Promise<DiscordAttachmentDownloadResult>;
  log: (event: string, payload: Record<string, unknown>) => void;
  onBoundMessage: DiscordBoundMessageHandler;
  resolveParentChannelId(actualChannelId: string): Promise<DiscordParentChannelResolution | null>;
}

export type DiscordMessageIngestionResult =
  | {status: "ignored"; reason: "own_message"}
  | {status: "dropped"; reason: "invalid_message" | "unresolved_parent_channel" | "unbound_conversation" | "unsupported_message_shape"}
  | {status: "bound"; route: DiscordMessageRouteEnvelope; binding: ConversationBinding};

function readRequiredPayloadId(payload: DiscordMessageCreatePayload, field: "id" | "channel_id"): string {
  return requireNonEmptyString(payload[field], `Discord message ${field} must not be empty.`);
}

function readOptionalPayloadId(payload: DiscordMessageCreatePayload, field: "guild_id"): string | undefined {
  return trimToUndefined(payload[field]);
}

function readAuthorId(payload: DiscordMessageCreatePayload): string | undefined {
  const author = payload.author;
  if (typeof author !== "object" || author === null || Array.isArray(author)) {
    return undefined;
  }

  return trimToUndefined(author.id);
}

function readAuthorBoolean(author: DiscordMessageAuthorPayload, field: "bot"): boolean | undefined {
  return typeof author[field] === "boolean" ? author[field] : undefined;
}

function readMessageReferenceId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return trimToUndefined((value as {message_id?: unknown}).message_id);
}

function readSentAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const timestamp = trimToUndefined(value);
  if (!timestamp) {
    return undefined;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readAttachmentSummaries(value: unknown): readonly DiscordAttachmentSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const summaries: DiscordAttachmentSummary[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const attachment = entry as DiscordMessageAttachmentPayload;
    const id = trimToUndefined(attachment.id);
    if (!id) {
      continue;
    }

    const filename = trimToUndefined(attachment.filename);
    const contentType = firstNonEmptyString(
      attachment.content_type,
      attachment.contentType,
      attachment.mime_type,
      attachment.mimeType,
    );
    const size = [attachment.size, attachment.size_bytes, attachment.sizeBytes]
      .find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) as number | undefined;
    summaries.push({
      id,
      ...(filename !== undefined ? {filename} : {}),
      ...(contentType !== undefined ? {contentType} : {}),
      ...(size !== undefined ? {sizeBytes: size} : {}),
    });
  }

  return summaries;
}

function buildRoute(input: {
  accountKey: string;
  actualChannelId: string;
  connectorKey: string;
  externalMessageId: string;
  guildId?: string;
  resolution: DiscordParentChannelResolution;
}): DiscordMessageRouteEnvelope {
  const parentChannelId = requireNonEmptyString(
    input.resolution.parentChannelId,
    "Discord parent channel id must not be empty.",
  );
  const threadId = trimToUndefined(input.resolution.threadId);
  const guildId = input.guildId ?? trimToUndefined(input.resolution.guildId);

  return {
    source: DISCORD_SOURCE,
    connectorKey: input.connectorKey,
    accountKey: input.accountKey,
    externalConversationId: parentChannelId,
    actualChannelId: input.actualChannelId,
    ...(threadId !== undefined ? {threadId} : {}),
    ...(guildId !== undefined ? {guildId} : {}),
    externalMessageId: input.externalMessageId,
  };
}


function buildDeliveryContext(
  route: DiscordMessageRouteEnvelope,
  replyToMessageId: string | undefined,
): JsonObject {
  return {
    discord: {
      channelId: route.actualChannelId,
      parentChannelId: route.externalConversationId,
      ...(route.threadId !== undefined ? {threadId: route.threadId} : {}),
      ...(route.guildId !== undefined ? {guildId: route.guildId} : {}),
      messageId: route.externalMessageId,
      ...(replyToMessageId !== undefined ? {referencedMessageId: replyToMessageId} : {}),
    },
  };
}

function buildRequestPayload(input: {
  attachmentSummaries: readonly DiscordAttachmentSummary[];
  externalActorId: string;
  media: readonly MediaDescriptor[];
  payload: DiscordMessageCreatePayload;
  route: DiscordMessageRouteEnvelope;
}): DiscordMessageRequestPayload {
  const author = input.payload.author;
  const safeAuthor = typeof author === "object" && author !== null && !Array.isArray(author)
    ? author
    : undefined;
  const text = trimToUndefined(input.payload.content);
  const sentAt = readSentAt(input.payload.timestamp);
  const authorUsername = safeAuthor ? trimToUndefined(safeAuthor.username) : undefined;
  const authorGlobalName = safeAuthor ? trimToUndefined(safeAuthor.global_name) : undefined;
  const authorDisplayName = safeAuthor ? trimToUndefined(safeAuthor.display_name) : undefined;
  const authorIsBot = safeAuthor ? readAuthorBoolean(safeAuthor, "bot") : undefined;
  const replyToMessageId = readMessageReferenceId(input.payload.message_reference);

  return {
    connectorKey: input.route.connectorKey,
    externalConversationId: input.route.externalConversationId,
    externalActorId: input.externalActorId,
    externalMessageId: input.route.externalMessageId,
    actualChannelId: input.route.actualChannelId,
    attachmentSummaries: input.attachmentSummaries,
    media: input.media,
    ...(sentAt !== undefined ? {sentAt} : {}),
    ...(input.route.guildId !== undefined ? {guildId: input.route.guildId} : {}),
    ...(input.route.threadId !== undefined ? {threadId: input.route.threadId} : {}),
    parentChannelId: input.route.externalConversationId,
    ...(text !== undefined ? {text} : {}),
    ...(authorUsername !== undefined ? {authorUsername} : {}),
    ...(authorGlobalName !== undefined ? {authorGlobalName} : {}),
    ...(authorDisplayName !== undefined ? {authorDisplayName} : {}),
    ...(authorIsBot !== undefined ? {authorIsBot} : {}),
    ...(replyToMessageId !== undefined ? {replyToMessageId} : {}),
    deliveryContext: buildDeliveryContext(input.route, replyToMessageId),
  };
}

function logRouteDrop(
  log: IngestDiscordMessageCreateOptions["log"],
  event: string,
  route: DiscordMessageRouteEnvelope,
  reason: string,
): void {
  log(event, {
    reason,
    connectorKey: route.connectorKey,
    accountKey: route.accountKey,
    externalConversationId: route.externalConversationId,
    actualChannelId: route.actualChannelId,
    threadId: route.threadId ?? null,
    guildId: route.guildId ?? null,
    externalMessageId: route.externalMessageId,
  });
}

async function downloadBoundAttachments(
  attachments: unknown,
  attachmentSummaries: readonly DiscordAttachmentSummary[],
  route: DiscordMessageRouteEnvelope,
  options: IngestDiscordMessageCreateOptions,
): Promise<DiscordAttachmentDownloadResult> {
  if (!options.downloadAttachments || attachmentSummaries.length === 0) {
    return {media: [], unavailable: []};
  }

  try {
    return await options.downloadAttachments(attachments);
  } catch {
    logRouteDrop(options.log, "media_download_failed", route, "attachment_download_failed");
    return {media: [], unavailable: []};
  }
}

export function createDefaultDiscordBoundMessageHandler(
  log: (event: string, payload: Record<string, unknown>) => void,
): DiscordBoundMessageHandler {
  return (message) => {
    logRouteDrop(log, "message_preflight_bound", message.route, "bound_callback_not_configured");
  };
}

export async function ingestDiscordMessageCreate(
  payload: DiscordMessageCreatePayload,
  options: IngestDiscordMessageCreateOptions,
): Promise<DiscordMessageIngestionResult> {
  let externalMessageId: string;
  let actualChannelId: string;
  try {
    externalMessageId = readRequiredPayloadId(payload, "id");
    actualChannelId = readRequiredPayloadId(payload, "channel_id");
  } catch (error) {
    options.log("message_dropped", {
      reason: "invalid_message",
      connectorKey: options.connectorKey,
      accountKey: options.accountKey,
      message: error instanceof Error ? error.message : String(error),
    });
    return {status: "dropped", reason: "invalid_message"};
  }

  const externalActorId = readAuthorId(payload);
  if (externalActorId === options.connectorKey) {
    options.log("message_ignored", {
      reason: "own_message",
      connectorKey: options.connectorKey,
      accountKey: options.accountKey,
      actualChannelId,
      externalMessageId,
    });
    return {status: "ignored", reason: "own_message"};
  }

  if (!externalActorId) {
    options.log("message_dropped", {
      reason: "invalid_message",
      connectorKey: options.connectorKey,
      accountKey: options.accountKey,
      actualChannelId,
      externalMessageId,
    });
    return {status: "dropped", reason: "invalid_message"};
  }

  const resolution = await options.resolveParentChannelId(actualChannelId);
  if (!resolution) {
    options.log("message_dropped", {
      reason: "unresolved_parent_channel",
      connectorKey: options.connectorKey,
      accountKey: options.accountKey,
      actualChannelId,
      guildId: readOptionalPayloadId(payload, "guild_id") ?? null,
      externalMessageId,
    });
    return {status: "dropped", reason: "unresolved_parent_channel"};
  }

  const route = buildRoute({
    accountKey: options.accountKey,
    actualChannelId,
    connectorKey: options.connectorKey,
    externalMessageId,
    guildId: readOptionalPayloadId(payload, "guild_id"),
    resolution,
  });

  const binding = await options.conversationRepo.getConversationBinding({
    source: DISCORD_SOURCE,
    connectorKey: options.connectorKey,
    externalConversationId: route.externalConversationId,
  });
  if (!binding) {
    logRouteDrop(options.log, "message_dropped", route, "unbound_conversation");
    return {status: "dropped", reason: "unbound_conversation"};
  }

  const attachmentSummaries = readAttachmentSummaries(payload.attachments);
  const text = trimToUndefined(payload.content);
  if (!text && attachmentSummaries.length === 0) {
    logRouteDrop(options.log, "message_dropped", route, "unsupported_message_shape");
    return {status: "dropped", reason: "unsupported_message_shape"};
  }

  const mediaDownload = await downloadBoundAttachments(payload.attachments, attachmentSummaries, route, options);
  const requestPayload = buildRequestPayload({
    attachmentSummaries,
    externalActorId,
    media: mediaDownload.media,
    payload,
    route,
  });

  await options.onBoundMessage({
    binding,
    requestPayload,
    route,
  });

  return {
    status: "bound",
    route,
    binding,
  };
}
