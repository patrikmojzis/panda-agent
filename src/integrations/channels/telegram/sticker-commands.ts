import type {TelegramStickerLibrary} from "../../../domain/agents/telegram-stickers/service.js";
import {
  buildTelegramStickerLibraryRef,
  buildTelegramStickerSetItemRef,
  type TelegramStickerRecord,
  type TelegramStickerSetSnapshot,
} from "../../../domain/agents/telegram-stickers/types.js";
import type {ConversationBindingAuthorizer} from "../../../domain/channels/conversation-authority.js";
import {assertCurrentSessionConversationBinding} from "../../../domain/channels/conversation-authority.js";
import type {ConnectorAccountListFilter, ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import type {
  CommandDescriptor,
  CommandRequest,
  CommandSuccess,
  RegisteredCommand,
} from "../../../domain/commands/types.js";
import type {
  ThreadChannelMediaFilter,
  ThreadChannelMediaRecord,
} from "../../../domain/threads/runtime/types.js";
import type {JsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import {TELEGRAM_SOURCE} from "./config.js";
import {
  parseTelegramInboundStickerRef,
  readTelegramInboundSticker,
  serializeSafeTelegramSticker,
} from "./sticker-metadata.js";

export const TELEGRAM_STICKER_INSPECT_COMMAND_NAME = "telegram.sticker.inspect";
export const TELEGRAM_STICKER_SAVE_COMMAND_NAME = "telegram.sticker.save";
export const TELEGRAM_STICKER_LIST_COMMAND_NAME = "telegram.sticker.list";
export const TELEGRAM_STICKER_SET_SHOW_COMMAND_NAME = "telegram.sticker.set.show";
export const TELEGRAM_STICKER_SET_SAVE_COMMAND_NAME = "telegram.sticker.set.save";

interface TelegramStickerMessageReader {
  findChannelMedia(filter: ThreadChannelMediaFilter): Promise<ThreadChannelMediaRecord | null>;
}

interface TelegramStickerAccountReader {
  listAccounts(filter?: ConnectorAccountListFilter): Promise<readonly ConnectorAccountRecord[]>;
}

export interface TelegramStickerCommandServices {
  library: TelegramStickerLibrary;
  messages: TelegramStickerMessageReader;
  conversations: ConversationBindingAuthorizer;
  connectorAccounts: TelegramStickerAccountReader;
}

function requireObject(input: unknown, label: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(`${label} input must be a JSON object.`);
  }
  return input;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value.trim() || undefined;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value.map((item) => String(item));
}

function optionalLimit(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`${label} must be an integer from 1 to 100.`);
  }
  return value;
}

function savedStickerOutput(sticker: TelegramStickerRecord): JsonObject {
  return {
    ref: buildTelegramStickerLibraryRef(sticker.id),
    connectorKey: sticker.connectorKey,
    ...(sticker.setName ? {setName: sticker.setName} : {}),
    ...(sticker.setTitle ? {setTitle: sticker.setTitle} : {}),
    ...(sticker.emoji ? {emoji: sticker.emoji} : {}),
    stickerType: sticker.stickerType,
    format: sticker.format,
    width: sticker.width,
    height: sticker.height,
    ...(sticker.sizeBytes === undefined ? {} : {sizeBytes: sticker.sizeBytes}),
    tags: [...sticker.tags],
    ...(sticker.description ? {description: sticker.description} : {}),
    createdAt: sticker.createdAt,
    updatedAt: sticker.updatedAt,
  };
}

function setOutput(set: TelegramStickerSetSnapshot): JsonObject {
  return {
    name: set.name,
    title: set.title,
    stickerType: set.stickerType,
    count: set.stickers.length,
    stickers: set.stickers.map((sticker) => ({
      stickerRef: buildTelegramStickerSetItemRef(set.name, sticker.fileUniqueId),
      ...(sticker.emoji ? {emoji: sticker.emoji} : {}),
      stickerType: sticker.stickerType,
      format: sticker.format,
      width: sticker.width,
      height: sticker.height,
      ...(sticker.sizeBytes === undefined ? {} : {sizeBytes: sticker.sizeBytes}),
    })),
  };
}

async function assertConnectorAccess(
  services: TelegramStickerCommandServices,
  request: CommandRequest,
  connectorKey: string,
  commandName: string,
): Promise<void> {
  const accounts = await services.connectorAccounts.listAccounts({
    source: TELEGRAM_SOURCE,
    status: "enabled",
  });
  const account = accounts.find((item) => item.connectorKey === connectorKey);
  if (!account) {
    throw new Error(`${commandName} found no enabled Telegram connector ${connectorKey}.`);
  }
  if (account.ownerKind === "agent" && account.ownerAgentKey === request.scope.agentKey) {
    return;
  }
  const bindings = await services.conversations.listConversationBindings({
    source: TELEGRAM_SOURCE,
    connectorKey,
  });
  if (!bindings.some((binding) => binding.sessionId === request.scope.sessionId)) {
    throw new Error(`${commandName} cannot access Telegram connector ${connectorKey} from this session.`);
  }
}

async function findInboundSticker(
  input: Record<string, unknown>,
  request: CommandRequest,
  services: TelegramStickerCommandServices,
  commandName: string,
) {
  const connectorKey = requiredString(input.connectorKey, `${commandName} connectorKey`);
  const conversationId = requiredString(input.conversationId, `${commandName} conversationId`);
  const mediaId = parseTelegramInboundStickerRef(requiredString(input.stickerRef, `${commandName} stickerRef`));
  await assertCurrentSessionConversationBinding({
    conversations: services.conversations,
    source: TELEGRAM_SOURCE,
    connectorKey,
    externalConversationId: conversationId,
    sessionId: request.scope.sessionId,
    commandName,
  });
  const found = await services.messages.findChannelMedia({
    sessionId: request.scope.sessionId,
    source: TELEGRAM_SOURCE,
    connectorKey,
    channelId: conversationId,
    mediaId,
  });
  const sticker = found ? readTelegramInboundSticker(found.media) : null;
  if (!found || !sticker) {
    throw new Error(`${commandName} found no matching inbound sticker in the current-session chat.`);
  }
  return {connectorKey, conversationId, found, sticker};
}

function descriptor(
  name: CommandDescriptor["name"],
  summary: string,
  usage: string,
  arguments_: CommandDescriptor["arguments"],
  resultShape: CommandDescriptor["resultShape"],
): CommandDescriptor {
  return {
    name,
    summary,
    description: summary,
    usage,
    inputModes: ["flags", "json", "stdin", "file"],
    outputModes: ["json", "text"],
    arguments: arguments_,
    examples: [{description: summary, command: usage}],
    requiredCapabilities: [name],
    resultShape,
  };
}

const refArgument = {
  name: "sticker-ref",
  description: "Opaque inbound Telegram sticker reference.",
  required: true,
  kind: "positional" as const,
  valueType: "string" as const,
  valueName: "ref",
};

const chatArguments = [
  {
    name: "chat",
    description: "Telegram conversation id.",
    required: true,
    valueType: "string" as const,
    valueName: "conversation-id",
  },
  {
    name: "connector",
    description: "Telegram connector key.",
    required: true,
    valueType: "string" as const,
    valueName: "key",
  },
];

export const telegramStickerInspectCommandDescriptor = descriptor(
  TELEGRAM_STICKER_INSPECT_COMMAND_NAME,
  "Inspect a received Telegram sticker.",
  "panda telegram sticker inspect <sticker-ref> --chat <conversation-id> --connector <key>",
  [refArgument, ...chatArguments],
  {ok: "boolean", chat: "object", sticker: "object"},
);

export const telegramStickerSaveCommandDescriptor = descriptor(
  TELEGRAM_STICKER_SAVE_COMMAND_NAME,
  "Save a received Telegram sticker to the agent library.",
  "panda telegram sticker save <sticker-ref> --chat <conversation-id> --connector <key> [--tag <tag>...] [--description <text>]",
  [
    refArgument,
    ...chatArguments,
    {name: "tag", description: "Library tag.", valueType: "string", valueName: "tag", repeatable: true},
    {name: "description", description: "Library description.", valueType: "string", valueName: "text"},
  ],
  {ok: "boolean", sticker: "object"},
);

export const telegramStickerListCommandDescriptor = descriptor(
  TELEGRAM_STICKER_LIST_COMMAND_NAME,
  "List and search the current agent's Telegram sticker library.",
  "panda telegram sticker list [--query <text>] [--emoji <emoji>] [--tag <tag>] [--connector <key>] [--limit <n>]",
  [
    {name: "query", description: "Search description or pack metadata.", valueType: "string", valueName: "text"},
    {name: "emoji", description: "Exact emoji filter.", valueType: "string", valueName: "emoji"},
    {name: "tag", description: "Exact tag filter.", valueType: "string", valueName: "tag"},
    {name: "connector", description: "Connector key filter.", valueType: "string", valueName: "key"},
    {name: "limit", description: "Maximum results.", valueType: "number", valueName: "n", defaultValue: 50},
  ],
  {ok: "boolean", count: "number", stickers: ["object"]},
);

export const telegramStickerSetShowCommandDescriptor = descriptor(
  TELEGRAM_STICKER_SET_SHOW_COMMAND_NAME,
  "Inspect a Telegram sticker set.",
  "panda telegram sticker set show <set-name> --connector <key>",
  [
    {name: "set-name", description: "Telegram sticker set name.", required: true, kind: "positional", valueType: "string", valueName: "name"},
    {name: "connector", description: "Telegram connector key.", required: true, valueType: "string", valueName: "key"},
  ],
  {ok: "boolean", set: "object"},
);

export const telegramStickerSetSaveCommandDescriptor = descriptor(
  TELEGRAM_STICKER_SET_SAVE_COMMAND_NAME,
  "Import selected stickers or a complete Telegram sticker set.",
  "panda telegram sticker set save <set-name> --connector <key> (--all|--sticker <sticker-ref>...) [--tag <tag>...] [--description <text>]",
  [
    {name: "set-name", description: "Telegram sticker set name.", required: true, kind: "positional", valueType: "string", valueName: "name"},
    {name: "connector", description: "Telegram connector key.", required: true, valueType: "string", valueName: "key"},
    {name: "all", description: "Import the complete set.", valueType: "boolean", conflictsWith: ["sticker"]},
    {name: "sticker", description: "Set-local sticker reference returned by set show.", valueType: "string", valueName: "sticker-ref", repeatable: true, conflictsWith: ["all"]},
    {name: "tag", description: "Library tag.", valueType: "string", valueName: "tag", repeatable: true},
    {name: "description", description: "Library description.", valueType: "string", valueName: "text"},
  ],
  {ok: "boolean", set: "object", createdCount: "number", updatedCount: "number", stickers: ["object"]},
);

function command(
  descriptor_: CommandDescriptor,
  execute: (request: CommandRequest) => Promise<{output: JsonObject; summary: string}>,
): RegisteredCommand {
  return {
    descriptor: descriptor_,
    async execute(request): Promise<CommandSuccess<JsonObject>> {
      const result = await execute(request);
      return {
        ok: true,
        command: descriptor_.name,
        output: result.output,
        summary: result.summary,
      };
    },
  };
}

export function createTelegramStickerInspectCommand(services: TelegramStickerCommandServices): RegisteredCommand {
  return command(telegramStickerInspectCommandDescriptor, async (request) => {
    const input = requireObject(request.input, TELEGRAM_STICKER_INSPECT_COMMAND_NAME);
    const found = await findInboundSticker(input, request, services, TELEGRAM_STICKER_INSPECT_COMMAND_NAME);
    return {
      output: {
        ok: true,
        chat: {connectorKey: found.connectorKey, conversationId: found.conversationId},
        sticker: serializeSafeTelegramSticker(found.sticker),
      },
      summary: "Inspected Telegram sticker.",
    };
  });
}

export function createTelegramStickerSaveCommand(services: TelegramStickerCommandServices): RegisteredCommand {
  return command(telegramStickerSaveCommandDescriptor, async (request) => {
    const input = requireObject(request.input, TELEGRAM_STICKER_SAVE_COMMAND_NAME);
    const found = await findInboundSticker(input, request, services, TELEGRAM_STICKER_SAVE_COMMAND_NAME);
    const saved = await services.library.saveSticker({
      agentKey: request.scope.agentKey,
      connectorKey: found.connectorKey,
      sticker: found.sticker,
      tags: stringArray(input.tags, "telegram.sticker.save tags"),
      description: optionalString(input.description, "telegram.sticker.save description"),
    });
    return {
      output: {ok: true, sticker: savedStickerOutput(saved)},
      summary: "Saved Telegram sticker.",
    };
  });
}

export function createTelegramStickerListCommand(services: TelegramStickerCommandServices): RegisteredCommand {
  return command(telegramStickerListCommandDescriptor, async (request) => {
    const input = requireObject(request.input, TELEGRAM_STICKER_LIST_COMMAND_NAME);
    const stickers = await services.library.listStickers({
      agentKey: request.scope.agentKey,
      connectorKey: optionalString(input.connectorKey, "telegram.sticker.list connectorKey"),
      query: optionalString(input.query, "telegram.sticker.list query"),
      emoji: optionalString(input.emoji, "telegram.sticker.list emoji"),
      tag: optionalString(input.tag, "telegram.sticker.list tag"),
      limit: optionalLimit(input.limit, "telegram.sticker.list limit"),
    });
    return {
      output: {ok: true, count: stickers.length, stickers: stickers.map(savedStickerOutput)},
      summary: `Found ${String(stickers.length)} saved Telegram sticker(s).`,
    };
  });
}

export function createTelegramStickerSetShowCommand(services: TelegramStickerCommandServices): RegisteredCommand {
  return command(telegramStickerSetShowCommandDescriptor, async (request) => {
    const input = requireObject(request.input, TELEGRAM_STICKER_SET_SHOW_COMMAND_NAME);
    const connectorKey = requiredString(input.connectorKey, "telegram.sticker.set.show connectorKey");
    await assertConnectorAccess(services, request, connectorKey, TELEGRAM_STICKER_SET_SHOW_COMMAND_NAME);
    const set = await services.library.readSet(
      connectorKey,
      requiredString(input.setName, "telegram.sticker.set.show setName"),
    );
    return {
      output: {ok: true, set: setOutput(set)},
      summary: `Found ${String(set.stickers.length)} sticker(s) in ${set.name}.`,
    };
  });
}

export function createTelegramStickerSetSaveCommand(services: TelegramStickerCommandServices): RegisteredCommand {
  return command(telegramStickerSetSaveCommandDescriptor, async (request) => {
    const input = requireObject(request.input, TELEGRAM_STICKER_SET_SAVE_COMMAND_NAME);
    const connectorKey = requiredString(input.connectorKey, "telegram.sticker.set.save connectorKey");
    await assertConnectorAccess(services, request, connectorKey, TELEGRAM_STICKER_SET_SAVE_COMMAND_NAME);
    if (input.all !== undefined && typeof input.all !== "boolean") {
      throw new Error("telegram.sticker.set.save all must be a boolean.");
    }
    const result = await services.library.saveSet({
      agentKey: request.scope.agentKey,
      connectorKey,
      setName: requiredString(input.setName, "telegram.sticker.set.save setName"),
      all: input.all === true,
      stickerRefs: stringArray(input.stickerRefs, "telegram.sticker.set.save stickerRefs"),
      tags: stringArray(input.tags, "telegram.sticker.set.save tags"),
      description: optionalString(input.description, "telegram.sticker.set.save description"),
    });
    return {
      output: {
        ok: true,
        set: {name: result.set.name, title: result.set.title},
        createdCount: result.createdCount,
        updatedCount: result.updatedCount,
        stickers: result.stickers.map(savedStickerOutput),
      },
      summary: `Saved ${String(result.stickers.length)} sticker(s) from ${result.set.name}.`,
    };
  });
}
