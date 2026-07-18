import {readFile} from "node:fs/promises";
import path from "node:path";

import type {ChannelOutboundAdapter} from "../../../domain/channels/outbound.js";
import type {
  OutboundFileItem,
  OutboundImageItem,
  OutboundItem,
  OutboundRequest,
  OutboundResult,
  OutboundSentItem,
  OutboundTarget,
  OutboundTextItem,
} from "../../../domain/channels/types.js";
import {isJsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import {optionalTrimmedString, requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import type {
  DiscordCreateMessageBody,
  DiscordCreateMessageFile,
  DiscordMessageReferenceBody,
  DiscordWorkerRestClient,
} from "./api.js";
import {
  DISCORD_MESSAGE_CONTENT_LIMIT,
  DISCORD_SOURCE,
} from "./config.js";

export interface DiscordOutboundAdapterOptions {
  botToken: string;
  client: Pick<DiscordWorkerRestClient, "createMessage">;
  connectorKey: string;
}

interface DiscordDeliveryContext {
  channelId?: string;
  parentChannelId?: string;
  threadId?: string;
  guildId?: string;
  replyTargetMessageId?: string;
}

interface DiscordSendTarget {
  channelId: string;
  guildId?: string;
  replyToMessageId?: string;
}

type NormalizedDiscordOutboundItem = {
  type: OutboundSentItem["type"];
  content?: string;
  files?: readonly [DiscordCreateMessageFile];
};

function buildSecretRedactionFragments(secret: string): readonly string[] {
  const exact = secret.trim();
  if (!exact) {
    return [];
  }

  const pieces = exact
    .split(/[^A-Za-z0-9]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 8);
  return [...new Set([exact, ...pieces])];
}

function sanitizeSecretMessage(message: string, secret: string): string {
  let sanitized = message;
  for (const fragment of buildSecretRedactionFragments(secret)) {
    sanitized = sanitized.split(fragment).join("[redacted]");
  }

  return sanitized;
}

function sanitizeSecretError(error: unknown, secret: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(sanitizeSecretMessage(message, secret));
}

function assertDiscordRoute(request: OutboundRequest, connectorKey: string): void {
  if (request.channel !== DISCORD_SOURCE) {
    throw new Error("Discord outbound can only send channel discord.");
  }
  if (request.target.source !== DISCORD_SOURCE) {
    throw new Error("Discord outbound target source must be discord.");
  }
  if (request.target.connectorKey !== connectorKey) {
    throw new Error("Discord outbound target connector key does not match the running connector.");
  }
  requireNonEmptyString(
    request.target.externalConversationId,
    "Discord outbound target conversation id must not be empty.",
  );
}

function readOptionalContextString(record: Record<string, unknown>, field: string): string | undefined {
  return optionalTrimmedString(
    record[field],
    `Discord delivery context ${field} must be a string.`,
  );
}

function parseDiscordDeliveryContext(target: OutboundTarget): DiscordDeliveryContext | undefined {
  const deliveryContext = target.deliveryContext;
  if (deliveryContext === undefined || deliveryContext === null) {
    return undefined;
  }
  if (!isJsonObject(deliveryContext)) {
    throw new Error("Discord delivery context must be a JSON object.");
  }
  if (!Object.hasOwn(deliveryContext, "discord")) {
    return undefined;
  }
  if (!isRecord(deliveryContext.discord)) {
    throw new Error("Discord delivery context discord must be a JSON object.");
  }

  return {
    channelId: readOptionalContextString(deliveryContext.discord, "channelId"),
    parentChannelId: readOptionalContextString(deliveryContext.discord, "parentChannelId"),
    threadId: readOptionalContextString(deliveryContext.discord, "threadId"),
    guildId: readOptionalContextString(deliveryContext.discord, "guildId"),
    replyTargetMessageId: readOptionalContextString(deliveryContext.discord, "replyTargetMessageId"),
  };
}

function resolveDiscordSendTarget(request: OutboundRequest): DiscordSendTarget {
  const context = parseDiscordDeliveryContext(request.target);
  const parentChannelId = request.target.externalConversationId;
  const replyToMessageId = trimToUndefined(request.target.replyToMessageId)
    ?? context?.replyTargetMessageId;

  if (!context) {
    return {
      channelId: parentChannelId,
      ...(replyToMessageId !== undefined ? {replyToMessageId} : {}),
    };
  }

  if (context.parentChannelId && context.parentChannelId !== parentChannelId) {
    throw new Error("Discord delivery context parent channel does not match the outbound target conversation.");
  }

  if (context.threadId) {
    if (context.channelId && context.channelId !== context.threadId) {
      throw new Error("Discord delivery context thread id does not match channel id.");
    }

    return {
      channelId: context.threadId,
      ...(context.guildId !== undefined ? {guildId: context.guildId} : {}),
      ...(replyToMessageId !== undefined ? {replyToMessageId} : {}),
    };
  }

  if (context.channelId) {
    if (context.channelId !== parentChannelId) {
      throw new Error("Discord delivery context channel id does not match the outbound target conversation.");
    }

    return {
      channelId: context.channelId,
      ...(context.guildId !== undefined ? {guildId: context.guildId} : {}),
      ...(replyToMessageId !== undefined ? {replyToMessageId} : {}),
    };
  }

  return {
    channelId: parentChannelId,
    ...(context.guildId !== undefined ? {guildId: context.guildId} : {}),
    ...(replyToMessageId !== undefined ? {replyToMessageId} : {}),
  };
}

function assertDiscordContentLimit(content: string, label: string): void {
  if (content.length > DISCORD_MESSAGE_CONTENT_LIMIT) {
    throw new Error(`Discord outbound ${label} must be at most ${DISCORD_MESSAGE_CONTENT_LIMIT} characters.`);
  }
}

function normalizeTextItem(item: OutboundTextItem): NormalizedDiscordOutboundItem {
  const text = requireNonEmptyString(item.text, "Discord outbound text must not be empty.");
  assertDiscordContentLimit(text, "text");

  return {
    type: "text",
    content: text,
  };
}

function normalizeCaption(caption: string | undefined): string | undefined {
  const normalized = trimToUndefined(caption);
  if (normalized === undefined) {
    return undefined;
  }

  assertDiscordContentLimit(normalized, "caption");
  return normalized;
}

async function buildImageFile(item: OutboundImageItem): Promise<DiscordCreateMessageFile> {
  const filePath = requireNonEmptyString(item.path, "Discord outbound image path must not be empty.");
  return {
    filename: requireNonEmptyString(path.basename(filePath), "Discord outbound image filename must not be empty."),
    bytes: await readFile(filePath),
  };
}

async function buildDocumentFile(item: OutboundFileItem): Promise<DiscordCreateMessageFile> {
  if (!("path" in item)) {
    throw new Error("Discord outbound does not accept command upload references.");
  }
  const filePath = requireNonEmptyString(item.path, "Discord outbound file path must not be empty.");
  return {
    filename: requireNonEmptyString(
      item.filename?.trim() || path.basename(filePath),
      "Discord outbound file filename must not be empty.",
    ),
    bytes: await readFile(filePath),
    mimeType: trimToUndefined(item.mimeType) ?? "application/octet-stream",
  };
}

async function normalizeImageItem(item: OutboundImageItem): Promise<NormalizedDiscordOutboundItem> {
  const content = normalizeCaption(item.caption);
  return {
    type: "image",
    ...(content !== undefined ? {content} : {}),
    files: [await buildImageFile(item)],
  };
}

async function normalizeFileItem(item: OutboundFileItem): Promise<NormalizedDiscordOutboundItem> {
  const content = normalizeCaption(item.caption);
  return {
    type: "file",
    ...(content !== undefined ? {content} : {}),
    files: [await buildDocumentFile(item)],
  };
}

async function normalizeDiscordItems(items: readonly OutboundItem[]): Promise<readonly NormalizedDiscordOutboundItem[]> {
  const normalized: NormalizedDiscordOutboundItem[] = [];

  for (const item of items) {
    switch (item.type) {
      case "text":
        normalized.push(normalizeTextItem(item));
        break;
      case "image":
        normalized.push(await normalizeImageItem(item));
        break;
      case "file":
        normalized.push(await normalizeFileItem(item));
        break;
      default:
        throw new Error(`Unsupported Discord outbound item type ${(item as {type?: string}).type ?? "unknown"}.`);
    }
  }

  return normalized;
}

function buildMessageReference(target: DiscordSendTarget): DiscordMessageReferenceBody | undefined {
  if (!target.replyToMessageId) {
    return undefined;
  }

  return {
    message_id: target.replyToMessageId,
    channel_id: target.channelId,
    ...(target.guildId !== undefined ? {guild_id: target.guildId} : {}),
    fail_if_not_exists: false,
  };
}

function buildDiscordMessageBody(
  item: NormalizedDiscordOutboundItem,
  messageReference?: DiscordMessageReferenceBody,
): DiscordCreateMessageBody {
  return {
    ...(item.content !== undefined ? {content: item.content} : {}),
    allowed_mentions: {
      parse: [],
    },
    ...(messageReference !== undefined ? {message_reference: messageReference} : {}),
  };
}

function sentItem(type: OutboundSentItem["type"], externalMessageId: string): OutboundSentItem {
  return {
    type,
    externalMessageId,
  };
}

export function createDiscordOutboundAdapter(options: DiscordOutboundAdapterOptions): ChannelOutboundAdapter {
  const botToken = requireNonEmptyString(options.botToken, "Discord bot token must not be empty.");
  const connectorKey = requireNonEmptyString(options.connectorKey, "Discord connector key must not be empty.");

  return {
    channel: DISCORD_SOURCE,
    async send(request: OutboundRequest): Promise<OutboundResult> {
      assertDiscordRoute(request, connectorKey);
      const sendTarget = resolveDiscordSendTarget(request);
      const items = await normalizeDiscordItems(request.items);
      const sent: OutboundSentItem[] = [];

      for (const [index, item] of items.entries()) {
        try {
          const messageReference = index === 0 ? buildMessageReference(sendTarget) : undefined;
          const body = buildDiscordMessageBody(item, messageReference);
          const message = item.files
            ? await options.client.createMessage(botToken, sendTarget.channelId, body, item.files)
            : await options.client.createMessage(botToken, sendTarget.channelId, body);
          sent.push(sentItem(item.type, message.id));
        } catch (error) {
          throw sanitizeSecretError(error, botToken);
        }
      }

      return {
        ok: true,
        channel: DISCORD_SOURCE,
        target: request.target,
        sent,
      };
    },
  };
}
