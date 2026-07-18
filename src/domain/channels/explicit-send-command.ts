import type {JsonObject, JsonValue} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {assertPathReadable} from "../../lib/fs.js";
import {isRecord} from "../../lib/records.js";
import type {CommandFileResolver} from "../commands/files.js";
import type {CommandDescriptor, CommandName, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import {assertCurrentSessionConversationBinding, type ConversationBindingAuthorizer} from "./conversation-authority.js";
import type {OutboundDeliveryInput} from "./deliveries/types.js";
import type {OutboundFileItem, OutboundImageItem, OutboundItem} from "./types.js";

const DEFAULT_MAX_ITEMS = 10;

export interface ExplicitChannelSendCommandQueue {
  enqueueDelivery(input: OutboundDeliveryInput): Promise<{
    id: string;
    channel: string;
  }>;
}

export interface ExplicitChannelSendCommandServices extends ExplicitChannelSendCommandQueue, ConversationBindingAuthorizer {}

export interface ExplicitChannelSendCommandOptions {
  commandName: CommandName;
  channel: string;
  allowDeliveryContext?: boolean;
  allowReplyToMessageId?: boolean;
  maxItems?: number;
  normalizeConversationId?: (value: string) => string;
}

interface ExplicitChannelSendInput {
  connectorKey: string;
  conversationId: string;
  deliveryContext?: JsonObject;
  replyToMessageId?: string;
  items: readonly OutboundItem[];
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return readRequiredString(value, label);
}

function rejectUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported field ${unexpected[0]}.`);
  }
}

function parseOutboundItem(value: unknown, label: string): OutboundItem {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  switch (value.type) {
    case "text":
      rejectUnexpectedKeys(value, ["type", "text"], label);
      return {
        type: "text",
        text: readRequiredString(value.text, `${label}.text`),
      };
    case "image": {
      rejectUnexpectedKeys(value, ["type", "path", "caption"], label);
      const caption = readOptionalString(value.caption, `${label}.caption`);
      return {
        type: "image",
        path: readRequiredString(value.path, `${label}.path`),
        ...(caption ? {caption} : {}),
      };
    }
    case "file": {
      rejectUnexpectedKeys(value, ["type", "path", "filename", "caption", "mimeType"], label);
      const filename = readOptionalString(value.filename, `${label}.filename`);
      const caption = readOptionalString(value.caption, `${label}.caption`);
      const mimeType = readOptionalString(value.mimeType, `${label}.mimeType`);
      return {
        type: "file",
        path: readRequiredString(value.path, `${label}.path`),
        ...(filename ? {filename} : {}),
        ...(caption ? {caption} : {}),
        ...(mimeType ? {mimeType} : {}),
      };
    }
    default:
      throw new Error(`${label}.type must be text, image, or file.`);
  }
}

function parseDeliveryContext(value: unknown, label: string): JsonObject | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function parseExplicitChannelSendInput(input: unknown, options: ExplicitChannelSendCommandOptions): ExplicitChannelSendInput {
  if (!isRecord(input)) {
    throw new Error(`${options.commandName} input must be a JSON object.`);
  }

  const allowed = [
    "connectorKey",
    "conversationId",
    "items",
    ...(options.allowReplyToMessageId === true ? ["replyToMessageId"] : []),
    ...(options.allowDeliveryContext === true ? ["deliveryContext"] : []),
  ];
  rejectUnexpectedKeys(input, allowed, `${options.commandName} input`);

  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > maxItems) {
    throw new Error(`${options.commandName} items must contain 1-${maxItems} items.`);
  }

  const rawConversationId = readRequiredString(input.conversationId, `${options.commandName} conversationId`);
  const conversationId = options.normalizeConversationId
    ? options.normalizeConversationId(rawConversationId)
    : rawConversationId;
  const deliveryContext = parseDeliveryContext(input.deliveryContext, `${options.commandName} deliveryContext`);
  const replyToMessageId = readOptionalString(input.replyToMessageId, `${options.commandName} replyToMessageId`);

  return {
    connectorKey: readRequiredString(input.connectorKey, `${options.commandName} connectorKey`),
    conversationId,
    ...(deliveryContext ? {deliveryContext} : {}),
    ...(replyToMessageId ? {replyToMessageId} : {}),
    items: input.items.map((item, index) => parseOutboundItem(item, `${options.commandName} items[${index}]`)),
  };
}

async function resolveItemPath<TItem extends OutboundImageItem | OutboundFileItem>(
  item: TItem,
  request: CommandRequest,
  fileResolver: CommandFileResolver,
): Promise<TItem> {
  if (!("path" in item)) {
    throw new Error("Uploaded file references are only supported by a2a.send.");
  }
  const resolved = await fileResolver.resolveReadablePath({
    request,
    file: {
      path: item.path,
    },
  });
  await assertPathReadable(resolved.path, () => new Error(`No readable file found at ${resolved.displayPath}`));
  return {
    ...item,
    path: resolved.path,
  };
}

async function resolveOutboundItems(
  items: readonly OutboundItem[],
  request: CommandRequest,
  fileResolver: CommandFileResolver,
): Promise<readonly OutboundItem[]> {
  const resolved: OutboundItem[] = [];
  for (const item of items) {
    switch (item.type) {
      case "text":
        resolved.push(item);
        break;
      case "image":
        resolved.push(await resolveItemPath(item, request, fileResolver));
        break;
      case "file":
        resolved.push(await resolveItemPath(item, request, fileResolver));
        break;
    }
  }

  return resolved;
}

function commandOutput(input: ExplicitChannelSendInput, channel: string, deliveryId: string): JsonObject {
  return {
    ok: true,
    status: "queued",
    deliveryId,
    to: {
      channel,
      connectorKey: input.connectorKey,
      conversationId: input.conversationId,
    },
  };
}

function requireCommandOutput(value: JsonValue, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

export function createExplicitChannelSendCommand(
  descriptor: CommandDescriptor,
  options: ExplicitChannelSendCommandOptions,
  services: ExplicitChannelSendCommandServices,
  fileResolver: CommandFileResolver,
): RegisteredCommand {
  return {
    descriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      if (!request.scope.threadId) {
        throw new Error(`${options.commandName} requires a thread id in the current runtime context.`);
      }

      const input = parseExplicitChannelSendInput(request.input, options);
      await assertCurrentSessionConversationBinding({
        conversations: services,
        source: options.channel,
        connectorKey: input.connectorKey,
        externalConversationId: input.conversationId,
        sessionId: request.scope.sessionId,
        commandName: options.commandName,
      });

      const delivery = await services.enqueueDelivery({
        threadId: request.scope.threadId,
        channel: options.channel,
        target: {
          source: options.channel,
          connectorKey: input.connectorKey,
          externalConversationId: input.conversationId,
          ...(input.replyToMessageId ? {replyToMessageId: input.replyToMessageId} : {}),
          ...(input.deliveryContext ? {deliveryContext: input.deliveryContext} : {}),
        },
        items: await resolveOutboundItems(input.items, request, fileResolver),
      });

      return {
        ok: true,
        command: options.commandName,
        output: requireCommandOutput(commandOutput(input, options.channel, delivery.id), `${options.commandName} result`),
        summary: `Queued ${options.channel} delivery ${delivery.id}.`,
      };
    },
  };
}
