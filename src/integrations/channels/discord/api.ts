import {requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {DISCORD_API_BASE_URL} from "./config.js";

export interface DiscordCurrentUser {
  id: string;
  username: string;
  displayName: string;
  globalName?: string;
  bot?: boolean;
}

export interface DiscordChannelMetadata {
  id: string;
  type: number;
  parentId?: string;
  guildId?: string;
}

export interface DiscordMessageReferenceBody {
  message_id: string;
  channel_id: string;
  guild_id?: string;
  fail_if_not_exists: false;
}

export interface DiscordCreateMessageBody {
  content?: string;
  allowed_mentions: {
    parse: readonly string[];
  };
  message_reference?: DiscordMessageReferenceBody;
  sticker_ids?: readonly string[];
}

export interface DiscordCreateMessageFile {
  filename: string;
  bytes: Buffer;
  mimeType?: string;
}

export interface DiscordCreatedMessage {
  id: string;
}

export interface DiscordGuildSticker {
  id: string;
  name: string;
  description?: string;
  tags: string;
  formatType: 1 | 2 | 3 | 4;
  available?: boolean;
  guildId?: string;
}

export interface DiscordRestClient {
  getCurrentUser(botToken: string): Promise<DiscordCurrentUser>;
}

export interface DiscordWorkerRestClient extends DiscordRestClient {
  createMessage(
    botToken: string,
    channelId: string,
    body: DiscordCreateMessageBody,
    files?: readonly DiscordCreateMessageFile[],
  ): Promise<DiscordCreatedMessage>;
  getChannelMetadata(botToken: string, channelId: string): Promise<DiscordChannelMetadata>;
  listGuildStickers(botToken: string, guildId: string): Promise<readonly DiscordGuildSticker[]>;
}

export interface DiscordApiFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface DiscordApiFetchInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string | FormData;
}

export type DiscordApiFetch = (url: string, init: DiscordApiFetchInit) => Promise<DiscordApiFetchResponse>;

export interface CreateDiscordRestClientOptions {
  apiBaseUrl?: string;
  fetcher?: DiscordApiFetch;
}

export function requireDiscordBotToken(value: string): string {
  return requireNonEmptyString(value, "Discord bot token must not be empty.");
}

function normalizeDiscordApiBaseUrl(value: string | undefined): string {
  const baseUrl = trimToUndefined(value) ?? DISCORD_API_BASE_URL;
  return baseUrl.replace(/\/+$/, "");
}

function readDiscordStringField(payload: Record<string, unknown>, field: string, label: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Discord current user ${label} is missing or invalid.`);
  }

  return value.trim();
}

function readOptionalDiscordStringField(
  payload: Record<string, unknown>,
  field: string,
  label: string,
): string | undefined {
  const value = payload[field];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Discord current user ${label} must be a string.`);
  }

  return trimToUndefined(value);
}

function parseDiscordCurrentUser(payload: unknown): DiscordCurrentUser {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Discord current user response must be an object.");
  }

  const record = payload as Record<string, unknown>;
  const id = readDiscordStringField(record, "id", "id");
  if (!/^\d+$/.test(id)) {
    throw new Error("Discord current user id is missing or invalid.");
  }

  const username = readDiscordStringField(record, "username", "username");
  const globalName = readOptionalDiscordStringField(record, "global_name", "global name");
  const displayName = readOptionalDiscordStringField(record, "display_name", "display name")
    ?? globalName
    ?? username;
  const bot = record.bot;
  if (bot !== undefined && typeof bot !== "boolean") {
    throw new Error("Discord current user bot flag must be a boolean.");
  }
  if (bot === false) {
    throw new Error("Discord token did not resolve to a bot user.");
  }

  return {
    id,
    username,
    displayName,
    ...(globalName !== undefined ? {globalName} : {}),
    ...(typeof bot === "boolean" ? {bot} : {}),
  };
}

function readDiscordNumberField(payload: Record<string, unknown>, field: string, label: string): number {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Discord channel ${label} is missing or invalid.`);
  }

  return value;
}

function parseDiscordChannelMetadata(payload: unknown): DiscordChannelMetadata {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Discord channel response must be an object.");
  }

  const record = payload as Record<string, unknown>;
  const parentId = readOptionalDiscordStringField(record, "parent_id", "parent id");
  const guildId = readOptionalDiscordStringField(record, "guild_id", "guild id");
  return {
    id: readDiscordStringField(record, "id", "id"),
    type: readDiscordNumberField(record, "type", "type"),
    ...(parentId !== undefined ? {parentId} : {}),
    ...(guildId !== undefined ? {guildId} : {}),
  };
}

function parseDiscordCreatedMessage(payload: unknown): DiscordCreatedMessage {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Discord message response must be an object.");
  }

  return {
    id: readDiscordStringField(payload as Record<string, unknown>, "id", "message id"),
  };
}

function parseDiscordGuildSticker(payload: unknown, index: number): DiscordGuildSticker {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`Discord guild sticker ${String(index + 1)} must be an object.`);
  }
  const record = payload as Record<string, unknown>;
  const formatType = record.format_type;
  if (formatType !== 1 && formatType !== 2 && formatType !== 3 && formatType !== 4) {
    throw new Error(`Discord guild sticker ${String(index + 1)} format is invalid.`);
  }
  const description = readOptionalDiscordStringField(record, "description", "sticker description");
  const available = record.available;
  if (available !== undefined && typeof available !== "boolean") {
    throw new Error(`Discord guild sticker ${String(index + 1)} available flag must be a boolean.`);
  }
  const guildId = readOptionalDiscordStringField(record, "guild_id", "sticker guild id");
  return {
    id: readDiscordStringField(record, "id", "sticker id"),
    name: readDiscordStringField(record, "name", "sticker name"),
    tags: readDiscordStringField(record, "tags", "sticker tags"),
    formatType,
    ...(description !== undefined ? {description} : {}),
    ...(available !== undefined ? {available} : {}),
    ...(guildId !== undefined ? {guildId} : {}),
  };
}

function parseDiscordGuildStickers(payload: unknown): readonly DiscordGuildSticker[] {
  if (!Array.isArray(payload)) {
    throw new Error("Discord guild sticker response must be an array.");
  }
  return payload.map(parseDiscordGuildSticker);
}

async function discordResponseError(response: DiscordApiFetchResponse, operation: string): Promise<Error> {
  let details = "";
  try {
    const payload = await response.json();
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      const code = typeof record.code === "number" || typeof record.code === "string" ? String(record.code) : undefined;
      const message = typeof record.message === "string" ? record.message.trim().slice(0, 200) : undefined;
      details = [code ? `code ${code}` : undefined, message].filter(Boolean).join(": ");
    }
  } catch {
    // Keep the status-only error when Discord does not return JSON.
  }
  return new Error(`${operation}: Discord API returned ${response.status}${details ? ` (${details})` : ""}.`);
}

async function defaultDiscordApiFetch(url: string, init: DiscordApiFetchInit): Promise<DiscordApiFetchResponse> {
  return fetch(url, init);
}

function discordAuthorizationHeaders(botToken: string): Record<string, string> {
  const token = requireDiscordBotToken(botToken);
  return {
    Accept: "application/json",
    Authorization: `Bot ${token}`,
    "User-Agent": "panda-agent-discord-worker/0.1",
  };
}

function toUploadBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}

function buildDiscordCreateMessageRequest(input: {
  botToken: string;
  body: DiscordCreateMessageBody;
  files?: readonly DiscordCreateMessageFile[];
}): {headers: Record<string, string>; body: string | FormData} {
  const headers = discordAuthorizationHeaders(input.botToken);
  if (!input.files || input.files.length === 0) {
    return {
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
    };
  }

  const form = new FormData();
  form.append("payload_json", JSON.stringify(input.body));
  input.files.forEach((file, index) => {
    const filename = requireNonEmptyString(file.filename, "Discord upload filename must not be empty.");
    const mimeType = trimToUndefined(file.mimeType) ?? "application/octet-stream";
    form.append(`files[${index}]`, new Blob([toUploadBytes(file.bytes)], {type: mimeType}), filename);
  });

  return {
    headers,
    body: form,
  };
}

export function createDiscordRestClient(options: CreateDiscordRestClientOptions = {}): DiscordWorkerRestClient {
  const apiBaseUrl = normalizeDiscordApiBaseUrl(options.apiBaseUrl);
  const fetcher = options.fetcher ?? defaultDiscordApiFetch;

  return {
    async getCurrentUser(botToken: string): Promise<DiscordCurrentUser> {
      let response: DiscordApiFetchResponse;
      try {
        response = await fetcher(`${apiBaseUrl}/users/@me`, {
          method: "GET",
          headers: discordAuthorizationHeaders(botToken),
        });
      } catch {
        throw new Error("Discord token validation failed: request failed.");
      }

      if (!response.ok) {
        throw new Error(`Discord token validation failed: Discord API returned ${response.status}.`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Discord token validation failed: invalid JSON response from Discord API.");
      }

      return parseDiscordCurrentUser(payload);
    },

    async getChannelMetadata(botToken: string, channelId: string): Promise<DiscordChannelMetadata> {
      const normalizedChannelId = requireNonEmptyString(channelId, "Discord channel id must not be empty.");
      let response: DiscordApiFetchResponse;
      try {
        response = await fetcher(`${apiBaseUrl}/channels/${encodeURIComponent(normalizedChannelId)}`, {
          method: "GET",
          headers: discordAuthorizationHeaders(botToken),
        });
      } catch {
        throw new Error("Discord channel lookup failed: request failed.");
      }

      if (!response.ok) {
        throw await discordResponseError(response, "Discord channel lookup failed");
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Discord channel lookup failed: invalid JSON response from Discord API.");
      }

      return parseDiscordChannelMetadata(payload);
    },

    async listGuildStickers(botToken: string, guildId: string): Promise<readonly DiscordGuildSticker[]> {
      const normalizedGuildId = requireNonEmptyString(guildId, "Discord guild id must not be empty.");
      let response: DiscordApiFetchResponse;
      try {
        response = await fetcher(`${apiBaseUrl}/guilds/${encodeURIComponent(normalizedGuildId)}/stickers`, {
          method: "GET",
          headers: discordAuthorizationHeaders(botToken),
        });
      } catch {
        throw new Error("Discord guild sticker lookup failed: request failed.");
      }
      if (!response.ok) {
        throw await discordResponseError(response, "Discord guild sticker lookup failed");
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Discord guild sticker lookup failed: invalid JSON response from Discord API.");
      }
      return parseDiscordGuildStickers(payload);
    },

    async createMessage(
      botToken: string,
      channelId: string,
      body: DiscordCreateMessageBody,
      files?: readonly DiscordCreateMessageFile[],
    ): Promise<DiscordCreatedMessage> {
      const normalizedChannelId = requireNonEmptyString(channelId, "Discord channel id must not be empty.");
      const request = buildDiscordCreateMessageRequest({botToken, body, files});
      let response: DiscordApiFetchResponse;
      try {
        response = await fetcher(`${apiBaseUrl}/channels/${encodeURIComponent(normalizedChannelId)}/messages`, {
          method: "POST",
          headers: request.headers,
          body: request.body,
        });
      } catch {
        throw new Error("Discord message send failed: request failed.");
      }

      if (!response.ok) {
        throw await discordResponseError(response, "Discord message send failed");
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Discord message send failed: invalid JSON response from Discord API.");
      }

      return parseDiscordCreatedMessage(payload);
    },
  };
}
