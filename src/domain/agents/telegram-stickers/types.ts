import {createHash, randomUUID} from "node:crypto";

import {normalizeAgentKey} from "../types.js";

export const MAX_AGENT_TELEGRAM_STICKERS = 500;
export const MAX_TELEGRAM_STICKER_IMPORT = 200;
export const MAX_TELEGRAM_STICKER_TAGS = 10;
export const MAX_TELEGRAM_STICKER_TAG_CHARS = 32;
export const MAX_TELEGRAM_STICKER_DESCRIPTION_CHARS = 160;

export type TelegramStickerFormat = "static" | "animated" | "video";
export type TelegramStickerType = "regular" | "mask" | "custom_emoji";

export interface TelegramStickerItem {
  fileId: string;
  fileUniqueId: string;
  setName?: string;
  setTitle?: string;
  emoji?: string;
  stickerType: TelegramStickerType;
  format: TelegramStickerFormat;
  width: number;
  height: number;
  sizeBytes?: number;
}

export interface TelegramStickerRecord extends TelegramStickerItem {
  id: string;
  agentKey: string;
  connectorKey: string;
  tags: readonly string[];
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TelegramStickerSetSnapshot {
  name: string;
  title: string;
  stickerType: TelegramStickerType;
  stickers: readonly TelegramStickerItem[];
}

export interface ImportTelegramStickersInput {
  agentKey: string;
  connectorKey: string;
  stickers: readonly TelegramStickerItem[];
  tags?: readonly string[];
  description?: string;
}

export interface ImportTelegramStickersResult {
  stickers: readonly TelegramStickerRecord[];
  createdCount: number;
  updatedCount: number;
}

export interface ListTelegramStickersFilter {
  agentKey: string;
  connectorKey?: string;
  query?: string;
  emoji?: string;
  tag?: string;
  limit?: number;
}

export function normalizeTelegramStickerFormat(value: unknown): TelegramStickerFormat {
  if (value === "static" || value === "animated" || value === "video") {
    return value;
  }
  throw new Error(`Unsupported Telegram sticker format ${String(value)}.`);
}

export function normalizeTelegramStickerType(value: unknown): TelegramStickerType {
  if (value === "regular" || value === "mask" || value === "custom_emoji") {
    return value;
  }
  throw new Error(`Unsupported Telegram sticker type ${String(value)}.`);
}

export function normalizeTelegramStickerTag(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Telegram sticker tags must be strings.");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Telegram sticker tags must not be empty.");
  }
  if (normalized.length > MAX_TELEGRAM_STICKER_TAG_CHARS) {
    throw new Error(`Telegram sticker tags must be at most ${MAX_TELEGRAM_STICKER_TAG_CHARS} characters.`);
  }
  if (!/^[a-z0-9][a-z0-9:_-]*$/.test(normalized)) {
    throw new Error("Telegram sticker tags must use lowercase letters, numbers, colons, dashes, or underscores.");
  }
  return normalized;
}

export function normalizeTelegramStickerTags(values: readonly unknown[] = []): string[] {
  if (values.length > MAX_TELEGRAM_STICKER_TAGS) {
    throw new Error(`Telegram stickers can have at most ${MAX_TELEGRAM_STICKER_TAGS} tags.`);
  }
  return [...new Set(values.map(normalizeTelegramStickerTag))];
}

export function normalizeTelegramStickerDescription(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > MAX_TELEGRAM_STICKER_DESCRIPTION_CHARS) {
    throw new Error(
      `Telegram sticker descriptions must be at most ${MAX_TELEGRAM_STICKER_DESCRIPTION_CHARS} characters.`,
    );
  }
  return normalized;
}

export function createTelegramStickerId(): string {
  return randomUUID();
}

export function buildTelegramStickerLibraryRef(id: string): string {
  return `tg-lib:${id}`;
}

export function parseTelegramStickerLibraryRef(value: string): string {
  const normalized = value.trim();
  const match = /^tg-lib:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(normalized);
  if (!match) {
    throw new Error("Telegram sticker reference must use tg-lib:<uuid>.");
  }
  return match[1]!.toLowerCase();
}

export function buildTelegramStickerSetItemRef(setName: string, fileUniqueId: string): string {
  const normalizedSetName = setName.trim();
  const normalizedFileUniqueId = fileUniqueId.trim();
  if (!normalizedSetName || !normalizedFileUniqueId) {
    throw new Error("Telegram sticker set item references require a set name and file unique id.");
  }
  const token = createHash("sha256")
    .update(normalizedSetName)
    .update("\0")
    .update(normalizedFileUniqueId)
    .digest("base64url")
    .slice(0, 22);
  return `tg-set:${token}`;
}

export function parseTelegramStickerSetItemRef(value: string): string {
  const normalized = value.trim();
  if (!/^tg-set:[A-Za-z0-9_-]{22}$/.test(normalized)) {
    throw new Error("Telegram sticker set item reference must use tg-set:<opaque-token>.");
  }
  return normalized;
}

export function normalizeTelegramStickerImport(input: ImportTelegramStickersInput): ImportTelegramStickersInput {
  if (input.stickers.length === 0) {
    throw new Error("Telegram sticker import requires at least one sticker.");
  }
  if (input.stickers.length > MAX_TELEGRAM_STICKER_IMPORT) {
    throw new Error(`Telegram sticker import is limited to ${MAX_TELEGRAM_STICKER_IMPORT} stickers.`);
  }
  const connectorKey = input.connectorKey.trim();
  if (!connectorKey) {
    throw new Error("Telegram sticker connector key must not be empty.");
  }
  return {
    agentKey: normalizeAgentKey(input.agentKey),
    connectorKey,
    stickers: input.stickers,
    tags: normalizeTelegramStickerTags(input.tags),
    description: normalizeTelegramStickerDescription(input.description),
  };
}
