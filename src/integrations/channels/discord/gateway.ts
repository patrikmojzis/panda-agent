import process from "node:process";

import WebSocket from "ws";
import type {DiscordGatewayAdapterCreator, DiscordGatewayAdapterLibraryMethods} from "@discordjs/voice";

import {isRecord} from "../../../lib/records.js";
import {requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import type {DiscordChannelMetadata, DiscordWorkerRestClient} from "./api.js";
import {
  DISCORD_DEFAULT_GATEWAY_INTENTS,
  DISCORD_GATEWAY_URL,
} from "./config.js";
import type {
  DiscordMessageCreatePayload,
  DiscordParentChannelResolution,
} from "./message-ingestion.js";

const DISCORD_GATEWAY_VERSION = 10;
const DISCORD_GATEWAY_ENCODING = "json";
const DISCORD_OPCODE_DISPATCH = 0;
const DISCORD_OPCODE_HEARTBEAT = 1;
const DISCORD_OPCODE_IDENTIFY = 2;
const DISCORD_OPCODE_HELLO = 10;
const DISCORD_CLOSE_GOING_AWAY = 1001;
const DISCORD_CLOSE_ABNORMAL = 1006;
const GUILD_TEXT_CHANNEL = 0;
const GUILD_NEWS_CHANNEL = 5;
const NEWS_THREAD_CHANNEL = 10;
const PUBLIC_THREAD_CHANNEL = 11;
const PRIVATE_THREAD_CHANNEL = 12;
const GUILD_FORUM_CHANNEL = 15;
const GUILD_MEDIA_CHANNEL = 16;

export interface DiscordGatewaySocket {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: WebSocket.RawData) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
}

export type DiscordGatewaySocketFactory = (url: string) => DiscordGatewaySocket;

export interface DiscordGatewayClientOptions {
  accountKey: string;
  botToken: string;
  channelResolver?: DiscordChannelResolver;
  connectorKey: string;
  gatewayUrl?: string;
  intents?: number;
  log: (event: string, payload: Record<string, unknown>) => void;
  onFatal?: (error: Error) => Promise<void> | void;
  onMessageCreate: (payload: DiscordMessageCreatePayload) => Promise<void> | void;
  socketFactory?: DiscordGatewaySocketFactory;
}

interface DiscordGatewayDispatchEnvelope {
  op?: unknown;
  d?: unknown;
  s?: unknown;
  t?: unknown;
}

function createDefaultSocket(url: string): DiscordGatewaySocket {
  return new WebSocket(url);
}

function rawMessageToText(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

function normalizeDiscordChannelMetadata(payload: unknown): DiscordChannelMetadata | null {
  if (!isRecord(payload)) {
    return null;
  }

  const id = trimToUndefined(payload.id);
  const type = payload.type;
  if (!id || typeof type !== "number" || !Number.isInteger(type)) {
    return null;
  }

  const parentId = trimToUndefined(payload.parent_id);
  const guildId = trimToUndefined(payload.guild_id);
  return {
    id,
    type,
    ...(parentId !== undefined ? {parentId} : {}),
    ...(guildId !== undefined ? {guildId} : {}),
  };
}

function isThreadChannel(type: number): boolean {
  return type === NEWS_THREAD_CHANNEL
    || type === PUBLIC_THREAD_CHANNEL
    || type === PRIVATE_THREAD_CHANNEL;
}

function isParentLaneChannel(type: number): boolean {
  return type === GUILD_TEXT_CHANNEL
    || type === GUILD_NEWS_CHANNEL
    || type === GUILD_FORUM_CHANNEL
    || type === GUILD_MEDIA_CHANNEL;
}

function toParentResolution(metadata: DiscordChannelMetadata): DiscordParentChannelResolution | null {
  if (isThreadChannel(metadata.type)) {
    if (!metadata.parentId) {
      return null;
    }

    return {
      parentChannelId: metadata.parentId,
      threadId: metadata.id,
      ...(metadata.guildId !== undefined ? {guildId: metadata.guildId} : {}),
    };
  }

  if (!isParentLaneChannel(metadata.type)) {
    return null;
  }

  return {
    parentChannelId: metadata.id,
    ...(metadata.guildId !== undefined ? {guildId: metadata.guildId} : {}),
  };
}

export class DiscordChannelResolver {
  private readonly botToken: string;
  private readonly client: Pick<DiscordWorkerRestClient, "getChannelMetadata">;
  private readonly cache = new Map<string, DiscordChannelMetadata>();

  constructor(options: {
    botToken: string;
    client: Pick<DiscordWorkerRestClient, "getChannelMetadata">;
  }) {
    this.botToken = options.botToken;
    this.client = options.client;
  }

  rememberGatewayChannel(payload: unknown): void {
    const metadata = normalizeDiscordChannelMetadata(payload);
    if (!metadata) {
      return;
    }

    this.cache.set(metadata.id, metadata);
  }

  async resolveParentChannelId(actualChannelId: string): Promise<DiscordParentChannelResolution | null> {
    const channelId = requireNonEmptyString(actualChannelId, "Discord channel id must not be empty.");
    const cached = this.cache.get(channelId);
    if (cached) {
      return toParentResolution(cached);
    }

    try {
      const metadata = await this.client.getChannelMetadata(this.botToken, channelId);
      this.cache.set(metadata.id, metadata);
      return toParentResolution(metadata);
    } catch {
      return null;
    }
  }
}

function parseGatewayPayload(data: WebSocket.RawData): DiscordGatewayDispatchEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessageToText(data)) as unknown;
  } catch {
    return null;
  }

  return isRecord(parsed) ? parsed : null;
}

function buildGatewayUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("v", String(DISCORD_GATEWAY_VERSION));
  url.searchParams.set("encoding", DISCORD_GATEWAY_ENCODING);
  return url.toString();
}

function compactCloseReason(reason: Buffer): string {
  return reason.toString("utf8").slice(0, 120);
}

export class DiscordGatewayClient {
  private readonly options: Required<Pick<DiscordGatewayClientOptions, "gatewayUrl" | "intents" | "socketFactory">>
    & Omit<DiscordGatewayClientOptions, "gatewayUrl" | "intents" | "socketFactory">;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sequence: number | null = null;
  private socket: DiscordGatewaySocket | null = null;
  private stopped = true;
  private fatalReported = false;
  private readonly voiceAdapters = new Map<string, DiscordGatewayAdapterLibraryMethods>();

  constructor(options: DiscordGatewayClientOptions) {
    this.options = {
      ...options,
      gatewayUrl: options.gatewayUrl ?? DISCORD_GATEWAY_URL,
      intents: options.intents ?? DISCORD_DEFAULT_GATEWAY_INTENTS,
      socketFactory: options.socketFactory ?? createDefaultSocket,
    };
  }

  async start(): Promise<void> {
    if (this.socket) {
      return;
    }

    this.stopped = false;
    this.fatalReported = false;
    const socket = this.options.socketFactory(buildGatewayUrl(this.options.gatewayUrl));
    this.socket = socket;

    socket.on("message", (data) => {
      void this.handleSocketMessage(data).catch(() => {
        this.options.log("gateway_message_handler_failed", {
          connectorKey: this.options.connectorKey,
          accountKey: this.options.accountKey,
          message: "Discord Gateway message handler failed.",
        });
        void this.reportFatal(new Error("Discord Gateway message handler failed."));
      });
    });
    socket.on("error", (error) => {
      this.options.log("gateway_error", {
        connectorKey: this.options.connectorKey,
        accountKey: this.options.accountKey,
        message: error.message,
      });
    });
    socket.on("close", (code, reason) => {
      this.clearHeartbeat();
      this.socket = null;
      this.options.log("gateway_closed", {
        connectorKey: this.options.connectorKey,
        accountKey: this.options.accountKey,
        code,
        reason: compactCloseReason(reason),
      });
      if (this.stopped) {
        return;
      }

      if (code === DISCORD_CLOSE_GOING_AWAY || code === DISCORD_CLOSE_ABNORMAL) {
        void this.reconnectAfterRecoverableClose(code);
        return;
      }

      void this.reportFatal(new Error(`Discord Gateway closed with code ${code}.`));
    });

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        resolve();
      };
      socket.on("open", handleOpen);
      if (socket.readyState === WebSocket.OPEN) {
        resolve();
      }
      socket.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, "Panda Discord worker stopped.");
    }
    this.destroyVoiceAdapters();
  }

  /** Bridges @discordjs/voice onto Panda's existing raw Gateway connection. */
  createVoiceAdapterCreator(guildId: string): DiscordGatewayAdapterCreator {
    return (methods) => {
      this.voiceAdapters.get(guildId)?.destroy();
      this.voiceAdapters.set(guildId, methods);
      return {
        sendPayload: (payload: unknown): boolean => {
          const socket = this.socket;
          if (!socket || socket.readyState !== WebSocket.OPEN) return false;
          void this.send(payload).catch((error: unknown) => {
            this.options.log("gateway_voice_payload_failed", {
              connectorKey: this.options.connectorKey,
              guildId,
              message: error instanceof Error ? error.message : String(error),
            });
            methods.destroy();
          });
          return true;
        },
        destroy: () => {
          if (this.voiceAdapters.get(guildId) === methods) this.voiceAdapters.delete(guildId);
        },
      };
    };
  }

  private destroyVoiceAdapters(): void {
    for (const adapter of this.voiceAdapters.values()) adapter.destroy();
    this.voiceAdapters.clear();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(payload: unknown): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Discord Gateway socket is not open.");
    }

    return new Promise((resolve, reject) => {
      socket.send(JSON.stringify(payload), (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.send({
        op: DISCORD_OPCODE_HEARTBEAT,
        d: this.sequence,
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.log("gateway_heartbeat_failed", {
          connectorKey: this.options.connectorKey,
          accountKey: this.options.accountKey,
          message,
        });
        void this.reportFatal(error instanceof Error ? error : new Error(message));
      });
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private async identify(): Promise<void> {
    await this.send({
      op: DISCORD_OPCODE_IDENTIFY,
      d: {
        token: this.options.botToken,
        intents: this.options.intents,
        properties: {
          os: process.platform,
          browser: "panda-agent",
          device: "panda-agent",
        },
      },
    });
  }

  private async handleSocketMessage(data: WebSocket.RawData): Promise<void> {
    const payload = parseGatewayPayload(data);
    if (!payload) {
      this.options.log("gateway_payload_dropped", {
        connectorKey: this.options.connectorKey,
        accountKey: this.options.accountKey,
        reason: "invalid_json",
      });
      return;
    }

    if (typeof payload.s === "number") {
      this.sequence = payload.s;
    }

    if (payload.op === DISCORD_OPCODE_HELLO) {
      const hello = isRecord(payload.d) ? payload.d : null;
      const heartbeatInterval = hello?.heartbeat_interval;
      if (typeof heartbeatInterval !== "number" || heartbeatInterval <= 0) {
        await this.reportFatal(new Error("Discord Gateway Hello did not include a heartbeat interval."));
        return;
      }

      this.startHeartbeat(heartbeatInterval);
      await this.identify();
      return;
    }

    if (payload.op !== DISCORD_OPCODE_DISPATCH || typeof payload.t !== "string") {
      return;
    }

    switch (payload.t) {
      case "MESSAGE_CREATE":
        if (isRecord(payload.d)) {
          await this.options.onMessageCreate(payload.d);
        }
        return;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        this.options.channelResolver?.rememberGatewayChannel(payload.d);
        return;
      case "VOICE_SERVER_UPDATE": {
        const guildId = isRecord(payload.d) ? trimToUndefined(payload.d.guild_id) : undefined;
        if (guildId) this.voiceAdapters.get(guildId)?.onVoiceServerUpdate(payload.d as never);
        return;
      }
      case "VOICE_STATE_UPDATE": {
        if (!isRecord(payload.d)) return;
        const guildId = trimToUndefined(payload.d.guild_id);
        const userId = trimToUndefined(payload.d.user_id);
        if (guildId && userId === this.options.connectorKey) {
          this.voiceAdapters.get(guildId)?.onVoiceStateUpdate(payload.d as never);
        }
        return;
      }
      default:
        return;
    }
  }

  private async reconnectAfterRecoverableClose(code: number): Promise<void> {
    this.options.log("gateway_reconnecting", {
      connectorKey: this.options.connectorKey,
      accountKey: this.options.accountKey,
      code,
    });

    try {
      await this.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.reportFatal(new Error(`Discord Gateway reconnect failed after close code ${code}: ${message}`));
    }
  }

  private async reportFatal(error: Error): Promise<void> {
    if (this.fatalReported) {
      return;
    }

    this.fatalReported = true;
    this.destroyVoiceAdapters();
    await this.options.onFatal?.(error);
  }
}
