import {AbortController} from "abort-controller";
import {Bot, type Context} from "grammy";
import type {Pool} from "pg";

import {type HealthServer, resolveOptionalHealthServerBinding, startHealthServer} from "../../../app/health/server.js";
import {ChannelActionWorker, type TelegramReactionActionPayload} from "../../../domain/channels/actions/index.js";
import {ChannelCursorRepo} from "../../../domain/channels/cursors/repo.js";
import {
    acquireManagedConnectorLease,
    type ManagedConnectorLease,
    PostgresConnectorLeaseRepo
} from "../../../domain/connector-leases/index.js";
import {FileSystemMediaStore, type MediaDescriptor} from "../../../domain/channels/index.js";
import {
    ChannelOutboundDeliveryWorker,
    PostgresOutboundDeliveryStore
} from "../../../domain/channels/deliveries/index.js";
import {
    buildObservedPoolConfig,
    createPostgresPool,
    observePostgresPool,
    type PostgresPoolObserver,
    requireDatabaseUrl,
} from "../../../app/runtime/database.js";
import {ensureSchemas} from "../../../app/runtime/postgres-bootstrap.js";
import {RuntimeRequestRepo} from "../../../domain/threads/requests/index.js";
import {TELEGRAM_POLL_TIMEOUT_SECONDS, TELEGRAM_SOURCE, TELEGRAM_UPDATES_CURSOR_KEY} from "./config.js";
import {buildTelegramConversationId} from "./helpers.js";
import {createTelegramOutboundAdapter} from "./outbound.js";
import {parseTelegramConversationId} from "./conversation-id.js";
import {createTelegramTypingAdapter} from "./typing.js";
import {PostgresChannelActionStore} from "../../../domain/channels/actions/postgres.js";
import {
    type PostgresNotificationListenerHandle,
    startPostgresNotificationListener,
} from "../postgres-notification-listener.js";
import {runCleanupSteps} from "../../../lib/cleanup.js";

type TelegramContext = Context;
const UPDATE_RETRY_DELAY_MS = 1_000;
const TELEGRAM_POOL_MAX_FALLBACK = 5;
const TELEGRAM_HEALTH_POLL_STALE_AFTER_MS = (TELEGRAM_POLL_TIMEOUT_SECONDS * 1_000) + 15_000;

export interface TelegramServiceOptions {
  token: string;
  dataDir: string;
  dbUrl?: string;
}

interface TelegramReactionUpdateUser {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

interface TelegramEmojiReaction {
  type: "emoji";
  emoji: string;
}

interface TelegramReactionContextLike {
  update?: {
    update_id?: number;
  };
  messageReaction?: {
    chat: {
      id: number;
      type?: string;
    };
    message_id: number;
    user?: TelegramReactionUpdateUser;
    old_reaction: readonly unknown[];
    new_reaction: readonly unknown[];
  };
}

interface TelegramWorkerStores {
  pool: Pool;
  channelCursors: ChannelCursorRepo;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  channelActions: PostgresChannelActionStore;
  connectorLeases: PostgresConnectorLeaseRepo;
  requests: RuntimeRequestRepo;
  mediaStore: FileSystemMediaStore;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function messageTextLength(message: TelegramContext["msg"] | undefined): number {
  const text = message?.text ?? message?.caption ?? "";
  return text.trim().length;
}

function isTelegramEmojiReaction(value: unknown): value is TelegramEmojiReaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.type === "emoji" && typeof candidate.emoji === "string" && candidate.emoji.trim().length > 0;
}

function parseTelegramMessageId(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid Telegram message id ${value}.`);
  }

  return parsed;
}

function readTelegramSentAtMs(message: TelegramContext["msg"] | undefined): number | undefined {
  if (!message || typeof message.date !== "number" || !Number.isFinite(message.date) || message.date <= 0) {
    return undefined;
  }

  return message.date * 1_000;
}

export class TelegramService {
  private readonly bot: Bot<TelegramContext>;
  private readonly token: string;
  private readonly options: Omit<TelegramServiceOptions, "token">;
  private storesPromise: Promise<TelegramWorkerStores> | null = null;
  private stores: TelegramWorkerStores | null = null;
  private botId: string | null = null;
  private connectorKey: string | null = null;
  private botUsername: string | null = null;
  private lease: ManagedConnectorLease | null = null;
  private notificationListener: PostgresNotificationListenerHandle | null = null;
  private pollAbortController: AbortController | null = null;
  private outboundWorker: ChannelOutboundDeliveryWorker | null = null;
  private actionWorker: ChannelActionWorker | null = null;
  private poolObserver: PostgresPoolObserver | null = null;
  private healthServer: HealthServer | null = null;
  private healthInitialized = false;
  private healthLockHeld = false;
  private healthListenersActive = false;
  private lastPollActivityAt = 0;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(options: TelegramServiceOptions) {
    this.token = options.token;
    this.options = {
      dataDir: options.dataDir,
      dbUrl: options.dbUrl,
    };
    this.bot = new Bot<TelegramContext>(options.token);

    this.bot.on("message", async (ctx) => {
      await this.handleMessage(ctx);
    });
    this.bot.on("message_reaction", async (ctx) => {
      await this.handleMessageReaction(ctx as TelegramReactionContextLike);
    });
  }

  private log(event: string, payload: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({
      source: TELEGRAM_SOURCE,
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    })}\n`);
  }

  private async ensureBotIdentity(): Promise<{
    id: string;
    connectorKey: string;
    botUsername: string | null;
  }> {
    if (this.botId && this.connectorKey) {
      return {
        id: this.botId,
        connectorKey: this.connectorKey,
        botUsername: this.botUsername,
      };
    }

    const me = await this.bot.api.getMe();
    this.bot.botInfo = me;
    const id = String(me.id);
    this.botId = id;
    this.connectorKey = id;
    this.botUsername = me.username ?? null;

    return {
      id,
      connectorKey: id,
      botUsername: this.botUsername,
    };
  }

  private async ensureStores(connectorKey: string): Promise<TelegramWorkerStores> {
    if (this.stores) {
      return this.stores;
    }

    if (!this.storesPromise) {
      this.storesPromise = (async () => {
        const poolConfig = buildObservedPoolConfig(
          `panda/telegram/${connectorKey}`,
          "PANDA_TELEGRAM_DB_POOL_MAX",
          TELEGRAM_POOL_MAX_FALLBACK,
        );
        const pool = createPostgresPool({
          connectionString: requireDatabaseUrl(this.options.dbUrl),
          applicationName: poolConfig.applicationName,
          max: poolConfig.max,
          idleTimeoutMillis: poolConfig.idleTimeoutMillis,
        });
        const poolObserver = observePostgresPool({
          pool,
          applicationName: poolConfig.applicationName,
          max: poolConfig.max,
          idleTimeoutMillis: poolConfig.idleTimeoutMillis,
          waitingLogIntervalMs: poolConfig.waitingLogIntervalMs,
          log: (event, payload) => this.log(event, {
            connectorKey,
            ...payload,
          }),
        });
        const channelCursors = new ChannelCursorRepo({
          pool,
        });
        const outboundDeliveries = new PostgresOutboundDeliveryStore({
          pool,
        });
        const channelActions = new PostgresChannelActionStore({
          pool,
        });
        const connectorLeases = new PostgresConnectorLeaseRepo({
          pool,
        });
        const requests = new RuntimeRequestRepo({
          pool,
        });
        try {
          await ensureSchemas([
            channelCursors,
            outboundDeliveries,
            channelActions,
            connectorLeases,
            requests,
          ]);
          this.poolObserver = poolObserver;
          this.log("postgres_pool_ready", {
            connectorKey,
            applicationName: poolConfig.applicationName,
            max: poolConfig.max,
            idleTimeoutMillis: poolConfig.idleTimeoutMillis,
          });

          return {
            pool,
            channelCursors,
            outboundDeliveries,
            channelActions,
            connectorLeases,
            requests,
            mediaStore: new FileSystemMediaStore({
              rootDir: this.options.dataDir,
            }),
          };
        } catch (error) {
          poolObserver.stop();
          await pool.end().catch(() => undefined);
          throw error;
        }
      })();
    }

    this.stores = await this.storesPromise;
    return this.stores;
  }

  private ensureOutboundWorker(stores: TelegramWorkerStores, connectorKey: string): ChannelOutboundDeliveryWorker {
    if (this.outboundWorker) {
      return this.outboundWorker;
    }

    this.outboundWorker = new ChannelOutboundDeliveryWorker({
      store: stores.outboundDeliveries,
      adapter: createTelegramOutboundAdapter({
        api: this.bot.api,
        connectorKey,
      }),
      connectorKey,
      onError: (error, deliveryId) => {
        this.log("outbound_delivery_failed", {
          connectorKey,
          deliveryId: deliveryId ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });

    return this.outboundWorker;
  }

  private ensureActionWorker(stores: TelegramWorkerStores, connectorKey: string): ChannelActionWorker {
    if (this.actionWorker) {
      return this.actionWorker;
    }

    const typingAdapter = createTelegramTypingAdapter({
      api: this.bot.api,
      connectorKey,
    });

    this.actionWorker = new ChannelActionWorker({
      store: stores.channelActions,
      lookup: {
        channel: TELEGRAM_SOURCE,
        connectorKey,
      },
      dispatch: async (action) => {
        switch (action.kind) {
          case "typing":
            await typingAdapter.send(action.payload as Parameters<typeof typingAdapter.send>[0]);
            return;
          case "telegram_reaction":
            await this.sendReactionAction(action.payload as TelegramReactionActionPayload);
            return;
          default:
            throw new Error(`Unsupported Telegram channel action ${action.kind}.`);
        }
      },
      onError: (error, actionId) => {
        this.log("channel_action_failed", {
          connectorKey,
          actionId: actionId ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });

    return this.actionWorker;
  }

  private async startWorkerNotificationListener(
    stores: TelegramWorkerStores,
    connectorKey: string,
  ): Promise<PostgresNotificationListenerHandle> {
    const outboundWorker = this.ensureOutboundWorker(stores, connectorKey);
    const actionWorker = this.ensureActionWorker(stores, connectorKey);

    return startPostgresNotificationListener({
      pool: stores.pool,
      onActionNotification: async (notification) => {
        if (notification.channel !== TELEGRAM_SOURCE || notification.connectorKey !== connectorKey) {
          return;
        }

        await actionWorker.triggerDrain();
      },
      onDeliveryNotification: async (notification) => {
        if (notification.channel !== TELEGRAM_SOURCE || notification.connectorKey !== connectorKey) {
          return;
        }

        await outboundWorker.triggerDrain();
      },
      onError: async (error) => {
        this.log("worker_notification_listener_failed", {
          connectorKey,
          message: error instanceof Error ? error.message : String(error),
        });
        this.healthListenersActive = false;
        await this.stop();
      },
    });
  }

  private async acquireConnectorLease(
    connectorKey: string,
    stores: TelegramWorkerStores,
  ): Promise<ManagedConnectorLease> {
    return acquireManagedConnectorLease({
      repo: stores.connectorLeases,
      source: TELEGRAM_SOURCE,
      connectorKey,
      alreadyHeldMessage: `Telegram connector ${connectorKey} is already running.`,
      onError: async (error) => {
        this.log("connector_lease_renew_failed", {
          connectorKey,
          message: error instanceof Error ? error.message : String(error),
        });
      },
      onLeaseLost: async (error) => {
        this.log("connector_lease_lost", {
          connectorKey,
          message: error.message,
        });
        this.healthLockHeld = false;
        await this.stop();
      },
    });
  }

  private async ensureInitialized(): Promise<{
    stores: TelegramWorkerStores;
    connectorKey: string;
    botUsername: string | null;
  }> {
    const {connectorKey, botUsername} = await this.ensureBotIdentity();
    const stores = await this.ensureStores(connectorKey);
    return {
      stores,
      connectorKey,
      botUsername,
    };
  }

  async whoami(): Promise<{
    connectorKey: string;
    id: string;
    username?: string;
  }> {
    const {connectorKey, id, botUsername} = await this.ensureBotIdentity();
    return {
      connectorKey,
      id,
      username: botUsername ?? undefined,
    };
  }

  async run(): Promise<void> {
    this.stopping = false;
    this.stopPromise = null;

    try {
      const {stores, connectorKey, botUsername} = await this.ensureInitialized();
      this.healthServer = await (async () => {
        const binding = resolveOptionalHealthServerBinding({
          hostEnvKey: "PANDA_TELEGRAM_HEALTH_HOST",
          portEnvKey: "PANDA_TELEGRAM_HEALTH_PORT",
        });
        if (!binding) {
          return null;
        }

        return startHealthServer({
          ...binding,
          getSnapshot: () => ({
            ok: this.healthInitialized
              && this.healthLockHeld
              && this.healthListenersActive
              && !this.stopping
              && (Date.now() - this.lastPollActivityAt) <= TELEGRAM_HEALTH_POLL_STALE_AFTER_MS,
            connectorKey,
            initialized: this.healthInitialized,
            lockHeld: this.healthLockHeld,
            listenersActive: this.healthListenersActive,
            stopping: this.stopping,
            lastPollActivityAt: this.lastPollActivityAt || null,
          }),
        });
      })();
      this.healthInitialized = true;
      this.lease = await this.acquireConnectorLease(connectorKey, stores);
      this.healthLockHeld = true;
      await this.ensureOutboundWorker(stores, connectorKey).start({
        subscribeToNotifications: false,
      });
      await this.ensureActionWorker(stores, connectorKey).start({
        subscribeToNotifications: false,
      });
      this.notificationListener = await this.startWorkerNotificationListener(stores, connectorKey);
      this.healthListenersActive = true;
      await this.bot.api.setMyCommands([
        {command: "start", description: "Pair this Telegram account with Panda"},
        {command: "reset", description: "Reset Panda to a fresh empty session"},
      ]);
      this.log("run_started", {
        connectorKey,
        botUsername,
        dataDir: this.options.dataDir,
      });

      while (!this.stopping) {
        const nextOffset = await this.readNextUpdateOffset(stores, connectorKey);
        this.pollAbortController = new AbortController();
        this.lastPollActivityAt = Date.now();

        let updates;
        try {
          updates = await this.bot.api.getUpdates({
            offset: nextOffset,
            timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
            allowed_updates: ["message", "message_reaction"],
          }, this.pollAbortController.signal);
        } catch (error) {
          if (this.stopping && isAbortError(error)) {
            break;
          }

          if (isAbortError(error)) {
            continue;
          }

          this.log("poll_error", {
            connectorKey,
            message: error instanceof Error ? error.message : String(error),
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        } finally {
          this.pollAbortController = null;
        }
        this.lastPollActivityAt = Date.now();

        if (updates.length > 0) {
          this.log("updates_received", {
            connectorKey,
            count: updates.length,
            firstUpdateId: updates[0]?.update_id ?? null,
            lastUpdateId: updates.at(-1)?.update_id ?? null,
          });
        }

        for (const update of updates) {
          if (this.stopping) {
            break;
          }

          try {
            await this.bot.handleUpdate(update);
            await stores.channelCursors.upsertChannelCursor({
              source: TELEGRAM_SOURCE,
              connectorKey,
              cursorKey: TELEGRAM_UPDATES_CURSOR_KEY,
              value: String(update.update_id),
            });
          } catch (error) {
            this.log("update_error", {
              connectorKey,
              updateId: update.update_id,
              message: error instanceof Error ? error.message : String(error),
            });

            if (!this.stopping) {
              await new Promise((resolve) => setTimeout(resolve, UPDATE_RETRY_DELAY_MS));
            }
            break;
          }
        }
      }
    } finally {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopping = true;
    this.healthListenersActive = false;
    this.healthLockHeld = false;
    this.healthInitialized = false;
    this.pollAbortController?.abort();
    this.pollAbortController = null;
    this.stopPromise = (async () => {
      const notificationListener = this.notificationListener;
      const actionWorker = this.actionWorker;
      const outboundWorker = this.outboundWorker;
      const lease = this.lease;
      this.notificationListener = null;
      this.actionWorker = null;
      this.outboundWorker = null;
      this.lease = null;

      const stores = this.stores;
      const storesPromise = this.storesPromise;
      const poolObserver = this.poolObserver;
      const healthServer = this.healthServer;
      this.stores = null;
      this.storesPromise = null;
      this.poolObserver = null;
      this.healthServer = null;

      await runCleanupSteps([
        {
          label: "notification-listener",
          run: async () => {
            await notificationListener?.close();
          },
        },
        {
          label: "action-worker",
          run: async () => {
            await actionWorker?.stop();
          },
        },
        {
          label: "outbound-worker",
          run: async () => {
            await outboundWorker?.stop();
          },
        },
        {
          label: "connector-lease",
          run: async () => {
            await lease?.release();
          },
        },
        {
          label: "pool-observer",
          run: () => {
            poolObserver?.stop();
          },
        },
        {
          label: "pool",
          run: async () => {
            if (stores) {
              await stores.pool.end();
              return;
            }

            if (!storesPromise) {
              return;
            }

            try {
              const resolvedStores = await storesPromise;
              await resolvedStores.pool.end();
            } catch {
              // Ignore bootstrap failures during shutdown.
            }
          },
        },
        {
          label: "health-server",
          run: async () => {
            await healthServer?.close();
          },
        },
      ], (step, error) => {
        this.log("shutdown_cleanup_failed", {
          connectorKey: this.connectorKey ?? null,
          step: step.label,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    })();

    return this.stopPromise;
  }

  private async readNextUpdateOffset(stores: TelegramWorkerStores, connectorKey: string): Promise<number | undefined> {
    const cursor = await stores.channelCursors.resolveChannelCursor({
      source: TELEGRAM_SOURCE,
      connectorKey,
      cursorKey: TELEGRAM_UPDATES_CURSOR_KEY,
    });
    if (!cursor) {
      return undefined;
    }

    const parsed = Number.parseInt(cursor.value, 10);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }

    return parsed + 1;
  }

  private async sendReactionAction(payload: TelegramReactionActionPayload): Promise<void> {
    const route = parseTelegramConversationId(payload.conversationId);
    const reactions = (payload.remove
      ? []
      : [{type: "emoji" as const, emoji: payload.emoji ?? ""}]) as Parameters<typeof this.bot.api.setMessageReaction>[2];
    await this.bot.api.setMessageReaction(
      route.chatId,
      parseTelegramMessageId(payload.messageId),
      reactions,
    );
  }

  private async handleMessageReaction(ctx: TelegramReactionContextLike): Promise<void> {
    const {stores, connectorKey} = await this.ensureInitialized();
    const reaction = ctx.messageReaction;
    const chatId = reaction?.chat.id;
    const chatType = reaction?.chat.type ?? null;
    const updateId = ctx.update?.update_id;
    const actorId = reaction?.user?.id != null ? String(reaction.user.id) : null;
    const externalConversationId = buildTelegramConversationId(
      String(chatId ?? "unknown"),
    );

    if (!reaction || typeof chatId !== "number") {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "missing_reaction_payload",
      });
      return;
    }

    if (chatType !== "private") {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "group_support_not_enabled",
      });
      return;
    }

    if (typeof updateId !== "number" || !Number.isInteger(updateId)) {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "missing_update_id",
      });
      return;
    }

    if (!actorId) {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "missing_actor",
      });
      return;
    }

    if (reaction.user?.is_bot) {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "bot_actor",
      });
      return;
    }

    const oldEmojis = new Set(
      reaction.old_reaction
        .filter(isTelegramEmojiReaction)
        .map((entry) => entry.emoji.trim()),
    );
    const addedEmojis = reaction.new_reaction
      .filter(isTelegramEmojiReaction)
      .map((entry) => entry.emoji.trim())
      .filter((emoji) => emoji && !oldEmojis.has(emoji));

    if (addedEmojis.length === 0) {
      return;
    }

    const request = await stores.requests.enqueueRequest({
      kind: "telegram_reaction",
      payload: {
        connectorKey,
        externalConversationId,
        chatId: String(chatId),
        chatType: chatType ?? "private",
        externalActorId: actorId,
        updateId,
        targetMessageId: String(reaction.message_id),
        addedEmojis,
        username: reaction.user?.username,
        firstName: reaction.user?.first_name,
        lastName: reaction.user?.last_name,
      },
    });

    this.log("reaction_ingested", {
      connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      updateId,
      requestId: request.id,
      targetMessageId: String(reaction.message_id),
      addedEmojis,
    });
  }

  private async handleMessage(ctx: TelegramContext): Promise<void> {
    const {stores, connectorKey, botUsername} = await this.ensureInitialized();
    const message = ctx.msg;
    const chatType = ctx.chat?.type ?? null;
    const actorId = ctx.from?.id ? String(ctx.from.id) : null;
    const externalConversationId = buildTelegramConversationId(
      String(ctx.chat?.id ?? "unknown"),
      message && "message_thread_id" in message && typeof message.message_thread_id === "number"
        ? String(message.message_thread_id)
        : undefined,
    );

    if (chatType !== "private") {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "group_support_not_enabled",
      });
      return;
    }

    if (!message || !actorId) {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "missing_actor_or_message",
      });
      return;
    }

    const media = await this.downloadSupportedMedia(message, stores);
    const rawText = (message.text ?? message.caption)?.trim() ?? "";
    if (!rawText && media.length === 0) {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "unsupported_message_shape",
      });
      return;
    }

    const request = await stores.requests.enqueueRequest({
      kind: "telegram_message",
      payload: {
        connectorKey,
        botUsername,
        sentAt: readTelegramSentAtMs(message),
        externalConversationId,
        chatId: String(message.chat.id),
        chatType: chatType ?? "private",
        externalActorId: actorId,
        externalMessageId: String(message.message_id),
        text: rawText,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        lastName: ctx.from?.last_name,
        replyToMessageId: message.reply_to_message?.message_id
          ? String(message.reply_to_message.message_id)
          : undefined,
        media,
      },
    });

    this.log("message_ingested", {
      connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      externalMessageId: String(message.message_id),
      mediaCount: media.length,
      textLength: messageTextLength(message),
      requestId: request.id,
    });
  }

  private async downloadSupportedMedia(
    message: TelegramContext["msg"],
    stores: TelegramWorkerStores,
  ): Promise<readonly MediaDescriptor[]> {
    if (!message) {
      return [];
    }

    const descriptors: MediaDescriptor[] = [];

    const photo = message.photo?.at(-1);
    if (photo) {
      descriptors.push(await this.downloadFile({
        stores,
        fileId: photo.file_id,
        mimeType: "image/jpeg",
        sizeBytes: photo.file_size,
      }));
    }

    if (message.document) {
      descriptors.push(await this.downloadFile({
        stores,
        fileId: message.document.file_id,
        mimeType: message.document.mime_type ?? "application/octet-stream",
        sizeBytes: message.document.file_size,
        hintFilename: message.document.file_name,
      }));
    }

    if (message.voice) {
      descriptors.push(await this.downloadFile({
        stores,
        fileId: message.voice.file_id,
        mimeType: message.voice.mime_type ?? "audio/ogg",
        sizeBytes: message.voice.file_size,
      }));
    }

    return descriptors;
  }

  private async downloadFile(options: {
    stores: TelegramWorkerStores;
    fileId: string;
    mimeType: string;
    sizeBytes?: number;
    hintFilename?: string;
  }): Promise<MediaDescriptor> {
    const file = await this.bot.api.getFile(options.fileId);
    if (!file.file_path) {
      throw new Error(`Telegram file ${options.fileId} has no file_path.`);
    }

    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file ${options.fileId}: ${response.status} ${response.statusText}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return options.stores.mediaStore.writeMedia({
      bytes,
      source: TELEGRAM_SOURCE,
      connectorKey: this.connectorKey ?? "unknown",
      mimeType: options.mimeType,
      sizeBytes: options.sizeBytes,
      hintFilename: options.hintFilename,
      metadata: {
        telegramFileId: options.fileId,
        telegramFilePath: file.file_path,
      },
    });
  }
}
