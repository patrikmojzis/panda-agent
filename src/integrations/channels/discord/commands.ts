import type {JsonObject} from "../../../lib/json.js";
import {isJsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import type {CommandDescriptor, CommandRequest, RegisteredCommand} from "../../../domain/commands/types.js";
import {commandScopeDenied} from "../../../domain/commands/errors.js";
import type {CommandFileResolver} from "../../../domain/commands/files.js";
import {
  createExplicitChannelSendCommand,
  type ExplicitChannelSendCommandServices,
} from "../../../domain/channels/explicit-send-command.js";
import type {OutboundDeliveryRecord, OutboundDeliveryTargetHistoryFilter} from "../../../domain/channels/deliveries/types.js";
import type {OutboundItem} from "../../../domain/channels/types.js";
import type {ConnectorAccountListFilter, ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import type {ConversationBinding, ConversationBindingListFilter} from "../../../domain/sessions/conversations/types.js";
import type {ThreadChannelMessageFilter, ThreadMessageRecord} from "../../../domain/threads/runtime/types.js";
import {DISCORD_SOURCE} from "./config.js";

export const DISCORD_SEND_COMMAND_NAME = "discord.send";
export const DISCORD_CHANNEL_LIST_COMMAND_NAME = "discord.channel.list";
export const DISCORD_HISTORY_COMMAND_NAME = "discord.history";

const DEFAULT_DISCORD_HISTORY_LIMIT = 20;
const MAX_DISCORD_HISTORY_LIMIT = 100;

type DiscordHistoryDirection = "inbound" | "outbound" | "all";

export interface DiscordChannelListCommandServices {
  connectorAccounts: {
    listAccounts(filter?: ConnectorAccountListFilter): Promise<readonly ConnectorAccountRecord[]>;
  };
  conversations: {
    listConversationBindings(filter: ConversationBindingListFilter): Promise<readonly ConversationBinding[]>;
  };
}

export interface DiscordHistoryCommandServices extends DiscordChannelListCommandServices {
  messages: {
    listChannelMessages(filter: ThreadChannelMessageFilter): Promise<readonly ThreadMessageRecord[]>;
  };
  deliveries: {
    listDeliveriesForTarget(filter: OutboundDeliveryTargetHistoryFilter): Promise<readonly OutboundDeliveryRecord[]>;
  };
}

function normalizeDiscordSnowflake(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^\d{1,20}$/.test(trimmed) || !/[1-9]/.test(trimmed)) {
    throw new Error(`${label} must be a Discord snowflake id.`);
  }

  return trimmed;
}

export function normalizeDiscordConversationId(value: string): string {
  return normalizeDiscordSnowflake(value, "discord.send conversationId");
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
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

function readOptionalDiscordHistoryDirection(value: unknown): DiscordHistoryDirection | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "inbound" || value === "outbound" || value === "all") {
    return value;
  }

  throw new Error("discord.history direction must be inbound, outbound, or all.");
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

function parseDiscordChannelListCommandInput(input: unknown): {
  connectorKey?: string;
} {
  if (!isRecord(input)) {
    throw new Error("discord.channel.list input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey"], "discord.channel.list input");

  const connectorKey = readOptionalString(input.connectorKey, "discord.channel.list connectorKey");
  return connectorKey ? {connectorKey} : {};
}

function parseDiscordHistoryCommandInput(input: unknown): {
  connectorKey?: string;
  channelId: string;
  direction?: DiscordHistoryDirection;
  limit?: number;
} {
  if (!isRecord(input)) {
    throw new Error("discord.history input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["connectorKey", "channelId", "direction", "limit"], "discord.history input");

  const connectorKey = readOptionalString(input.connectorKey, "discord.history connectorKey");
  const direction = readOptionalDiscordHistoryDirection(input.direction);
  const limit = readOptionalPositiveInteger(input.limit, "discord.history limit");
  return {
    ...(connectorKey ? {connectorKey} : {}),
    channelId: normalizeDiscordSnowflake(readRequiredString(input.channelId, "discord.history channelId"), "discord.history channelId"),
    ...(direction ? {direction} : {}),
    ...(limit === undefined ? {} : {limit}),
  };
}

function selectEnabledDiscordAccounts(
  accounts: readonly ConnectorAccountRecord[],
  connectorKey: string | undefined,
): readonly ConnectorAccountRecord[] {
  if (!connectorKey) {
    return accounts;
  }

  return accounts.filter((account) => account.connectorKey === connectorKey);
}

function serializeDiscordChannelBinding(
  account: ConnectorAccountRecord,
  binding: ConversationBinding,
): JsonObject {
  return requireCommandJsonObject({
    accountKey: account.accountKey,
    connectorKey: account.connectorKey,
    channelId: binding.externalConversationId,
    sessionId: binding.sessionId,
    ...(binding.metadata === undefined ? {} : {metadata: binding.metadata}),
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }, "discord.channel.list channel");
}

function clampDiscordHistoryLimit(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_DISCORD_HISTORY_LIMIT, MAX_DISCORD_HISTORY_LIMIT);
}

function textPreview(text: string | undefined, maxChars = 1200): JsonObject {
  const value = text?.trim();
  if (!value) {
    return {};
  }

  if (value.length <= maxChars) {
    return {text: value};
  }

  return {
    text: `${value.slice(0, maxChars)}...`,
    truncated: true,
  };
}

function extractHistoryMessageText(record: ThreadMessageRecord): string | undefined {
  const content = (record.message as {content?: unknown}).content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      return [];
    }
    const text = part.text.trim();
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function readDiscordMetadata(record: ThreadMessageRecord): Record<string, unknown> {
  if (!isRecord(record.metadata)) {
    return {};
  }
  const discord = record.metadata.discord;
  return isRecord(discord) ? discord : {};
}

function serializeDiscordMedia(metadata: Record<string, unknown>): JsonObject[] {
  const media = metadata.media;
  if (!Array.isArray(media)) {
    return [];
  }

  return media.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = readOptionalString(entry.id, "discord.history media.id");
    const mimeType = readOptionalString(entry.mimeType, "discord.history media.mimeType");
    const originalFilename = readOptionalString(entry.originalFilename, "discord.history media.originalFilename");
    const sizeBytes = typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes)
      ? entry.sizeBytes
      : undefined;
    return [requireCommandJsonObject({
      ...(id ? {id} : {}),
      ...(mimeType ? {mimeType} : {}),
      ...(sizeBytes === undefined ? {} : {sizeBytes}),
      ...(originalFilename ? {originalFilename} : {}),
    }, "discord.history media")];
  });
}

function serializeDiscordAttachments(metadata: Record<string, unknown>): JsonObject[] {
  const attachments = metadata.attachments;
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments.flatMap((entry) => isJsonObject(entry) ? [entry] : []);
}

function serializeDiscordInboundHistoryItem(record: ThreadMessageRecord): JsonObject {
  const discord = readDiscordMetadata(record);
  const sentAt = readOptionalString(discord.sentAt, "discord.history sentAt");
  const threadId = readOptionalString(discord.threadId, "discord.history threadId");
  const actualChannelId = readOptionalString(discord.actualChannelId, "discord.history actualChannelId");
  const parentChannelId = readOptionalString(discord.parentChannelId, "discord.history parentChannelId");
  const guildId = readOptionalString(discord.guildId, "discord.history guildId");
  const replyToMessageId = readOptionalString(discord.replyToMessageId, "discord.history replyToMessageId");
  const author = isJsonObject(discord.author) ? discord.author : undefined;
  const media = serializeDiscordMedia(discord);
  const attachments = serializeDiscordAttachments(discord);

  return requireCommandJsonObject({
    id: record.id,
    direction: "inbound",
    threadId: record.threadId,
    ...(record.externalMessageId ? {messageId: record.externalMessageId} : {}),
    ...(record.actorId ? {actorId: record.actorId} : {}),
    ...(author ? {author} : {}),
    ...(parentChannelId ? {parentChannelId} : {}),
    ...(actualChannelId ? {actualChannelId} : {}),
    ...(threadId ? {discordThreadId: threadId} : {}),
    ...(guildId ? {guildId} : {}),
    ...(replyToMessageId ? {replyToMessageId} : {}),
    ...textPreview(extractHistoryMessageText(record)),
    ...(attachments.length > 0 ? {attachments} : {}),
    ...(media.length > 0 ? {media} : {}),
    ...(sentAt ? {sentAt} : {}),
    createdAt: record.createdAt,
  }, "discord.history inbound item");
}

function serializeOutboundItem(item: OutboundItem): JsonObject {
  switch (item.type) {
    case "text":
      return requireCommandJsonObject({
        type: "text",
        ...textPreview(item.text, 500),
      }, "discord.history outbound text item");
    case "image":
      return requireCommandJsonObject({
        type: "image",
        ...(item.caption ? {caption: item.caption} : {}),
      }, "discord.history outbound image item");
    case "file":
      return requireCommandJsonObject({
        type: "file",
        ...(item.filename ? {filename: item.filename} : {}),
        ...(item.mimeType ? {mimeType: item.mimeType} : {}),
        ...(item.caption ? {caption: item.caption} : {}),
      }, "discord.history outbound file item");
  }
}

function serializeDiscordOutboundHistoryItem(delivery: OutboundDeliveryRecord): JsonObject {
  const discordContext = isRecord(delivery.target.deliveryContext?.discord)
    ? delivery.target.deliveryContext.discord
    : {};
  const threadId = readOptionalString(discordContext.threadId, "discord.history outbound threadId");
  const guildId = readOptionalString(discordContext.guildId, "discord.history outbound guildId");

  return requireCommandJsonObject({
    id: delivery.id,
    deliveryId: delivery.id,
    direction: "outbound",
    status: delivery.status,
    threadId: delivery.threadId,
    ...(delivery.target.replyToMessageId ? {replyToMessageId: delivery.target.replyToMessageId} : {}),
    ...(threadId ? {discordThreadId: threadId} : {}),
    ...(guildId ? {guildId} : {}),
    items: delivery.items.map(serializeOutboundItem),
    ...(delivery.sent ? {sentItems: delivery.sent.map((item) => requireCommandJsonObject(item, "discord.history sent item"))} : {}),
    ...(delivery.lastError ? {lastError: delivery.lastError} : {}),
    createdAt: delivery.createdAt,
    ...(delivery.completedAt ? {completedAt: delivery.completedAt} : {}),
  }, "discord.history outbound item");
}

function readHistoryItemCreatedAt(item: JsonObject): number {
  return typeof item.createdAt === "number" ? item.createdAt : 0;
}

async function findDiscordChannelBinding(
  input: {
    connectorKey?: string;
    channelId: string;
  },
  request: CommandRequest,
  services: DiscordChannelListCommandServices,
): Promise<JsonObject> {
  const accounts = selectEnabledDiscordAccounts(await services.connectorAccounts.listAccounts({
    source: DISCORD_SOURCE,
    status: "enabled",
  }), input.connectorKey);

  if (input.connectorKey && accounts.length === 0) {
    throw new Error(`discord.channel.info found no enabled Discord connector ${input.connectorKey}.`);
  }

  const matches: JsonObject[] = [];
  for (const account of accounts) {
    const bindings = await services.conversations.listConversationBindings({
      source: DISCORD_SOURCE,
      connectorKey: account.connectorKey,
    });
    for (const binding of bindings) {
      if (
        binding.sessionId === request.scope.sessionId
        && binding.externalConversationId === input.channelId
      ) {
        matches.push(serializeDiscordChannelBinding(account, binding));
      }
    }
  }

  if (matches.length === 0) {
    throw commandScopeDenied(
      "discord.history found no matching current-session Discord channel.",
      "resource_scope_denied",
      "Use a channel returned by discord.channel.list in the current session.",
    );
  }
  if (!input.connectorKey && matches.length > 1) {
    throw new Error("discord.history found multiple matching channels; pass --connector <key>.");
  }

  return matches[0]!;
}

export async function executeDiscordChannelListCommand(
  input: {
    connectorKey?: string;
  },
  request: {scope: {sessionId: string}},
  services: DiscordChannelListCommandServices,
): Promise<JsonObject> {
  const accounts = selectEnabledDiscordAccounts(await services.connectorAccounts.listAccounts({
    source: DISCORD_SOURCE,
    status: "enabled",
  }), input.connectorKey);

  if (input.connectorKey && accounts.length === 0) {
    throw new Error(`discord.channel.list found no enabled Discord connector ${input.connectorKey}.`);
  }

  const channels: JsonObject[] = [];
  for (const account of accounts) {
    const bindings = await services.conversations.listConversationBindings({
      source: DISCORD_SOURCE,
      connectorKey: account.connectorKey,
    });
    for (const binding of bindings) {
      if (binding.sessionId !== request.scope.sessionId) {
        continue;
      }
      channels.push(serializeDiscordChannelBinding(account, binding));
    }
  }

  channels.sort((left, right) => {
    const leftKey = `${String(left.connectorKey)}\u0000${String(left.channelId)}`;
    const rightKey = `${String(right.connectorKey)}\u0000${String(right.channelId)}`;
    return leftKey.localeCompare(rightKey);
  });

  return requireCommandJsonObject({
    ok: true,
    count: channels.length,
    channels,
  }, "discord.channel.list result");
}

export async function executeDiscordHistoryCommand(
  input: {
    connectorKey?: string;
    channelId: string;
    direction?: DiscordHistoryDirection;
    limit?: number;
  },
  request: CommandRequest,
  services: DiscordHistoryCommandServices,
): Promise<JsonObject> {
  const limit = clampDiscordHistoryLimit(input.limit);
  const direction = input.direction ?? "all";
  const channel = await findDiscordChannelBinding(input, request, services);
  const connectorKey = readRequiredString(channel.connectorKey, "discord.history channel.connectorKey");
  const channelId = readRequiredString(channel.channelId, "discord.history channel.channelId");
  const sessionId = readRequiredString(channel.sessionId, "discord.history channel.sessionId");

  const [messages, deliveries] = await Promise.all([
    direction === "outbound"
      ? Promise.resolve([])
      : services.messages.listChannelMessages({
        sessionId,
        source: DISCORD_SOURCE,
        connectorKey,
        channelId,
        limit,
      }),
    direction === "inbound"
      ? Promise.resolve([])
      : services.deliveries.listDeliveriesForTarget({
        sessionId,
        channel: DISCORD_SOURCE,
        connectorKey,
        externalConversationId: channelId,
        limit,
      }),
  ]);

  const items = [
    ...messages.map(serializeDiscordInboundHistoryItem),
    ...deliveries.map(serializeDiscordOutboundHistoryItem),
  ]
    .sort((left, right) => readHistoryItemCreatedAt(left) - readHistoryItemCreatedAt(right))
    .slice(-limit);

  return requireCommandJsonObject({
    ok: true,
    source: "durable_panda_records",
    direction,
    limit,
    count: items.length,
    channel: {
      connectorKey,
      channelId,
      sessionId,
    },
    items,
  }, "discord.history result");
}

export const discordChannelListCommandDescriptor: CommandDescriptor = {
  name: DISCORD_CHANNEL_LIST_COMMAND_NAME,
  summary: "List Discord channels bound to the current session.",
  description: "Shows enabled Discord connector keys and channel ids that this session can use with discord.send. Results are scoped to the current session.",
  usage: "panda discord channel list [--connector <key>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "connector",
      description: "Optional Discord connector key to narrow the list.",
      valueType: "string",
      valueName: "key",
    },
    {
      name: "json",
      description: "Structured JSON object containing optional connectorKey.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List Discord channels for the current session",
      command: "panda discord channel list",
    },
    {
      description: "List channels for one connector",
      command: "panda discord channel list --connector discord-main",
    },
    {
      description: "Use JSON input",
      command: "panda discord channel list --json '{\"connectorKey\":\"discord-main\"}'",
    },
  ],
  requiredCapabilities: [DISCORD_CHANNEL_LIST_COMMAND_NAME],
  resultShape: {
    ok: "boolean",
    count: "number",
    channels: ["object"],
  },
};

export const discordHistoryCommandDescriptor: CommandDescriptor = {
  name: DISCORD_HISTORY_COMMAND_NAME,
  summary: "Show recent durable Discord channel history.",
  description: "Lists recent Discord messages visible to the current session from Panda's durable records: inbound thread messages and outbound delivery receipts. This does not call Discord for server-side channel history.",
  usage: "panda discord history --channel <channel-id> [--connector <key>] [--direction inbound|outbound|all] [--limit <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "channel",
      description: "Discord parent channel id.",
      required: true,
      valueType: "string",
      valueName: "channel-id",
    },
    {
      name: "connector",
      description: "Optional Discord connector key. Required when the channel id is ambiguous across connectors.",
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
      description: `Maximum number of history items to return. Defaults to ${DEFAULT_DISCORD_HISTORY_LIMIT}.`,
      valueType: "number",
      valueName: "n",
      defaultValue: DEFAULT_DISCORD_HISTORY_LIMIT,
    },
    {
      name: "json",
      description: "Structured JSON object containing channelId plus optional connectorKey, direction, and limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Show recent channel history",
      command: "panda discord history --channel 12345 --connector discord-main",
    },
    {
      description: "Show only outbound receipts",
      command: "panda discord history --channel 12345 --connector discord-main --direction outbound --limit 10",
    },
    {
      description: "Use JSON input",
      command: "panda discord history --json '{\"channelId\":\"12345\",\"connectorKey\":\"discord-main\",\"direction\":\"all\"}'",
    },
  ],
  requiredCapabilities: [DISCORD_HISTORY_COMMAND_NAME],
  resultShape: {
    ok: "boolean",
    source: "durable_panda_records",
    direction: "inbound|outbound|all",
    count: "number",
    channel: "object",
    items: ["object"],
  },
};

export const discordSendCommandDescriptor: CommandDescriptor = {
  name: DISCORD_SEND_COMMAND_NAME,
  summary: "Send a Discord message.",
  description: "Queues a Discord outbound delivery to an explicit channel and connector. Use --thread when sending into a Discord thread while keeping --channel as the parent channel id.",
  usage: "panda discord send --channel <channel-id> --connector <key> [--thread <thread-id>] [--guild <guild-id>] (--text <text|@file|@->|--stdin|--image <path>|--file <path>)... [--reply-to-message-id <message-id>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "channel",
      description: "Discord channel id. For thread sends, pass the parent channel id here and --thread for the thread id.",
      required: true,
      valueType: "string",
      valueName: "channel-id",
    },
    {
      name: "connector",
      description: "Discord connector key.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    {
      name: "thread",
      description: "Discord thread id to send into.",
      valueType: "string",
      valueName: "thread-id",
    },
    {
      name: "guild",
      description: "Discord guild id used for reply references.",
      valueType: "string",
      valueName: "guild-id",
    },
    {
      name: "text",
      description: "Text message body. Use --stdin or --text @file for longer bodies. Repeat to send multiple text items.",
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
      description: "Repeatable image path sent as Discord upload.",
      valueType: "string",
      valueName: "path",
      repeatable: true,
    },
    {
      name: "file",
      description: "Repeatable file path sent as Discord upload.",
      valueType: "string",
      valueName: "path",
      repeatable: true,
    },
    {
      name: "reply-to-message-id",
      description: "Discord message id to reply to.",
      valueType: "string",
      valueName: "message-id",
    },
    {
      name: "json",
      description: "Structured JSON object containing connectorKey, conversationId, items, optional replyToMessageId, and optional deliveryContext.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Send a text message",
      command: "panda discord send --channel 12345 --connector discord-main --text 'Done.'",
    },
    {
      description: "Send text from stdin with a file",
      command: "cat message.md | panda discord send --channel 12345 --connector discord-main --text @- --file ./report.pdf",
    },
    {
      description: "Send into a thread",
      command: "panda discord send --channel 12345 --thread 67890 --connector discord-main --text 'Done.'",
    },
  ],
  requiredCapabilities: [DISCORD_SEND_COMMAND_NAME],
  resultShape: {
    ok: "boolean",
    status: "queued",
    deliveryId: "string",
    to: {
      channel: "discord",
      connectorKey: "string",
      conversationId: "string",
    },
  },
};

export function createDiscordChannelListCommand(services: DiscordChannelListCommandServices): RegisteredCommand {
  return {
    descriptor: discordChannelListCommandDescriptor,
    async execute(request) {
      const output = await executeDiscordChannelListCommand(
        parseDiscordChannelListCommandInput(request.input),
        request,
        services,
      );
      return {
        ok: true,
        command: DISCORD_CHANNEL_LIST_COMMAND_NAME,
        output,
        summary: `Found ${String(output.count)} Discord channel(s) for this session.`,
      };
    },
  };
}

export function createDiscordHistoryCommand(services: DiscordHistoryCommandServices): RegisteredCommand {
  return {
    descriptor: discordHistoryCommandDescriptor,
    async execute(request) {
      const output = await executeDiscordHistoryCommand(
        parseDiscordHistoryCommandInput(request.input),
        request,
        services,
      );
      return {
        ok: true,
        command: DISCORD_HISTORY_COMMAND_NAME,
        output,
        summary: `Found ${String(output.count)} Discord history item(s).`,
      };
    },
  };
}

export function createDiscordSendCommand(
  services: ExplicitChannelSendCommandServices,
  fileResolver: CommandFileResolver,
): RegisteredCommand {
  return createExplicitChannelSendCommand(
    discordSendCommandDescriptor,
    {
      commandName: DISCORD_SEND_COMMAND_NAME,
      channel: DISCORD_SOURCE,
      allowDeliveryContext: true,
      allowReplyToMessageId: true,
      normalizeConversationId: normalizeDiscordConversationId,
    },
    services,
    fileResolver,
  );
}
