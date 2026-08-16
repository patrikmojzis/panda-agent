import type {DiscordGatewayAdapterCreator, DiscordGatewayAdapterLibraryMethods} from "@discordjs/voice";
import {WebSocketManager, WebSocketShardEvents} from "@discordjs/ws";

import {isRecord} from "../../../lib/records.js";
import {requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import type {DiscordChannelMetadata, DiscordGatewayBotInfo, DiscordWorkerRestClient} from "./api.js";
import {
  DISCORD_DEFAULT_GATEWAY_INTENTS,
} from "./config.js";
import type {
  DiscordMessageCreatePayload,
  DiscordParentChannelResolution,
} from "./message-ingestion.js";
import type {DiscordVoiceGatewayHealth} from "./voice-transport-health.js";

const GUILD_TEXT_CHANNEL = 0;
const GUILD_NEWS_CHANNEL = 5;
const NEWS_THREAD_CHANNEL = 10;
const PUBLIC_THREAD_CHANNEL = 11;
const PRIVATE_THREAD_CHANNEL = 12;
const GUILD_FORUM_CHANNEL = 15;
const GUILD_MEDIA_CHANNEL = 16;

export interface DiscordGatewayClientOptions {
  accountKey: string;
  botToken: string;
  channelResolver?: DiscordChannelResolver;
  connectorKey: string;
  intents?: number;
  log: (event: string, payload: Record<string, unknown>) => void;
  onFatal?: (error: Error) => Promise<void> | void;
  onMessageCreate: (payload: DiscordMessageCreatePayload) => Promise<void> | void;
  fetchGatewayInformation: () => Promise<DiscordGatewayBotInfo>;
  managerFactory?: (options: ConstructorParameters<typeof WebSocketManager>[0]) => WebSocketManager;
}

interface DiscordGatewayDispatchEnvelope {
  op?: unknown;
  d?: unknown;
  s?: unknown;
  t?: unknown;
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

export class DiscordGatewayClient {
  private readonly options: DiscordGatewayClientOptions & {intents: number};
  private manager: WebSocketManager | null = null;
  private startPromise: Promise<void> | null = null;
  private shardCount = 1;
  private readonly readyShards = new Set<number>();
  private state: DiscordVoiceGatewayHealth["state"] = "closed";
  private readyAt: number | null = null;
  private lastHeartbeatSentAt: number | null = null;
  private lastHeartbeatAckAt: number | null = null;
  private reconnectCount = 0;
  private stopped = true;
  private fatalReported = false;
  private readonly voiceAdapters = new Map<string, DiscordGatewayAdapterLibraryMethods>();

  constructor(options: DiscordGatewayClientOptions) {
    this.options = {
      ...options,
      intents: options.intents ?? DISCORD_DEFAULT_GATEWAY_INTENTS,
    };
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.stopped = false;
    this.fatalReported = false;
    this.state = "opening";
    const pseudoRest = {get: async () => this.options.fetchGatewayInformation()};
    const manager = (this.options.managerFactory ?? ((input) => new WebSocketManager(input)))({
      token: this.options.botToken,
      intents: this.options.intents as never,
      rest: pseudoRest as never,
      identifyProperties: {os: process.platform, browser: "panda-agent", device: "panda-agent"},
      handshakeTimeout: 30_000,
      helloTimeout: 30_000,
      readyTimeout: 30_000,
    });
    this.manager = manager;
    this.attachManager(manager);
    this.startPromise = (async () => {
      try {
        this.shardCount = await manager.getShardCount();
        await manager.connect();
        if (this.stopped || this.manager !== manager) throw new Error("Discord Gateway startup stopped.");
        if (this.readyShards.size < this.shardCount) throw new Error("Discord Gateway connected without all shards becoming ready.");
        this.state = "ready";
      } catch (error) {
        if (!this.stopped) await this.reportFatal(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    })();
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.state = "closed";
    this.readyShards.clear();
    const manager = this.manager;
    this.manager = null;
    this.startPromise = null;
    await manager?.destroy({code: 1000, reason: "Panda Discord worker stopped."});
    this.destroyVoiceAdapters();
  }

  /** Bridges @discordjs/voice onto Panda's existing raw Gateway connection. */
  createVoiceAdapterCreator(guildId: string): DiscordGatewayAdapterCreator {
    return (methods) => {
      this.voiceAdapters.get(guildId)?.destroy();
      this.voiceAdapters.set(guildId, methods);
      return {
        sendPayload: (payload: unknown): boolean => {
          const manager = this.manager;
          const shardId = this.shardForGuild(guildId);
          if (!manager || !this.readyShards.has(shardId)) return false;
          void Promise.resolve(manager.send(shardId, payload as never)).catch((error: unknown) => {
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

  getHealthSnapshot(now = Date.now()): DiscordVoiceGatewayHealth {
    return {
      state: this.state,
      readyAt: this.readyAt,
      sequence: null,
      lastHeartbeatSentAt: this.lastHeartbeatSentAt,
      lastHeartbeatAckAt: this.lastHeartbeatAckAt,
      heartbeatAckAgeMs: this.lastHeartbeatAckAt === null ? null : Math.max(0, now - this.lastHeartbeatAckAt),
      reconnectCount: this.reconnectCount,
    };
  }

  private destroyVoiceAdapters(): void {
    for (const adapter of this.voiceAdapters.values()) adapter.destroy();
    this.voiceAdapters.clear();
  }

  private attachManager(manager: WebSocketManager): void {
    manager.on(WebSocketShardEvents.Ready, (_payload, shardId) => {
      if (this.stopped || this.manager !== manager) return;
      this.readyShards.add(shardId);
      this.readyAt ??= Date.now();
      if (this.readyShards.size >= this.shardCount) this.state = "ready";
    });
    manager.on(WebSocketShardEvents.Resumed, (shardId) => {
      if (this.stopped || this.manager !== manager) return;
      this.readyShards.add(shardId);
      if (this.readyShards.size >= this.shardCount) this.state = "ready";
      this.options.log("gateway_resumed", {connectorKey: this.options.connectorKey, accountKey: this.options.accountKey, shardId});
    });
    manager.on(WebSocketShardEvents.HeartbeatComplete, (stats) => {
      if (this.stopped || this.manager !== manager) return;
      this.lastHeartbeatSentAt = stats.heartbeatAt;
      this.lastHeartbeatAckAt = stats.ackAt;
    });
    manager.on(WebSocketShardEvents.Closed, (code, shardId) => {
      if (this.stopped || this.manager !== manager) return;
      this.readyShards.delete(shardId);
      this.state = "resuming";
      this.reconnectCount += 1;
      this.options.log("gateway_closed", {connectorKey: this.options.connectorKey, accountKey: this.options.accountKey, code, shardId});
      if (code === 4004 || (code >= 4010 && code <= 4014)) void this.reportFatal(new Error(`Discord Gateway closed with terminal code ${code}.`));
    });
    const onError = (error: Error, shardId: number) => {
      if (this.stopped || this.manager !== manager) return;
      this.options.log("gateway_error", {connectorKey: this.options.connectorKey, accountKey: this.options.accountKey, shardId, message: error.message.slice(0, 300)});
    };
    manager.on(WebSocketShardEvents.Error, onError);
    manager.on(WebSocketShardEvents.SocketError, onError);
    manager.on(WebSocketShardEvents.Dispatch, (payload) => {
      if (this.stopped || this.manager !== manager) return;
      void this.handleDispatch(payload as unknown as DiscordGatewayDispatchEnvelope).catch((error: unknown) => {
        this.options.log("gateway_message_handler_failed", {connectorKey: this.options.connectorKey, accountKey: this.options.accountKey, message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)});
      });
    });
  }

  private async handleDispatch(payload: DiscordGatewayDispatchEnvelope): Promise<void> {
    if (typeof payload.t !== "string") return;
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

  private shardForGuild(guildId: string): number {
    try { return Number((BigInt(guildId) >> 22n) % BigInt(this.shardCount)); }
    catch { return 0; }
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
