import {optionalNonEmptyString, requireNonEmptyString} from "../../../lib/strings.js";
import type {JsonObject} from "../../../lib/json.js";
import {isJsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import type {CommandDescriptor, CommandRequest, RegisteredCommand} from "../../../domain/commands/types.js";
import {commandScopeDenied} from "../../../domain/commands/errors.js";
import type {ConversationBindingAuthorizer} from "../../../domain/channels/conversation-authority.js";
import type {CommandFileResolver} from "../../../domain/commands/files.js";
import {
  createExplicitChannelSendCommand,
  type ExplicitChannelSendCommandServices,
} from "../../../domain/channels/explicit-send-command.js";
import type {OutboundDeliveryRecord, OutboundDeliveryTargetHistoryFilter} from "../../../domain/channels/deliveries/types.js";
import type {OutboundItem} from "../../../domain/channels/types.js";
import type {ConversationBinding, ConversationBindingListFilter} from "../../../domain/sessions/conversations/types.js";
import type {ThreadChannelMessageFilter, ThreadMessageRecord} from "../../../domain/threads/runtime/types.js";
import {WHATSAPP_SOURCE} from "./config.js";
import {extractHistoryMessageText, textPreview} from "../history-text.js";

export const WHATSAPP_SEND_COMMAND_NAME = "whatsapp.send";
export const WHATSAPP_CHAT_LIST_COMMAND_NAME = "whatsapp.chat.list";
export const WHATSAPP_HISTORY_COMMAND_NAME = "whatsapp.history";

const DEFAULT_WHATSAPP_HISTORY_LIMIT = 20;
const MAX_WHATSAPP_HISTORY_LIMIT = 100;
const EXAMPLE_WHATSAPP_ACCOUNT_CONNECTOR_UUID = "00000000-0000-4000-8000-000000000001";

type WhatsAppHistoryDirection = "inbound" | "outbound" | "all";

export interface WhatsAppChatListCommandServices {
  conversations: {
    listConversationBindings(filter: ConversationBindingListFilter): Promise<readonly ConversationBinding[]>;
  };
}

export interface WhatsAppHistoryCommandServices {
  conversations: ConversationBindingAuthorizer;
  messages: {
    listChannelMessages(filter: ThreadChannelMessageFilter): Promise<readonly ThreadMessageRecord[]>;
  };
  deliveries: {
    listDeliveriesForTarget(filter: OutboundDeliveryTargetHistoryFilter): Promise<readonly OutboundDeliveryRecord[]>;
  };
}

export function normalizeWhatsAppConversationId(value: string): string {
  const trimmed = value.trim();
  const jidMatch = trimmed.match(/^([A-Za-z0-9._:-]+)@(s\.whatsapp\.net|lid|g\.us)$/i);
  const jidLocalPart = jidMatch?.[1];
  const jidDomain = jidMatch?.[2];
  if (jidLocalPart && jidDomain) {
    return `${jidLocalPart}@${jidDomain.toLowerCase()}`;
  }

  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new Error("whatsapp.send conversationId must be a phone number, @s.whatsapp.net JID, @lid JID, or @g.us group JID.");
  }

  return `${digits}@s.whatsapp.net`;
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function readOptionalWhatsAppHistoryDirection(value: unknown): WhatsAppHistoryDirection | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "inbound" || value === "outbound" || value === "all") {
    return value;
  }

  throw new Error("whatsapp.history direction must be inbound, outbound, or all.");
}

function rejectUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported field ${unexpected[0]}.`);
  }
}

function requireCommandJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function parseWhatsAppChatListCommandInput(input: unknown): {
  connectorKey?: string;
} {
  if (!isRecord(input)) {
    throw new Error("whatsapp.chat.list input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey"], "whatsapp.chat.list input");

  const connectorKey = optionalNonEmptyString(input.connectorKey, "whatsapp.chat.list connectorKey must not be empty.");
  return connectorKey ? {connectorKey} : {};
}

function parseWhatsAppHistoryCommandInput(input: unknown): {
  connectorKey?: string;
  chatId: string;
  direction?: WhatsAppHistoryDirection;
  limit?: number;
} {
  if (!isRecord(input)) {
    throw new Error("whatsapp.history input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "chatId", "direction", "limit"], "whatsapp.history input");

  const connectorKey = optionalNonEmptyString(input.connectorKey, "whatsapp.history connectorKey must not be empty.");
  const direction = readOptionalWhatsAppHistoryDirection(input.direction);
  const limit = readOptionalPositiveInteger(input.limit, "whatsapp.history limit");
  return {
    ...(connectorKey ? {connectorKey} : {}),
    chatId: normalizeWhatsAppConversationId(requireNonEmptyString(input.chatId, "whatsapp.history chatId must not be empty.")),
    ...(direction ? {direction} : {}),
    ...(limit === undefined ? {} : {limit}),
  };
}

function serializeWhatsAppChatBinding(binding: ConversationBinding): JsonObject {
  return requireCommandJsonObject({
    connectorKey: binding.connectorKey,
    chatId: binding.externalConversationId,
    sessionId: binding.sessionId,
    ...(binding.metadata === undefined ? {} : {metadata: binding.metadata}),
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }, "whatsapp.chat.list chat");
}

function resolveWhatsAppChatListConnectorKey(
  input: {connectorKey?: string},
): string {
  const connectorKey = input.connectorKey;
  if (!connectorKey) {
    throw new Error("WhatsApp connectorKey is required because accounts no longer have a process-wide default.");
  }
  return connectorKey;
}

function clampWhatsAppHistoryLimit(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_WHATSAPP_HISTORY_LIMIT, MAX_WHATSAPP_HISTORY_LIMIT);
}

function readWhatsAppMetadata(record: ThreadMessageRecord): Record<string, unknown> {
  if (!isRecord(record.metadata)) {
    return {};
  }
  const whatsapp = record.metadata.whatsapp;
  return isRecord(whatsapp) ? whatsapp : {};
}

function serializeWhatsAppMedia(metadata: Record<string, unknown>): JsonObject[] {
  const media = metadata.media;
  if (!Array.isArray(media)) {
    return [];
  }

  return media.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = optionalNonEmptyString(entry.id, "whatsapp.history media.id must not be empty.");
    const mimeType = optionalNonEmptyString(entry.mimeType, "whatsapp.history media.mimeType must not be empty.");
    const originalFilename = optionalNonEmptyString(entry.originalFilename, "whatsapp.history media.originalFilename must not be empty.");
    const sizeBytes = typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes)
      ? entry.sizeBytes
      : undefined;
    return [requireCommandJsonObject({
      ...(id ? {id} : {}),
      ...(mimeType ? {mimeType} : {}),
      ...(sizeBytes === undefined ? {} : {sizeBytes}),
      ...(originalFilename ? {originalFilename} : {}),
    }, "whatsapp.history media")];
  });
}

function serializeWhatsAppInboundHistoryItem(record: ThreadMessageRecord): JsonObject {
  const whatsapp = readWhatsAppMetadata(record);
  const sentAt = optionalNonEmptyString(whatsapp.sentAt, "whatsapp.history sentAt must not be empty.");
  const remoteJid = optionalNonEmptyString(whatsapp.remoteJid, "whatsapp.history remoteJid must not be empty.");
  const chatType = optionalNonEmptyString(whatsapp.chatType, "whatsapp.history chatType must not be empty.");
  const pushName = optionalNonEmptyString(whatsapp.pushName, "whatsapp.history pushName must not be empty.");
  const quotedMessageId = optionalNonEmptyString(whatsapp.quotedMessageId, "whatsapp.history quotedMessageId must not be empty.");
  const media = serializeWhatsAppMedia(whatsapp);

  return requireCommandJsonObject({
    id: record.id,
    direction: "inbound",
    threadId: record.threadId,
    ...(record.externalMessageId ? {messageId: record.externalMessageId} : {}),
    ...(record.actorId ? {actorId: record.actorId} : {}),
    ...(remoteJid ? {remoteJid} : {}),
    ...(chatType ? {chatType} : {}),
    ...(pushName ? {pushName} : {}),
    ...(quotedMessageId ? {quotedMessageId} : {}),
    ...textPreview(extractHistoryMessageText(record)),
    ...(media.length > 0 ? {media} : {}),
    ...(sentAt ? {sentAt} : {}),
    createdAt: record.createdAt,
  }, "whatsapp.history inbound item");
}

function serializeOutboundItem(item: OutboundItem): JsonObject {
  switch (item.type) {
    case "text":
      return requireCommandJsonObject({
        type: "text",
        ...textPreview(item.text, 500),
      }, "whatsapp.history outbound text item");
    case "image":
      return requireCommandJsonObject({
        type: "image",
        ...(item.caption ? {caption: item.caption} : {}),
      }, "whatsapp.history outbound image item");
    case "file":
      return requireCommandJsonObject({
        type: "file",
        ...(item.filename ? {filename: item.filename} : {}),
        ...(item.mimeType ? {mimeType: item.mimeType} : {}),
        ...(item.caption ? {caption: item.caption} : {}),
      }, "whatsapp.history outbound file item");
  }
}

function serializeWhatsAppOutboundHistoryItem(delivery: OutboundDeliveryRecord): JsonObject {
  return requireCommandJsonObject({
    id: delivery.id,
    deliveryId: delivery.id,
    direction: "outbound",
    status: delivery.status,
    threadId: delivery.threadId,
    items: delivery.items.map(serializeOutboundItem),
    ...(delivery.sent ? {sentItems: delivery.sent.map((item) => requireCommandJsonObject(item, "whatsapp.history sent item"))} : {}),
    ...(delivery.lastError ? {lastError: delivery.lastError} : {}),
    createdAt: delivery.createdAt,
    ...(delivery.completedAt ? {completedAt: delivery.completedAt} : {}),
  }, "whatsapp.history outbound item");
}

function readHistoryItemCreatedAt(item: JsonObject): number {
  return typeof item.createdAt === "number" ? item.createdAt : 0;
}

async function findWhatsAppChatBinding(
  input: {
    connectorKey?: string;
    chatId: string;
  },
  request: CommandRequest,
  services: Pick<WhatsAppHistoryCommandServices, "conversations">,
): Promise<ConversationBinding> {
  const connectorKey = resolveWhatsAppChatListConnectorKey(input);
  const binding = await services.conversations.getConversationBinding({
    source: WHATSAPP_SOURCE,
    connectorKey,
    externalConversationId: input.chatId,
  });

  if (!binding || binding.sessionId !== request.scope.sessionId) {
    throw commandScopeDenied(
      "whatsapp.history found no matching current-session WhatsApp chat.",
      "resource_scope_denied",
      "Use a chat returned by whatsapp.chat.list in the current session.",
    );
  }

  return binding;
}

export async function executeWhatsAppChatListCommand(
  input: {
    connectorKey?: string;
  },
  request: {scope: {sessionId: string}},
  services: WhatsAppChatListCommandServices,
): Promise<JsonObject> {
  const connectorKey = resolveWhatsAppChatListConnectorKey(input);
  const bindings = await services.conversations.listConversationBindings({
    source: WHATSAPP_SOURCE,
    connectorKey,
  });
  const chats = bindings
    .filter((binding) => binding.sessionId === request.scope.sessionId)
    .map((binding) => serializeWhatsAppChatBinding(binding))
    .sort((left, right) => String(left.chatId).localeCompare(String(right.chatId)));

  return requireCommandJsonObject({
    ok: true,
    connectorKey,
    count: chats.length,
    chats,
  }, "whatsapp.chat.list result");
}

export async function executeWhatsAppHistoryCommand(
  input: {
    connectorKey?: string;
    chatId: string;
    direction?: WhatsAppHistoryDirection;
    limit?: number;
  },
  request: CommandRequest,
  services: WhatsAppHistoryCommandServices,
): Promise<JsonObject> {
  const limit = clampWhatsAppHistoryLimit(input.limit);
  const direction = input.direction ?? "all";
  const {connectorKey, externalConversationId: chatId, sessionId} = await findWhatsAppChatBinding(input, request, services);

  const [messages, deliveries] = await Promise.all([
    direction === "outbound"
      ? Promise.resolve([])
      : services.messages.listChannelMessages({
        sessionId,
        source: WHATSAPP_SOURCE,
        connectorKey,
        channelId: chatId,
        limit,
      }),
    direction === "inbound"
      ? Promise.resolve([])
      : services.deliveries.listDeliveriesForTarget({
        sessionId,
        channel: WHATSAPP_SOURCE,
        connectorKey,
        externalConversationId: chatId,
        limit,
      }),
  ]);

  const items = [
    ...messages.map(serializeWhatsAppInboundHistoryItem),
    ...deliveries.map(serializeWhatsAppOutboundHistoryItem),
  ]
    .sort((left, right) => readHistoryItemCreatedAt(left) - readHistoryItemCreatedAt(right))
    .slice(-limit);

  return requireCommandJsonObject({
    ok: true,
    source: "durable_panda_records",
    direction,
    limit,
    count: items.length,
    chat: {
      connectorKey,
      chatId,
      sessionId,
    },
    items,
  }, "whatsapp.history result");
}

export const whatsappChatListCommandDescriptor: CommandDescriptor = {
  name: WHATSAPP_CHAT_LIST_COMMAND_NAME,
  summary: "List WhatsApp chats bound to the current session.",
  description: "Shows WhatsApp chat ids that this session can use with whatsapp.send. Results are scoped to the current session and one explicit connector account.",
  usage: "panda whatsapp chat list --connector <key>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "connector",
      description: "WhatsApp connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    {
      name: "json",
      description: "Structured JSON object containing connectorKey.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List WhatsApp chats for the current session",
      command: `panda whatsapp chat list --connector ${EXAMPLE_WHATSAPP_ACCOUNT_CONNECTOR_UUID}`,
    },
    {
      description: "List chats for one connector",
      command: `panda whatsapp chat list --connector ${EXAMPLE_WHATSAPP_ACCOUNT_CONNECTOR_UUID}`,
    },
    {
      description: "Use JSON input",
      command: `panda whatsapp chat list --json '{"connectorKey":"${EXAMPLE_WHATSAPP_ACCOUNT_CONNECTOR_UUID}"}'`,
    },
  ],
  requiredCapabilities: [WHATSAPP_CHAT_LIST_COMMAND_NAME],
  resultShape: {
    ok: "boolean",
    connectorKey: "string",
    count: "number",
    chats: ["object"],
  },
};

export const whatsappHistoryCommandDescriptor: CommandDescriptor = {
  name: WHATSAPP_HISTORY_COMMAND_NAME,
  summary: "Show recent durable WhatsApp chat history.",
  description: "Lists recent WhatsApp messages visible to the current session from Panda's durable records: inbound thread messages and outbound delivery receipts. This does not call WhatsApp for server-side chat history.",
  usage: "panda whatsapp history --chat <jid-or-phone> --connector <key> [--direction inbound|outbound|all] [--limit <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "chat",
      description: "WhatsApp phone number, @s.whatsapp.net JID, @lid JID, or @g.us group JID.",
      required: true,
      valueType: "string",
      valueName: "jid-or-phone",
    },
    {
      name: "connector",
      description: "WhatsApp connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    {
      name: "direction",
      description: "History direction to include.",
      valueType: "string",
      valueName: "inbound|outbound|all",
      enumValues: ["inbound", "outbound", "all"],
      defaultValue: "all",
    },
    {
      name: "limit",
      description: `Maximum number of history items to return. Defaults to ${DEFAULT_WHATSAPP_HISTORY_LIMIT}.`,
      valueType: "number",
      valueName: "n",
      defaultValue: DEFAULT_WHATSAPP_HISTORY_LIMIT,
    },
    {
      name: "json",
      description: "Structured JSON object containing chatId and connectorKey, plus optional direction and limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Show recent chat history",
      command: `panda whatsapp history --chat +421900000000 --connector ${EXAMPLE_WHATSAPP_ACCOUNT_CONNECTOR_UUID}`,
    },
    {
      description: "Show only inbound messages",
      command: `panda whatsapp history --chat 421900000000 --connector ${EXAMPLE_WHATSAPP_ACCOUNT_CONNECTOR_UUID} --direction inbound --limit 10`,
    },
    {
      description: "Use JSON input",
      command: `panda whatsapp history --json '{"chatId":"421900000000","connectorKey":"${EXAMPLE_WHATSAPP_ACCOUNT_CONNECTOR_UUID}","direction":"all"}'`,
    },
  ],
  requiredCapabilities: [WHATSAPP_HISTORY_COMMAND_NAME],
  resultShape: {
    ok: "boolean",
    source: "durable_panda_records",
    direction: "inbound|outbound|all",
    count: "number",
    chat: "object",
    items: ["object"],
  },
};

export const whatsappSendCommandDescriptor: CommandDescriptor = {
  name: WHATSAPP_SEND_COMMAND_NAME,
  summary: "Send a WhatsApp message.",
  description: "Queues a WhatsApp outbound delivery to an explicit chat and connector. The chat may be a phone number, WhatsApp user JID, LID JID, or group JID.",
  usage: "panda whatsapp send --chat <jid-or-phone> --connector <key> (--text <text|@file|@->|--stdin|--image <path>|--file <path>)...",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "chat",
      description: "WhatsApp phone number, @s.whatsapp.net JID, @lid JID, or @g.us group JID.",
      required: true,
      valueType: "string",
      valueName: "jid-or-phone",
    },
    {
      name: "connector",
      description: "WhatsApp connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    {
      name: "text",
      description: "Text message body. Use --stdin or --text @file for longer or multiline bodies. Repeat to send multiple text items.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
      repeatable: true,
    },
    {
      name: "stdin",
      description: "Read one text item from stdin.",
      valueType: "boolean",
    },
    {
      name: "image",
      description: "Repeatable image path sent as WhatsApp image.",
      valueType: "string",
      valueName: "path",
      repeatable: true,
    },
    {
      name: "file",
      description: "Repeatable file path sent as WhatsApp document.",
      valueType: "string",
      valueName: "path",
      repeatable: true,
    },
    {
      name: "json",
      description: "Structured JSON object containing connectorKey, conversationId, and items.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Send a text message",
      command: `panda whatsapp send --chat +421900000000 --connector ${EXAMPLE_WHATSAPP_ACCOUNT_CONNECTOR_UUID} --text 'Done.'`,
    },
    {
      description: "Send text from stdin with a file",
      command: `cat message.md | panda whatsapp send --chat 421900000000 --connector ${EXAMPLE_WHATSAPP_ACCOUNT_CONNECTOR_UUID} --text @- --file ./report.pdf`,
    },
    {
      description: "Use a group JID",
      command: `panda whatsapp send --chat 120363000000000000@g.us --connector ${EXAMPLE_WHATSAPP_ACCOUNT_CONNECTOR_UUID} --text 'Done.'`,
    },
  ],
  requiredCapabilities: [WHATSAPP_SEND_COMMAND_NAME],
  resultShape: {
    ok: "boolean",
    status: "queued",
    deliveryId: "string",
    to: {
      channel: "whatsapp",
      connectorKey: "string",
      conversationId: "string",
    },
  },
};

export function createWhatsAppChatListCommand(services: WhatsAppChatListCommandServices): RegisteredCommand {
  return {
    descriptor: whatsappChatListCommandDescriptor,
    async execute(request) {
      const output = await executeWhatsAppChatListCommand(
        parseWhatsAppChatListCommandInput(request.input),
        request,
        services,
      );
      return {
        ok: true,
        command: WHATSAPP_CHAT_LIST_COMMAND_NAME,
        output,
        summary: `Found ${String(output.count)} WhatsApp chat(s) for this session.`,
      };
    },
  };
}

export function createWhatsAppHistoryCommand(services: WhatsAppHistoryCommandServices): RegisteredCommand {
  return {
    descriptor: whatsappHistoryCommandDescriptor,
    async execute(request) {
      const output = await executeWhatsAppHistoryCommand(
        parseWhatsAppHistoryCommandInput(request.input),
        request,
        services,
      );
      return {
        ok: true,
        command: WHATSAPP_HISTORY_COMMAND_NAME,
        output,
        summary: `Found ${String(output.count)} WhatsApp history item(s).`,
      };
    },
  };
}

export function createWhatsAppSendCommand(
  services: ExplicitChannelSendCommandServices,
  fileResolver: CommandFileResolver,
): RegisteredCommand {
  return createExplicitChannelSendCommand(
    whatsappSendCommandDescriptor,
    {
      commandName: WHATSAPP_SEND_COMMAND_NAME,
      channel: WHATSAPP_SOURCE,
      normalizeConversationId: normalizeWhatsAppConversationId,
    },
    services,
    fileResolver,
  );
}
