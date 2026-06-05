import {AbortController} from "abort-controller";
import {Bot, type Context} from "grammy";
import type {Pool} from "pg";

import {type HealthServer, resolveOptionalHealthServerBinding, startHealthServer} from "../../../lib/health-server.js";
import {ChannelActionWorker} from "../../../domain/channels/actions/worker.js";
import type {TelegramReactionActionPayload} from "../../../domain/channels/actions/types.js";
import {ChannelCursorRepo} from "../../../domain/channels/cursors/repo.js";
import {
  acquireManagedConnectorLease,
  type ManagedConnectorLease,
  PostgresConnectorLeaseRepo
} from "../../../domain/connector-leases/repo.js";
import {FileSystemMediaStore} from "../../../domain/channels/media-store.js";
import {PostgresOutboundDeliveryStore} from "../../../domain/channels/deliveries/postgres.js";
import {ChannelOutboundDeliveryWorker} from "../../../domain/channels/deliveries/worker.js";
import {
  buildObservedPoolConfig,
  createPostgresPool,
  observePostgresPool,
  type PostgresPoolObserver,
  requireDatabaseUrl,
} from "../../../lib/postgres-database.js";
import {ensureSchemas} from "../../../lib/postgres-bootstrap.js";
import {RuntimeRequestRepo} from "../../../domain/threads/requests/repo.js";
import {TELEGRAM_POLL_TIMEOUT_SECONDS, TELEGRAM_SOURCE, TELEGRAM_UPDATES_CURSOR_KEY} from "./config.js";
import {createTelegramOutboundAdapter} from "./outbound.js";
import {parseTelegramConversationId} from "./conversation-id.js";
import {createTelegramTypingAdapter} from "./typing.js";
import {PostgresChannelActionStore} from "../../../domain/channels/actions/postgres.js";
import {runCleanupSteps} from "../../../lib/cleanup.js";
import {sleep} from "../../../lib/async.js";
import type {PostgresListenSnapshot} from "../../../lib/postgres-listen.js";
import {
  createConnectorOutboundWorker,
  startConnectorWorkerRuntime,
  startConnectorWorkerNotificationListener,
  stopConnectorWorkerRuntime,
  type ConnectorWorkerRuntimeHandle,
} from "../worker-runtime.js";
import {parseTelegramReactionMessageId} from "./reactions.js";
import {
  isAbortError,
  downloadTelegramSupportedMedia,
  type TelegramMediaDownloadResult,
} from "./media.js";
import {
  ingestTelegramMessage,
  ingestTelegramMessageReaction,
  type TelegramReactionContextLike,
} from "./message-ingestion.js";

type TelegramContext = Context;
const UPDATE_RETRY_DELAY_MS = 1_000;
const TELEGRAM_POOL_MAX_FALLBACK = 5;
const TELEGRAM_HEALTH_POLL_STALE_AFTER_MS = (TELEGRAM_POLL_TIMEOUT_SECONDS * 1_000) + 15_000;

export interface TelegramServiceOptions {
  token: string;
  dataDir: string;
  dbUrl?: string;
  accountKey?: string;
  disableHealthServer?: boolean;
  expectedConnectorKey?: string;
  poolMaxFallback?: number;
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

function rejectUnsupportedTelegramAction(_action: never): never {
  throw new Error("Unsupported Telegram channel action.");
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
  private pollAbortController: AbortController | null = null;
  private workerRuntime: ConnectorWorkerRuntimeHandle<ChannelOutboundDeliveryWorker, ChannelActionWorker> | null = null;
  private poolObserver: PostgresPoolObserver | null = null;
  private healthServer: HealthServer | null = null;
  private healthInitialized = false;
  private healthLockHeld = false;
  private healthListenersActive = false;
  private healthListenerSnapshot: PostgresListenSnapshot | null = null;
  private lastPollActivityAt = 0;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(options: TelegramServiceOptions) {
    this.token = options.token;
    this.options = {
      dataDir: options.dataDir,
      dbUrl: options.dbUrl,
      accountKey: options.accountKey,
      disableHealthServer: options.disableHealthServer,
      expectedConnectorKey: options.expectedConnectorKey,
      poolMaxFallback: options.poolMaxFallback,
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
    if (this.options.expectedConnectorKey && this.options.expectedConnectorKey !== id) {
      throw new Error("Telegram bot token identity does not match the connector account.");
    }

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
          `panda/telegram/${this.options.accountKey ?? connectorKey}`,
          "PANDA_TELEGRAM_DB_POOL_MAX",
          this.options.poolMaxFallback ?? TELEGRAM_POOL_MAX_FALLBACK,
        );
        const pool = createPostgresPool({
          connectionString: requireDatabaseUrl(this.options.dbUrl),
          applicationName: poolConfig.applicationName,
          max: poolConfig.max,
          idleTimeoutMillis: poolConfig.idleTimeoutMillis,
          connectionTimeoutMillis: poolConfig.acquireTimeoutMillis,
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

  private createOutboundWorker(stores: TelegramWorkerStores, connectorKey: string): ChannelOutboundDeliveryWorker {
    return createConnectorOutboundWorker({
      store: stores.outboundDeliveries,
      adapter: createTelegramOutboundAdapter({
        api: this.bot.api,
        connectorKey,
      }),
      connectorKey,
      log: (event, payload) => this.log(event, payload),
    });
  }

  private createActionWorker(stores: TelegramWorkerStores, connectorKey: string): ChannelActionWorker {
    const typingAdapter = createTelegramTypingAdapter({
      api: this.bot.api,
      connectorKey,
    });

    return new ChannelActionWorker({
      store: stores.channelActions,
      lookup: {
        channel: TELEGRAM_SOURCE,
        connectorKey,
      },
      dispatch: async (action) => {
        switch (action.kind) {
          case "typing":
            await typingAdapter.send(action.payload);
            return;
          case "telegram_reaction":
            await this.sendReactionAction(action.payload);
            return;
          default:
            rejectUnsupportedTelegramAction(action);
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
  }

  private async startWorkerNotificationListener(
    stores: TelegramWorkerStores,
    connectorKey: string,
    workers: {
      actionWorker: ChannelActionWorker;
      outboundWorker: ChannelOutboundDeliveryWorker;
    },
  ) {
    return startConnectorWorkerNotificationListener({
      pool: stores.pool,
      source: TELEGRAM_SOURCE,
      connectorKey,
      actionWorker: workers.actionWorker,
      outboundWorker: workers.outboundWorker,
      log: (event, payload) => this.log(event, payload),
      onListenerStateChange: (snapshot) => {
        this.healthListenerSnapshot = snapshot;
        this.healthListenersActive = snapshot.listening;
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

  async start(): Promise<void> {
    if (this.workerRuntime) {
      return;
    }

    this.stopping = false;
    this.stopPromise = null;
    this.healthListenerSnapshot = null;

    const {stores, connectorKey, botUsername} = await this.ensureInitialized();
    this.healthServer = await (async () => {
      if (this.options.disableHealthServer) {
        return null;
      }
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
          listenerStatus: this.healthListenerSnapshot?.status ?? null,
          listenerLastErrorAt: this.healthListenerSnapshot?.lastErrorAt ?? null,
          listenerLastError: this.healthListenerSnapshot?.lastError ?? null,
          stopping: this.stopping,
          lastPollActivityAt: this.lastPollActivityAt || null,
        }),
      });
    })();
    this.healthInitialized = true;
    const outboundWorker = this.createOutboundWorker(stores, connectorKey);
    const actionWorker = this.createActionWorker(stores, connectorKey);
    this.workerRuntime = await startConnectorWorkerRuntime({
      acquireLease: () => this.acquireConnectorLease(connectorKey, stores),
      outboundWorker,
      actionWorker,
      startNotificationListener: () => this.startWorkerNotificationListener(stores, connectorKey, {
        outboundWorker,
        actionWorker,
      }),
      onCleanupError: (step, error) => {
        this.log("shutdown_cleanup_failed", {
          connectorKey: this.connectorKey ?? connectorKey,
          step: step.label,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    this.healthLockHeld = true;
    this.healthListenerSnapshot = this.workerRuntime.notificationListener?.getSnapshot?.() ?? this.healthListenerSnapshot;
    this.healthListenersActive = this.healthListenerSnapshot?.listening ?? true;
    await this.bot.api.setMyCommands([
      {command: "start", description: "Pair this Telegram account with Panda"},
      {command: "reset", description: "Reset Panda to a fresh empty session"},
    ]);
    this.log("run_started", {
      connectorKey,
      botUsername,
      dataDir: this.options.dataDir,
    });
  }

  async run(): Promise<void> {
    try {
      await this.start();
      const {stores, connectorKey} = await this.ensureInitialized();

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
          await sleep(1000);
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
              await sleep(UPDATE_RETRY_DELAY_MS);
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
    this.healthListenerSnapshot = this.healthListenerSnapshot
      ? {
        ...this.healthListenerSnapshot,
        status: "closed",
        listening: false,
      }
      : null;
    this.healthLockHeld = false;
    this.healthInitialized = false;
    this.pollAbortController?.abort();
    this.pollAbortController = null;
    this.stopPromise = (async () => {
      const workerRuntime = this.workerRuntime;
      this.workerRuntime = null;

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
          label: "connector-workers",
          run: async () => {
            await stopConnectorWorkerRuntime(workerRuntime, (step, error) => {
              this.log("shutdown_cleanup_failed", {
                connectorKey: this.connectorKey ?? null,
                step: step.label,
                message: error instanceof Error ? error.message : String(error),
              });
            });
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
      parseTelegramReactionMessageId(payload.messageId),
      reactions,
    );
  }

  private async handleMessageReaction(ctx: TelegramReactionContextLike): Promise<void> {
    const {stores, connectorKey} = await this.ensureInitialized();
    await ingestTelegramMessageReaction(ctx, {
      connectorKey,
      requests: stores.requests,
      log: (event, payload) => this.log(event, payload),
    });
  }

  private async handleMessage(ctx: TelegramContext): Promise<void> {
    const {stores, connectorKey, botUsername} = await this.ensureInitialized();
    await ingestTelegramMessage(ctx, {
      connectorKey,
      botUsername,
      requests: stores.requests,
      downloadMedia: async (message) => {
        return this.downloadSupportedMedia(message, stores, connectorKey);
      },
      log: (event, payload) => this.log(event, payload),
    });
  }

  private async downloadSupportedMedia(
    message: TelegramContext["msg"],
    stores: TelegramWorkerStores,
    connectorKey: string,
  ): Promise<TelegramMediaDownloadResult> {
    return downloadTelegramSupportedMedia(message, {
      api: this.bot.api,
      token: this.token,
      connectorKey,
      mediaStore: stores.mediaStore,
      onUnavailable: (item) => {
        this.log("media_download_skipped", {
          connectorKey,
          kind: item.kind,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes ?? null,
          filename: item.filename ?? null,
          reason: item.reason,
        });
      },
    });
  }
}
