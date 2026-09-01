import {randomBytes} from "node:crypto";
import type {Pool} from "pg";
import {
  bytesToCrockford,
  fetchLatestWaWebVersion,
  type WASocket,
} from "baileys";

import {type HealthServer, resolveOptionalHealthServerBinding, startHealthServer} from "../../../lib/health-server.js";
import {ChannelActionWorker} from "../../../domain/channels/actions/worker.js";
import {
  acquireManagedConnectorLease,
  type ManagedConnectorLease,
  PostgresConnectorLeaseRepo
} from "../../../domain/connector-leases/repo.js";
import {FileSystemMediaStore} from "../../../domain/channels/media-store.js";
import {RuntimeRequestRepo} from "../../../domain/threads/requests/repo.js";
import {PostgresChannelActionStore} from "../../../domain/channels/actions/postgres.js";
import {
  PostgresOutboundDeliveryStore
} from "../../../domain/channels/deliveries/postgres.js";
import {ChannelOutboundDeliveryWorker} from "../../../domain/channels/deliveries/worker.js";
import {PostgresConnectorAccountStore} from "../../../domain/connectors/postgres.js";
import type {SecretCrypto} from "../../../domain/secrets/crypto.js";
import type {ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import type {WhatsAppCallWebhookServer} from "./calls/webhook.js";
import {
  resolveWhatsAppIngressLimits,
  resolveWhatsAppSocketVersion,
  WHATSAPP_SOURCE,
} from "./config.js";
import {createWhatsAppActorAuthorizer} from "./authorization.js";
import {WhatsAppMediaWorkQueue} from "./media-work-queue.js";
import {PostgresWhatsAppAuthStore, type WhatsAppAuthStateHandle} from "./auth-store.js";
import {
  toWhatsAppWhoamiResult,
  type WhatsAppPairResult,
  type WhatsAppWhoamiResult,
} from "./account.js";
import {WhatsAppHealthState} from "./health.js";
import {PostgresWhatsAppRuntimeStatusStore} from "./runtime-status-store.js";
import {createWhatsAppOutboundAdapter} from "./outbound.js";
import {
  runWhatsAppPairingLoop,
  type WhatsAppPairSocketCycleResult,
  waitForWhatsAppPairingCycle,
} from "./pairing.js";
import {waitForWhatsAppSocketCycle} from "./runtime-cycle.js";
import {createWhatsAppSocket} from "./socket.js";
import {createWhatsAppTypingAdapter} from "./typing.js";
import {createWhatsAppPairingLogger, type WhatsAppLoggerLike} from "./transport.js";
import {runInBackground, sleep} from "../../../lib/async.js";
import {runCleanupSteps} from "../../../lib/cleanup.js";
import {
  createConnectorOutboundWorker,
  startConnectorWorkerRuntime,
  stopConnectorWorkerRuntime,
  type ConnectorDaemonRuntimeHandle,
  type ConnectorWorkerRuntimeHandle,
} from "../worker-runtime.js";

export interface WhatsAppServiceOptions {
  accountId: string;
  accountKey: string;
  connectorKey: string;
  crypto: SecretCrypto;
  dataDir: string;
  pool?: Pool;
  runtime?: ConnectorDaemonRuntimeHandle;
  mediaQueue?: WhatsAppMediaWorkQueue;
  disableHealthServer?: boolean;
  account?: ConnectorAccountRecord;
  callWebhook?: WhatsAppCallWebhookServer;
  env?: NodeJS.ProcessEnv;
}

const RECONNECT_DELAY_MS = 1_000;

interface WhatsAppWorkerStores {
  pool: Pool;
  accounts: PostgresConnectorAccountStore;
  authStore: PostgresWhatsAppAuthStore;
  runtimeStatus: PostgresWhatsAppRuntimeStatusStore;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  channelActions: PostgresChannelActionStore;
  connectorLeases: PostgresConnectorLeaseRepo;
  requests: RuntimeRequestRepo;
  mediaStore: FileSystemMediaStore;
}

export class WhatsAppService {
  private readonly options: WhatsAppServiceOptions;
  private readonly healthState: WhatsAppHealthState;
  private readonly authStore: PostgresWhatsAppAuthStore;
  private readonly stores: WhatsAppWorkerStores;
  private socket: WASocket | null = null;
  private workerRuntime: ConnectorWorkerRuntimeHandle<ChannelOutboundDeliveryWorker, ChannelActionWorker> | null = null;
  private healthServer: HealthServer | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private socketWaiterResolve: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeFailed = false;
  private runtimeStarted = false;
  private mediaQueue: WhatsAppMediaWorkQueue | null;
  private readonly ownsMediaQueue: boolean;

  constructor(options: WhatsAppServiceOptions) {
    this.options = options;
    this.mediaQueue = options.mediaQueue ?? null;
    this.ownsMediaQueue = !options.mediaQueue;
    const pool = options.runtime?.pool ?? options.pool;
    if (!pool) throw new Error("WhatsApp service requires a daemon runtime or an existing Postgres pool.");
    const requests = new RuntimeRequestRepo({pool});
    this.authStore = new PostgresWhatsAppAuthStore({pool, crypto: options.crypto});
    this.stores = {
      pool,
      accounts: new PostgresConnectorAccountStore({pool}),
      authStore: this.authStore,
      runtimeStatus: new PostgresWhatsAppRuntimeStatusStore({pool}),
      outboundDeliveries: new PostgresOutboundDeliveryStore({pool}),
      channelActions: new PostgresChannelActionStore({pool}),
      connectorLeases: new PostgresConnectorLeaseRepo({pool}),
      requests,
      mediaStore: new FileSystemMediaStore({rootDir: options.dataDir}),
    };
    this.healthState = new WhatsAppHealthState({
      connectorKey: options.connectorKey,
    });
  }

  private log(event: string, payload: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({
      source: WHATSAPP_SOURCE,
      accountKey: this.options.accountKey,
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    })}\n`);
  }

  private async ensureAuthStore(): Promise<PostgresWhatsAppAuthStore> {
    return this.authStore;
  }

  private async ensureStores(): Promise<WhatsAppWorkerStores> {
    return this.stores;
  }

  private ensureMediaQueue(): WhatsAppMediaWorkQueue {
    if (!this.mediaQueue) {
      const limits = resolveWhatsAppIngressLimits();
      this.mediaQueue = new WhatsAppMediaWorkQueue({
        concurrency: limits.mediaConcurrency,
        queueMax: limits.mediaQueueMax,
      });
    }
    return this.mediaQueue;
  }

  private async createSocket(options: {
    authHandle?: WhatsAppAuthStateHandle;
    queryTimeoutMs?: number;
    persistCredsOnUpdate?: boolean;
    logger?: WhatsAppLoggerLike;
  } = {}): Promise<{
    authHandle: WhatsAppAuthStateHandle;
    socket: WASocket;
  }> {
    const authStore = await this.ensureAuthStore();
    const authHandle = options.authHandle ?? await authStore.createAuthState(this.options.accountId);
    const persistCredsOnUpdate = options.persistCredsOnUpdate ?? true;
    const socketVersion = await this.resolveSocketVersion();
    const socket = createWhatsAppSocket({
      authHandle,
      socketVersion,
      persistCredsOnUpdate,
      logger: options.logger,
    });

    this.socket = socket;
    return {
      authHandle,
      socket,
    };
  }

  private async resolveSocketVersion(): Promise<ReturnType<typeof resolveWhatsAppSocketVersion>> {
    const configuredVersion = resolveWhatsAppSocketVersion();
    if (configuredVersion) {
      return configuredVersion;
    }

    try {
      return (await fetchLatestWaWebVersion()).version;
    } catch (error) {
      this.log("socket_version_fetch_failed", {
        connectorKey: this.options.connectorKey,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private createOutboundWorker(stores: WhatsAppWorkerStores): ChannelOutboundDeliveryWorker {
    return createConnectorOutboundWorker({
      store: stores.outboundDeliveries,
      adapter: createWhatsAppOutboundAdapter({
        connectorKey: this.options.connectorKey,
        getSocket: () => this.socket,
      }),
      connectorKey: this.options.connectorKey,
      canSend: () => this.socket !== null,
      log: (event, payload) => this.log(event, payload),
    });
  }

  private createActionWorker(stores: WhatsAppWorkerStores): ChannelActionWorker {
    const typingAdapter = createWhatsAppTypingAdapter({
      connectorKey: this.options.connectorKey,
      getSocket: () => this.socket,
    });

    return new ChannelActionWorker({
      store: stores.channelActions,
      lookup: {
        channel: WHATSAPP_SOURCE,
        connectorKey: this.options.connectorKey,
      },
      dispatch: async (action) => {
        switch (action.kind) {
          case "typing":
            await typingAdapter.send(action.payload);
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
      onEvent: (event) => {
        this.log(
          event.type === "recovered_by_poll"
            ? "channel_action_recovered_by_poll"
            : "channel_action_expired",
          {
            actionId: event.action.id,
            ageMs: event.ageMs,
            cause: event.cause,
            channel: event.action.channel,
            kind: event.action.kind,
          },
        );
      },
    });
  }

  private triggerConnectionOpenDrains(): void {
    const outboundWorker = this.workerRuntime?.outboundWorker;
    if (outboundWorker) {
      runInBackground(async () => {
        await outboundWorker.triggerDrain();
      }, {
        label: "WhatsApp outbound reconnect drain",
        onError: (error) => {
          this.log("outbound_delivery_reconnect_drain_failed", {
            connectorKey: this.options.connectorKey,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      });
    }

    const actionWorker = this.workerRuntime?.actionWorker;
    if (actionWorker) {
      runInBackground(async () => {
        await actionWorker.triggerDrain();
      }, {
        label: "WhatsApp action reconnect drain",
        onError: (error) => {
          this.log("channel_action_reconnect_drain_failed", {
            connectorKey: this.options.connectorKey,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      });
    }
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
        this.healthState.markLockHeld(false);
        await this.stop();
      },
    });
  }

  private markRuntimeStatus(stores: WhatsAppWorkerStores, state: Parameters<PostgresWhatsAppRuntimeStatusStore["setStatus"]>[1], error?: string): void {
    runInBackground(async () => {
      await stores.runtimeStatus.setStatus(this.options.accountId, state, error);
    }, {
      label: "WhatsApp runtime status update",
      onError: (statusError) => this.log("runtime_status_update_failed", {
        message: statusError instanceof Error ? statusError.message : String(statusError),
      }),
    });
  }

  private startRuntimeHeartbeat(stores: WhatsAppWorkerStores): void {
    this.heartbeatTimer = setInterval(() => {
      void stores.runtimeStatus.heartbeat(this.options.accountId).catch((error) => {
        this.log("runtime_status_heartbeat_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  async whoami(): Promise<WhatsAppWhoamiResult> {
    const authStore = await this.ensureAuthStore();
    const creds = await authStore.loadCreds(this.options.accountId);
    return toWhatsAppWhoamiResult(this.options.connectorKey, creds);
  }

  async pair(
    phoneNumber: string,
    onPairingCode?: (code: string) => void,
    onPromotionStart?: () => void,
  ): Promise<WhatsAppPairResult> {
    const stores = await this.ensureStores();
    const authStore = await this.ensureAuthStore();
    const account = await stores.accounts.getAccountByKey(WHATSAPP_SOURCE, this.options.accountKey);
    if (!account || account.id !== this.options.accountId) {
      throw new Error(`WhatsApp account ${this.options.accountKey} no longer matches this worker.`);
    }
    if (account.externalAccountId || await authStore.hasAuthState(this.options.accountId)) {
      throw new Error(
        `WhatsApp account ${this.options.accountKey} already has local auth. Reset its link before starting a new pairing attempt.`,
      );
    }

    const lease = await this.acquireConnectorLease(stores);
    try {
      return await runWhatsAppPairingLoop({
        connectorKey: this.options.connectorKey,
        phoneNumber,
        pairingCode: bytesToCrockford(randomBytes(5)),
        onPairingCode,
        isStopping: () => this.stopping,
        sleep,
        log: (event, payload) => this.log(event, payload),
        runCycle: (cyclePhoneNumber, announcePairingCode, pairingCode) => {
          return this.runPairSocketCycle(cyclePhoneNumber, announcePairingCode, pairingCode, onPromotionStart);
        },
      });
    } finally {
      await lease.release();
    }
  }

  private async runPairSocketCycle(
    phoneNumber: string,
    onPairingCode?: (code: string) => void,
    pairingCode?: string,
    onPromotionStart?: () => void,
  ): Promise<WhatsAppPairSocketCycleResult> {
    const authStore = await this.ensureAuthStore();
    const authHandle = authStore.createTransientAuthState();
    const {socket} = await this.createSocket({
      authHandle,
      persistCredsOnUpdate: false,
      logger: createWhatsAppPairingLogger((event, payload) => this.log(event, {
        connectorKey: this.options.connectorKey,
        ...payload,
      })),
    });
    try {
      return await waitForWhatsAppPairingCycle({
        accountId: this.options.accountId,
        connectorKey: this.options.connectorKey,
        phoneNumber,
        socket,
        authHandle,
        pairingCode,
        onPairingCode,
        isStopping: () => this.stopping,
        onPromotionStart,
      });
    } finally {
      await this.stopSocket();
    }
  }

  async run(): Promise<void> {
    this.stopping = false;
    this.stopPromise = null;
    this.runtimeFailed = false;
    this.runtimeStarted = true;
    this.healthState.resetForRun();

    try {
      const stores = await this.ensureStores();
      const identity = await this.whoami();
      if (!identity.accountId) {
        throw new Error(
          `WhatsApp account ${this.options.accountKey} is not linked yet. Run \`panda whatsapp account link ${this.options.accountKey} --phone <number>\` first.`,
        );
      }

      await stores.runtimeStatus.setStatus(this.options.accountId, "idle");
      this.startRuntimeHeartbeat(stores);
      this.healthServer = await (async () => {
        if (this.options.disableHealthServer) return null;
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
            if (this.options.runtime) this.healthState.markListenerSnapshot(this.options.runtime.getNotificationSnapshot());
            return this.healthState.snapshot(this.stopping);
          },
        });
      })();
      this.healthState.markInitialized(true);
      const outboundWorker = this.createOutboundWorker(stores);
      const actionWorker = this.createActionWorker(stores);
      if (!this.options.runtime) throw new Error("WhatsApp run requires a daemon runtime.");
      this.workerRuntime = await startConnectorWorkerRuntime({
        acquireLease: () => this.acquireConnectorLease(stores),
        outboundWorker,
        actionWorker,
        connectorKey: this.options.connectorKey,
        notificationRouter: this.options.runtime.notifications,
        onCleanupError: (step, error) => {
          this.log("shutdown_cleanup_failed", {
            connectorKey: this.options.connectorKey,
            step: step.label,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      });
      this.healthState.markLockHeld(true);
      this.healthState.markListenerSnapshot(this.options.runtime.getNotificationSnapshot());
      this.log("run_started", {
        connectorKey: this.options.connectorKey,
        accountId: identity.accountId,
        name: identity.name ?? null,
        dataDir: this.options.dataDir,
      });

      while (!this.stopping) {
        this.healthState.markSocketState("connecting");
        this.markRuntimeStatus(stores, "connecting");
        const outcome = await this.runSocketCycle(stores);
        if (!outcome.reconnect || this.stopping) {
          break;
        }

        this.healthState.markSocketState("reconnecting");
        this.markRuntimeStatus(stores, "reconnecting");
        this.log("reconnect_scheduled", {
          connectorKey: this.options.connectorKey,
          reason: outcome.reason,
          delayMs: RECONNECT_DELAY_MS,
        });
        await sleep(RECONNECT_DELAY_MS);
      }
    } catch (error) {
      this.runtimeFailed = true;
      const stores = this.stores;
      if (stores) {
        const message = error instanceof Error ? error.message : String(error);
        const runtimeError = message.includes("not linked yet")
          ? "account_not_linked"
          : message.includes("closed permanently")
            ? "connection_closed_permanently"
            : "worker_failed";
        await stores.runtimeStatus.setStatus(this.options.accountId, "error", runtimeError).catch(() => undefined);
        if (message.includes("not linked yet") || message.includes("closed permanently")) {
          await stores.accounts.setAccountStatus(WHATSAPP_SOURCE, this.options.accountKey, "error").catch(() => undefined);
        }
      }
      throw error;
    } finally {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopping = true;
    this.healthState.markStopped();
    this.stopPromise = (async () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.socketWaiterResolve?.();
      this.socketWaiterResolve = null;

      const workerRuntime = this.workerRuntime;
      const healthServer = this.healthServer;
      const stores = this.stores;
      this.workerRuntime = null;
      this.healthServer = null;

      if (this.runtimeStarted && !this.runtimeFailed) {
        await stores.runtimeStatus.setStatus(this.options.accountId, "stopped").catch(() => undefined);
      }
      this.runtimeStarted = false;

      await runCleanupSteps([
        {
          label: "connector-workers",
          run: async () => {
            await stopConnectorWorkerRuntime(workerRuntime, (step, error) => {
              this.log("shutdown_cleanup_failed", {
                connectorKey: this.options.connectorKey,
                step: step.label,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          },
        },
        {
          label: "socket",
          run: async () => {
            await this.stopSocket();
          },
        },
        {
          label: "media-queue",
          run: async () => {
            if (this.ownsMediaQueue) {
              await this.mediaQueue?.close();
              this.mediaQueue = null;
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
          connectorKey: this.options.connectorKey,
          step: step.label,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    })();

    return this.stopPromise;
  }

  private async runSocketCycle(stores: WhatsAppWorkerStores): Promise<{reconnect: boolean; reason?: string}> {
    const ingressLimits = resolveWhatsAppIngressLimits();
    const {authHandle, socket} = await this.createSocket({
      queryTimeoutMs: ingressLimits.mediaDownloadTimeoutMs,
    });
    const authorizer = createWhatsAppActorAuthorizer({pool: stores.pool});
    const mediaQueue = this.ensureMediaQueue();

    try {
      return await waitForWhatsAppSocketCycle({
        connectorKey: this.options.connectorKey,
        socket,
        authHandle,
        requests: stores.requests,
        mediaStore: stores.mediaStore,
        mediaQueue,
        authorizeActor: (externalActorId) => authorizer.authorizeActor({
          connectorKey: this.options.connectorKey,
          externalActorId,
        }),
        maxMediaBytes: ingressLimits.maxMediaBytes,
        mediaDownloadTimeoutMs: ingressLimits.mediaDownloadTimeoutMs,
        isStopping: () => this.stopping,
        setStopWaiter: (waiter) => {
          this.socketWaiterResolve = waiter;
        },
        markSocketState: (state) => {
          this.healthState.markSocketState(state);
          this.markRuntimeStatus(stores, state);
        },
        onConnectionOpen: () => {
          this.triggerConnectionOpenDrains();
        },
        log: (event, payload) => this.log(event, payload),
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
}
