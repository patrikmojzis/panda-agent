import type {Pool} from "pg";
import {
    addTransactionCapability,
    type AuthenticationState,
    type BaileysEventMap,
    Browsers,
    type ConnectionState,
    DisconnectReason,
    isJidBroadcast,
    isJidGroup,
    isJidNewsletter,
    isJidStatusBroadcast,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    makeWASocket,
    type WAMessage,
    type WASocket,
} from "baileys";
import {downloadMediaMessage, normalizeMessageContent} from "baileys/lib/Utils/messages.js";

import {type HealthServer, resolveOptionalHealthServerBinding, startHealthServer} from "../../../app/health/server.js";
import {ChannelActionWorker} from "../../../domain/channels/actions/index.js";
import {
    acquireManagedConnectorLease,
    type ManagedConnectorLease,
    PostgresConnectorLeaseRepo
} from "../../../domain/connector-leases/index.js";
import {FileSystemMediaStore, type MediaDescriptor} from "../../../domain/channels/index.js";
import {
    buildObservedPoolConfig,
    createPostgresPool,
    observePostgresPool,
    type PostgresPoolObserver,
    requireDatabaseUrl,
} from "../../../app/runtime/database.js";
import {ensureSchemas} from "../../../app/runtime/postgres-bootstrap.js";
import {RuntimeRequestRepo} from "../../../domain/threads/requests/index.js";
import {PostgresChannelActionStore} from "../../../domain/channels/actions/postgres.js";
import {
    ChannelOutboundDeliveryWorker,
    PostgresOutboundDeliveryStore
} from "../../../domain/channels/deliveries/index.js";
import {WHATSAPP_SOURCE} from "./config.js";
import {PostgresWhatsAppAuthStore} from "./auth-store.js";
import {extractWhatsAppMessageText, extractWhatsAppQuotedMessageId} from "./helpers.js";
import {createWhatsAppOutboundAdapter} from "./outbound.js";
import {createWhatsAppTypingAdapter} from "./typing.js";
import {
    type PostgresNotificationListenerHandle,
    startPostgresNotificationListener,
} from "../postgres-notification-listener.js";
import {sleep} from "../../../lib/async.js";
import {runCleanupSteps} from "../../../lib/cleanup.js";

export interface WhatsAppServiceOptions {
  connectorKey: string;
  dataDir: string;
  dbUrl?: string;
}

interface WhatsAppLoggerLike {
  level: string;
  child(obj: Record<string, unknown>): WhatsAppLoggerLike;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const WHATSAPP_LOGGER: WhatsAppLoggerLike = {
  level: "silent",
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const TRANSACTION_OPTIONS = {
  maxCommitRetries: 5,
  delayBetweenTriesMs: 200,
} as const;
const RECONNECT_DELAY_MS = 1_000;
const WHATSAPP_POOL_MAX_FALLBACK = 5;
const WHATSAPP_HEALTH_RECONNECT_GRACE_MS = 30_000;

interface WhatsAppWorkerStores {
  pool: Pool;
  authStore: PostgresWhatsAppAuthStore;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  channelActions: PostgresChannelActionStore;
  connectorLeases: PostgresConnectorLeaseRepo;
  requests: RuntimeRequestRepo;
  mediaStore: FileSystemMediaStore;
}

export interface WhatsAppWhoamiResult {
  connectorKey: string;
  registered: boolean;
  accountId?: string;
  phoneNumber?: string;
  name?: string;
}

export interface WhatsAppPairResult extends WhatsAppWhoamiResult {
  pairingCode?: string;
  alreadyPaired: boolean;
}

type WhatsAppSocketHealthState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "stopped";

function describeAccountId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toWhoamiResult(connectorKey: string, creds: AuthenticationState["creds"]): WhatsAppWhoamiResult {
  const accountId = describeAccountId(creds.me?.id);
  return {
    connectorKey,
    registered: creds.registered,
    accountId,
    phoneNumber: creds.me?.phoneNumber?.trim() || undefined,
    name: creds.me?.name?.trim() || creds.me?.notify?.trim() || undefined,
  };
}

function extractDisconnectStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  if ("output" in error && error.output && typeof error.output === "object") {
    const output = error.output as {statusCode?: unknown};
    if (typeof output.statusCode === "number") {
      return output.statusCode;
    }
  }

  if ("statusCode" in error && typeof (error as {statusCode?: unknown}).statusCode === "number") {
    return (error as {statusCode: number}).statusCode;
  }

  return null;
}

function shouldReconnect(statusCode: number | null): boolean {
  switch (statusCode) {
    case DisconnectReason.connectionClosed:
    case DisconnectReason.connectionLost:
    case DisconnectReason.timedOut:
    case DisconnectReason.restartRequired:
    case DisconnectReason.unavailableService:
      return true;
    default:
      return false;
  }
}

function describeDisconnectStatus(statusCode: number | null): string {
  if (statusCode === null) {
    return "unknown";
  }

  return DisconnectReason[statusCode] ?? String(statusCode);
}

function resolveChatType(remoteJid: string | undefined): "private" | "group" | "status" | "newsletter" | "broadcast" | "unknown" {
  if (!remoteJid) {
    return "unknown";
  }

  if (isJidStatusBroadcast(remoteJid)) {
    return "status";
  }
  if (isJidGroup(remoteJid)) {
    return "group";
  }
  if (isJidNewsletter(remoteJid)) {
    return "newsletter";
  }
  if (isJidBroadcast(remoteJid)) {
    return "broadcast";
  }

  return "private";
}

function extractMessageTextLength(message: WAMessage): number {
  return extractWhatsAppMessageText(message).length;
}

function readMediaSizeBytes(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "object" && value !== null && "toNumber" in value && typeof value.toNumber === "function") {
    const numericValue = value.toNumber();
    if (typeof numericValue === "number" && Number.isFinite(numericValue) && numericValue >= 0) {
      return numericValue;
    }
  }

  return undefined;
}

function readMessageSentAtMs(value: unknown): number | undefined {
  const seconds = (() => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }

    if (typeof value === "object" && value !== null && "toNumber" in value && typeof value.toNumber === "function") {
      const numericValue = value.toNumber();
      if (typeof numericValue === "number" && Number.isFinite(numericValue) && numericValue > 0) {
        return numericValue;
      }
    }

    return undefined;
  })();

  return seconds === undefined ? undefined : seconds * 1_000;
}

export class WhatsAppService {
  private readonly options: WhatsAppServiceOptions;
  private pool: Pool | null = null;
  private authStore: PostgresWhatsAppAuthStore | null = null;
  private storesPromise: Promise<WhatsAppWorkerStores> | null = null;
  private stores: WhatsAppWorkerStores | null = null;
  private socket: WASocket | null = null;
  private lease: ManagedConnectorLease | null = null;
  private notificationListener: PostgresNotificationListenerHandle | null = null;
  private outboundWorker: ChannelOutboundDeliveryWorker | null = null;
  private actionWorker: ChannelActionWorker | null = null;
  private poolObserver: PostgresPoolObserver | null = null;
  private healthServer: HealthServer | null = null;
  private healthInitialized = false;
  private healthLockHeld = false;
  private healthListenersActive = false;
  private socketHealthState: WhatsAppSocketHealthState = "idle";
  private socketHealthStateAt = 0;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private socketWaiterResolve: (() => void) | null = null;

  constructor(options: WhatsAppServiceOptions) {
    this.options = options;
  }

  private log(event: string, payload: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({
      source: WHATSAPP_SOURCE,
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    })}\n`);
  }

  private async ensureAuthStore(): Promise<PostgresWhatsAppAuthStore> {
    if (this.authStore) {
      return this.authStore;
    }

    const poolConfig = buildObservedPoolConfig(
      `panda/whatsapp/${this.options.connectorKey}`,
      "PANDA_WHATSAPP_DB_POOL_MAX",
      WHATSAPP_POOL_MAX_FALLBACK,
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
        connectorKey: this.options.connectorKey,
        ...payload,
      }),
    });
    const authStore = new PostgresWhatsAppAuthStore({
      pool,
    });
    try {
      await ensureSchemas([authStore]);
    } catch (error) {
      poolObserver.stop();
      await pool.end().catch(() => undefined);
      throw error;
    }

    this.pool = pool;
    this.poolObserver = poolObserver;
    this.authStore = authStore;
    this.log("postgres_pool_ready", {
      connectorKey: this.options.connectorKey,
      applicationName: poolConfig.applicationName,
      max: poolConfig.max,
      idleTimeoutMillis: poolConfig.idleTimeoutMillis,
    });
    return authStore;
  }

  private async ensureStores(): Promise<WhatsAppWorkerStores> {
    if (this.stores) {
      return this.stores;
    }

    if (!this.storesPromise) {
      this.storesPromise = (async () => {
        const authStore = await this.ensureAuthStore();
        if (!this.pool) {
          throw new Error("WhatsApp worker stores require an initialized Postgres pool.");
        }

        const outboundDeliveries = new PostgresOutboundDeliveryStore({
          pool: this.pool,
        });
        const channelActions = new PostgresChannelActionStore({
          pool: this.pool,
        });
        const connectorLeases = new PostgresConnectorLeaseRepo({
          pool: this.pool,
        });
        const requests = new RuntimeRequestRepo({
          pool: this.pool,
        });
        await ensureSchemas([
          outboundDeliveries,
          channelActions,
          connectorLeases,
          requests,
        ]);

        return {
          pool: this.pool,
          authStore,
          outboundDeliveries,
          channelActions,
          connectorLeases,
          requests,
          mediaStore: new FileSystemMediaStore({
            rootDir: this.options.dataDir,
          }),
        };
      })();
    }

    this.stores = await this.storesPromise;
    return this.stores;
  }

  private async createSocket(): Promise<{
    authHandle: Awaited<ReturnType<PostgresWhatsAppAuthStore["createAuthState"]>>;
    socket: WASocket;
  }> {
    const authStore = await this.ensureAuthStore();
    const authHandle = await authStore.createAuthState(this.options.connectorKey);
    const socket = makeWASocket({
      auth: {
        creds: authHandle.state.creds,
        keys: addTransactionCapability(
          makeCacheableSignalKeyStore(authHandle.state.keys, WHATSAPP_LOGGER),
          WHATSAPP_LOGGER,
          TRANSACTION_OPTIONS,
        ),
      },
      logger: WHATSAPP_LOGGER,
      browser: Browsers.macOS("Panda"),
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });

    this.socket = socket;
    socket.ev.on("creds.update", async () => {
      await authHandle.saveCreds();
    });

    return {
      authHandle,
      socket,
    };
  }

  private ensureOutboundWorker(stores: WhatsAppWorkerStores): ChannelOutboundDeliveryWorker {
    if (this.outboundWorker) {
      return this.outboundWorker;
    }

    this.outboundWorker = new ChannelOutboundDeliveryWorker({
      store: stores.outboundDeliveries,
      adapter: createWhatsAppOutboundAdapter({
        connectorKey: this.options.connectorKey,
        getSocket: () => this.socket,
      }),
      connectorKey: this.options.connectorKey,
      canSend: () => this.socket !== null,
      onError: (error, deliveryId) => {
        this.log("outbound_delivery_failed", {
          connectorKey: this.options.connectorKey,
          deliveryId: deliveryId ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });

    return this.outboundWorker;
  }

  private ensureActionWorker(stores: WhatsAppWorkerStores): ChannelActionWorker {
    if (this.actionWorker) {
      return this.actionWorker;
    }

    const typingAdapter = createWhatsAppTypingAdapter({
      connectorKey: this.options.connectorKey,
      getSocket: () => this.socket,
    });

    this.actionWorker = new ChannelActionWorker({
      store: stores.channelActions,
      lookup: {
        channel: WHATSAPP_SOURCE,
        connectorKey: this.options.connectorKey,
      },
      dispatch: async (action) => {
        switch (action.kind) {
          case "typing":
            await typingAdapter.send(action.payload as Parameters<typeof typingAdapter.send>[0]);
            return;
          default:
            throw new Error(`Unsupported WhatsApp channel action ${action.kind}.`);
        }
      },
      onError: (error, actionId) => {
        this.log("channel_action_failed", {
          connectorKey: this.options.connectorKey,
          actionId: actionId ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });

    return this.actionWorker;
  }

  private async startWorkerNotificationListener(
    stores: WhatsAppWorkerStores,
  ): Promise<PostgresNotificationListenerHandle> {
    const outboundWorker = this.ensureOutboundWorker(stores);
    const actionWorker = this.ensureActionWorker(stores);

    return startPostgresNotificationListener({
      pool: stores.pool,
      onActionNotification: async (notification) => {
        if (notification.channel !== WHATSAPP_SOURCE || notification.connectorKey !== this.options.connectorKey) {
          return;
        }

        await actionWorker.triggerDrain();
      },
      onDeliveryNotification: async (notification) => {
        if (notification.channel !== WHATSAPP_SOURCE || notification.connectorKey !== this.options.connectorKey) {
          return;
        }

        await outboundWorker.triggerDrain();
      },
      onError: async (error) => {
        this.log("worker_notification_listener_failed", {
          connectorKey: this.options.connectorKey,
          message: error instanceof Error ? error.message : String(error),
        });
        this.healthListenersActive = false;
        await this.stop();
      },
    });
  }

  private async acquireConnectorLease(
    stores: WhatsAppWorkerStores,
  ): Promise<ManagedConnectorLease> {
    return acquireManagedConnectorLease({
      repo: stores.connectorLeases,
      source: WHATSAPP_SOURCE,
      connectorKey: this.options.connectorKey,
      alreadyHeldMessage: `WhatsApp connector ${this.options.connectorKey} is already running.`,
      onError: async (error) => {
        this.log("connector_lease_renew_failed", {
          connectorKey: this.options.connectorKey,
          message: error instanceof Error ? error.message : String(error),
        });
      },
      onLeaseLost: async (error) => {
        this.log("connector_lease_lost", {
          connectorKey: this.options.connectorKey,
          message: error.message,
        });
        this.healthLockHeld = false;
        await this.stop();
      },
    });
  }

  async whoami(): Promise<WhatsAppWhoamiResult> {
    const authStore = await this.ensureAuthStore();
    const creds = await authStore.loadCreds(this.options.connectorKey);
    return toWhoamiResult(this.options.connectorKey, creds);
  }

  async pair(phoneNumber: string, onPairingCode?: (code: string) => void): Promise<WhatsAppPairResult> {
    const authStore = await this.ensureAuthStore();
    const existingCreds = await authStore.loadCreds(this.options.connectorKey);
    const existingIdentity = toWhoamiResult(this.options.connectorKey, existingCreds);

    if (existingIdentity.accountId) {
      return {
        ...existingIdentity,
        alreadyPaired: true,
      };
    }

    const {authHandle, socket} = await this.createSocket();
    try {
      const pairedIdentity = await new Promise<WhatsAppWhoamiResult>(async (resolve, reject) => {
        const onConnectionUpdate = (update: Partial<ConnectionState>) => {
          if (update.connection === "open") {
            cleanup();
            resolve(toWhoamiResult(this.options.connectorKey, authHandle.state.creds));
            return;
          }

          if (update.connection === "close") {
            cleanup();
            reject(update.lastDisconnect?.error ?? new Error("WhatsApp pairing closed before login completed."));
          }
        };

        const cleanup = () => {
          socket.ev.off("connection.update", onConnectionUpdate);
        };

        socket.ev.on("connection.update", onConnectionUpdate);

        try {
          const pairingCode = await socket.requestPairingCode(phoneNumber);
          onPairingCode?.(pairingCode);
        } catch (error) {
          cleanup();
          reject(error);
        }
      });

      await authHandle.saveCreds();

      return {
        ...pairedIdentity,
        pairingCode: undefined,
        alreadyPaired: false,
      };
    } finally {
      await this.stopSocket();
    }
  }

  async run(): Promise<void> {
    this.stopping = false;
    this.stopPromise = null;
    this.socketHealthState = "idle";
    this.socketHealthStateAt = Date.now();

    try {
      const identity = await this.whoami();
      if (!identity.accountId) {
        throw new Error(
          `WhatsApp connector ${this.options.connectorKey} is not paired yet. Run \`panda whatsapp pair --phone <number>\` first.`,
        );
      }

      const stores = await this.ensureStores();
      this.healthServer = await (async () => {
        const binding = resolveOptionalHealthServerBinding({
          hostEnvKey: "PANDA_WHATSAPP_HEALTH_HOST",
          portEnvKey: "PANDA_WHATSAPP_HEALTH_PORT",
        });
        if (!binding) {
          return null;
        }

        return startHealthServer({
          ...binding,
          getSnapshot: () => {
            const socketHealthy = this.socketHealthState === "open"
              || (
                this.socketHealthState === "reconnecting"
                && (Date.now() - this.socketHealthStateAt) <= WHATSAPP_HEALTH_RECONNECT_GRACE_MS
              );

            return {
              ok: this.healthInitialized
                && this.healthLockHeld
                && this.healthListenersActive
                && socketHealthy
                && !this.stopping,
              connectorKey: this.options.connectorKey,
              initialized: this.healthInitialized,
              lockHeld: this.healthLockHeld,
              listenersActive: this.healthListenersActive,
              socketState: this.socketHealthState,
              socketStateAt: this.socketHealthStateAt || null,
              stopping: this.stopping,
            };
          },
        });
      })();
      this.healthInitialized = true;
      this.lease = await this.acquireConnectorLease(stores);
      this.healthLockHeld = true;
      await this.ensureOutboundWorker(stores).start({
        subscribeToNotifications: false,
      });
      await this.ensureActionWorker(stores).start({
        subscribeToNotifications: false,
      });
      this.notificationListener = await this.startWorkerNotificationListener(stores);
      this.healthListenersActive = true;
      this.log("run_started", {
        connectorKey: this.options.connectorKey,
        accountId: identity.accountId,
        name: identity.name ?? null,
        dataDir: this.options.dataDir,
      });

      while (!this.stopping) {
        this.socketHealthState = "connecting";
        this.socketHealthStateAt = Date.now();
        const outcome = await this.runSocketCycle(stores);
        if (!outcome.reconnect || this.stopping) {
          break;
        }

        this.socketHealthState = "reconnecting";
        this.socketHealthStateAt = Date.now();
        this.log("reconnect_scheduled", {
          connectorKey: this.options.connectorKey,
          reason: outcome.reason,
          delayMs: RECONNECT_DELAY_MS,
        });
        await sleep(RECONNECT_DELAY_MS);
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
    this.socketHealthState = "stopped";
    this.socketHealthStateAt = Date.now();
    this.stopPromise = (async () => {
      this.socketWaiterResolve?.();
      this.socketWaiterResolve = null;

      const notificationListener = this.notificationListener;
      const actionWorker = this.actionWorker;
      const outboundWorker = this.outboundWorker;
      const lease = this.lease;
      const pool = this.pool;
      const poolObserver = this.poolObserver;
      const healthServer = this.healthServer;
      this.notificationListener = null;
      this.actionWorker = null;
      this.outboundWorker = null;
      this.lease = null;
      this.pool = null;
      this.poolObserver = null;
      this.healthServer = null;
      this.authStore = null;
      this.stores = null;
      this.storesPromise = null;

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
          label: "socket",
          run: async () => {
            await this.stopSocket();
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
            await pool?.end();
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
          connectorKey: this.options.connectorKey,
          step: step.label,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    })();

    return this.stopPromise;
  }

  private async runSocketCycle(stores: WhatsAppWorkerStores): Promise<{reconnect: boolean; reason?: string}> {
    const {authHandle, socket} = await this.createSocket();

    try {
      return await new Promise<{reconnect: boolean; reason?: string}>((resolve, reject) => {
        let settled = false;

        const finish = (outcome: {reconnect: boolean; reason?: string}) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          resolve(outcome);
        };

        const fail = (error: Error) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          reject(error);
        };

        const cleanup = () => {
          socket.ev.off("connection.update", onConnectionUpdate);
          socket.ev.off("messages.upsert", onMessagesUpsert);
          socket.ev.off("messaging-history.set", onHistorySet);
          this.socketWaiterResolve = null;
        };

        const onMessagesUpsert = (update: BaileysEventMap["messages.upsert"]) => {
          void this.handleMessagesUpsert(stores, update).catch((error) => {
            this.log("upsert_error", {
              connectorKey: this.options.connectorKey,
              message: error instanceof Error ? error.message : String(error),
            });
            if (!this.stopping) {
              finish({reconnect: true, reason: "upsert_error"});
            }
          });
        };

        const onHistorySet = (update: BaileysEventMap["messaging-history.set"]) => {
          this.log("history_sync_ignored", {
            connectorKey: this.options.connectorKey,
            chatCount: update.chats.length,
            contactCount: update.contacts.length,
            messageCount: update.messages.length,
            syncType: update.syncType ?? null,
            isLatest: update.isLatest ?? null,
          });
        };

        const onConnectionUpdate = (update: Partial<ConnectionState>) => {
          if (update.connection) {
            if (update.connection === "open") {
              this.socketHealthState = "open";
              this.socketHealthStateAt = Date.now();
            } else if (update.connection === "close" && !this.stopping) {
              this.socketHealthState = "closed";
              this.socketHealthStateAt = Date.now();
            }
            this.log("connection_update", {
              connectorKey: this.options.connectorKey,
              connection: update.connection,
              receivedPendingNotifications: update.receivedPendingNotifications ?? null,
              isNewLogin: update.isNewLogin ?? null,
            });
          }

          if (update.connection === "open") {
            void this.outboundWorker?.triggerDrain();
            void this.actionWorker?.triggerDrain();
          }

          if (update.connection !== "close") {
            return;
          }

          const statusCode = extractDisconnectStatusCode(update.lastDisconnect?.error);
          const reason = describeDisconnectStatus(statusCode);

          this.log("connection_closed", {
            connectorKey: this.options.connectorKey,
            reason,
            statusCode,
            message: update.lastDisconnect?.error instanceof Error
              ? update.lastDisconnect.error.message
              : String(update.lastDisconnect?.error ?? ""),
          });

          if (this.stopping) {
            finish({reconnect: false, reason: "stopped"});
            return;
          }

          if (shouldReconnect(statusCode)) {
            finish({reconnect: true, reason});
            return;
          }

          fail(new Error(`WhatsApp connection closed permanently (${reason}).`));
        };

        this.socketWaiterResolve = () => {
          finish({reconnect: false, reason: "stopped"});
        };

        socket.ev.on("connection.update", onConnectionUpdate);
        socket.ev.on("messages.upsert", onMessagesUpsert);
        socket.ev.on("messaging-history.set", onHistorySet);
        authHandle.saveCreds().catch((error) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      });
    } finally {
      await this.stopSocket();
    }
  }

  private async stopSocket(): Promise<void> {
    if (!this.socket) {
      return;
    }

    const socket = this.socket;
    this.socket = null;
    socket.end(undefined);
  }

  private async handleMessagesUpsert(
    stores: WhatsAppWorkerStores,
    update: BaileysEventMap["messages.upsert"],
  ): Promise<void> {
    if (update.type !== "notify") {
      this.log("message_ignored", {
        connectorKey: this.options.connectorKey,
        reason: "non_notify_upsert",
        upsertType: update.type,
        messageCount: update.messages.length,
      });
      return;
    }

    for (const message of update.messages) {
      const remoteJid = message.key.remoteJid;
      const chatType = resolveChatType(remoteJid ?? undefined);
      const externalConversationId = remoteJid ? jidNormalizedUser(remoteJid) : null;
      const externalActorId = message.key.participant
        ? jidNormalizedUser(message.key.participant)
        : externalConversationId;
      const externalMessageId = message.key.id?.trim() || null;

      if (message.key.fromMe) {
        this.log("message_ignored", {
          connectorKey: this.options.connectorKey,
          externalConversationId,
          externalActorId,
          chatType,
          reason: "own_message",
        });
        continue;
      }

      if (!remoteJid || !externalConversationId || !externalActorId || !externalMessageId) {
        this.log("message_dropped", {
          connectorKey: this.options.connectorKey,
          externalConversationId,
          externalActorId,
          chatType,
          reason: "missing_actor_conversation_or_message",
        });
        continue;
      }

      if (chatType !== "private") {
        this.log("message_dropped", {
          connectorKey: this.options.connectorKey,
          externalConversationId,
          externalActorId,
          chatType,
          reason: "group_support_not_enabled",
        });
        continue;
      }

      const rawText = extractWhatsAppMessageText(message);
      const media = await this.downloadSupportedMedia(message, stores);
      if (!rawText && media.length === 0) {
        this.log("message_dropped", {
          connectorKey: this.options.connectorKey,
          externalConversationId,
          externalActorId,
          chatType,
          reason: "unsupported_message_shape",
        });
        continue;
      }

      const quotedMessageId = extractWhatsAppQuotedMessageId(message);
      const request = await stores.requests.enqueueRequest({
        kind: "whatsapp_message",
        payload: {
          connectorKey: this.options.connectorKey,
          sentAt: readMessageSentAtMs(message.messageTimestamp),
          externalConversationId,
          externalActorId,
          externalMessageId,
          remoteJid,
          chatType,
          text: rawText,
          pushName: message.pushName ?? undefined,
          quotedMessageId,
          media,
        },
      });

      this.log("message_ingested", {
        connectorKey: this.options.connectorKey,
        externalConversationId,
        externalActorId,
        chatType,
        externalMessageId,
        mediaCount: media.length,
        textLength: extractMessageTextLength(message),
        requestId: request.id,
      });
    }
  }

  private async downloadSupportedMedia(
    message: WAMessage,
    stores: WhatsAppWorkerStores,
  ): Promise<readonly MediaDescriptor[]> {
    const content = normalizeMessageContent(message.message);
    if (!content) {
      return [];
    }

    const descriptors: MediaDescriptor[] = [];

    if (content.imageMessage) {
      descriptors.push(await this.downloadMedia(message, stores, {
        mimeType: content.imageMessage.mimetype ?? "image/jpeg",
        sizeBytes: readMediaSizeBytes(content.imageMessage.fileLength),
      }));
    }

    if (content.documentMessage) {
      descriptors.push(await this.downloadMedia(message, stores, {
        mimeType: content.documentMessage.mimetype ?? "application/octet-stream",
        sizeBytes: readMediaSizeBytes(content.documentMessage.fileLength),
        hintFilename: content.documentMessage.fileName ?? undefined,
      }));
    }

    return descriptors;
  }

  private async downloadMedia(
    message: WAMessage,
    stores: WhatsAppWorkerStores,
    options: {
      mimeType: string;
      sizeBytes?: number;
      hintFilename?: string;
    },
  ): Promise<MediaDescriptor> {
    if (!this.socket) {
      throw new Error("WhatsApp media download requires a live connector socket.");
    }

    const bytes = new Uint8Array(await downloadMediaMessage(message, "buffer", {}, {
      reuploadRequest: this.socket.updateMediaMessage,
      logger: WHATSAPP_LOGGER,
    }));

    return stores.mediaStore.writeMedia({
      bytes,
      source: WHATSAPP_SOURCE,
      connectorKey: this.options.connectorKey,
      mimeType: options.mimeType,
      sizeBytes: options.sizeBytes,
      hintFilename: options.hintFilename,
      metadata: {
        whatsappMessageId: message.key.id ?? null,
        whatsappRemoteJid: message.key.remoteJid ?? null,
      },
    });
  }
}
