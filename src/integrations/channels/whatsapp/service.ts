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
import {
  buildObservedPoolConfig,
  createPostgresPool,
  observePostgresPool,
  type PostgresPoolObserver,
  requireDatabaseUrl,
} from "../../../lib/postgres-database.js";
import {ensureSchemas} from "../../../lib/postgres-bootstrap.js";
import {RuntimeRequestRepo} from "../../../domain/threads/requests/repo.js";
import {PostgresChannelActionStore} from "../../../domain/channels/actions/postgres.js";
import {
  PostgresOutboundDeliveryStore
} from "../../../domain/channels/deliveries/postgres.js";
import {ChannelOutboundDeliveryWorker} from "../../../domain/channels/deliveries/worker.js";
import {resolveWhatsAppSocketVersion, WHATSAPP_SOURCE} from "./config.js";
import {PostgresWhatsAppAuthStore, type WhatsAppAuthStateHandle} from "./auth-store.js";
import {
  toWhatsAppWhoamiResult,
  type WhatsAppPairResult,
  type WhatsAppWhoamiResult,
} from "./account.js";
import {WhatsAppHealthState} from "./health.js";
import {createWhatsAppOutboundAdapter} from "./outbound.js";
import {
  runWhatsAppPairingLoop,
  type WhatsAppPairSocketCycleResult,
  waitForWhatsAppPairingCycle,
} from "./pairing.js";
import {waitForWhatsAppSocketCycle} from "./runtime-cycle.js";
import {createWhatsAppSocket} from "./socket.js";
import {createWhatsAppTypingAdapter} from "./typing.js";
import {runInBackground, sleep} from "../../../lib/async.js";
import {runCleanupSteps} from "../../../lib/cleanup.js";
import {
  createConnectorOutboundWorker,
  startConnectorWorkerRuntime,
  startConnectorWorkerNotificationListener,
  stopConnectorWorkerRuntime,
  type ConnectorWorkerRuntimeHandle,
} from "../worker-runtime.js";

export interface WhatsAppServiceOptions {
  connectorKey: string;
  dataDir: string;
  dbUrl?: string;
}

const RECONNECT_DELAY_MS = 1_000;
const WHATSAPP_POOL_MAX_FALLBACK = 5;

interface WhatsAppWorkerStores {
  pool: Pool;
  authStore: PostgresWhatsAppAuthStore;
  outboundDeliveries: PostgresOutboundDeliveryStore;
  channelActions: PostgresChannelActionStore;
  connectorLeases: PostgresConnectorLeaseRepo;
  requests: RuntimeRequestRepo;
  mediaStore: FileSystemMediaStore;
}

export class WhatsAppService {
  private readonly options: WhatsAppServiceOptions;
  private readonly healthState: WhatsAppHealthState;
  private pool: Pool | null = null;
  private authStore: PostgresWhatsAppAuthStore | null = null;
  private storesPromise: Promise<WhatsAppWorkerStores> | null = null;
  private stores: WhatsAppWorkerStores | null = null;
  private socket: WASocket | null = null;
  private workerRuntime: ConnectorWorkerRuntimeHandle<ChannelOutboundDeliveryWorker, ChannelActionWorker> | null = null;
  private poolObserver: PostgresPoolObserver | null = null;
  private healthServer: HealthServer | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private socketWaiterResolve: (() => void) | null = null;

  constructor(options: WhatsAppServiceOptions) {
    this.options = options;
    this.healthState = new WhatsAppHealthState({
      connectorKey: options.connectorKey,
    });
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
      connectionTimeoutMillis: poolConfig.acquireTimeoutMillis,
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

  private async createSocket(options: {
    authHandle?: WhatsAppAuthStateHandle;
    persistCredsOnUpdate?: boolean;
  } = {}): Promise<{
    authHandle: WhatsAppAuthStateHandle;
    socket: WASocket;
  }> {
    const authStore = await this.ensureAuthStore();
    const authHandle = options.authHandle ?? await authStore.createAuthState(this.options.connectorKey);
    const persistCredsOnUpdate = options.persistCredsOnUpdate ?? true;
    const socketVersion = await this.resolveSocketVersion();
    const socket = createWhatsAppSocket({
      authHandle,
      socketVersion,
      persistCredsOnUpdate,
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

  private async startWorkerNotificationListener(
    stores: WhatsAppWorkerStores,
    workers: {
      actionWorker: ChannelActionWorker;
      outboundWorker: ChannelOutboundDeliveryWorker;
    },
  ) {
    return startConnectorWorkerNotificationListener({
      pool: stores.pool,
      source: WHATSAPP_SOURCE,
      connectorKey: this.options.connectorKey,
      actionWorker: workers.actionWorker,
      outboundWorker: workers.outboundWorker,
      log: (event, payload) => this.log(event, payload),
      onListenerFailure: async () => {
        this.healthState.markListenersActive(false);
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
        this.healthState.markLockHeld(false);
        await this.stop();
      },
    });
  }

  async whoami(): Promise<WhatsAppWhoamiResult> {
    const authStore = await this.ensureAuthStore();
    const creds = await authStore.loadCreds(this.options.connectorKey);
    return toWhatsAppWhoamiResult(this.options.connectorKey, creds);
  }

  async pair(phoneNumber: string, onPairingCode?: (code: string) => void): Promise<WhatsAppPairResult> {
    const authStore = await this.ensureAuthStore();
    const existingCreds = await authStore.loadCreds(this.options.connectorKey);
    const existingIdentity = toWhatsAppWhoamiResult(this.options.connectorKey, existingCreds);

    if (existingIdentity.accountId) {
      return {
        ...existingIdentity,
        alreadyPaired: true,
      };
    }

    return runWhatsAppPairingLoop({
      connectorKey: this.options.connectorKey,
      phoneNumber,
      pairingCode: bytesToCrockford(randomBytes(5)),
      onPairingCode,
      isStopping: () => this.stopping,
      sleep,
      log: (event, payload) => this.log(event, payload),
      runCycle: (cyclePhoneNumber, announcePairingCode, pairingCode) => {
        return this.runPairSocketCycle(cyclePhoneNumber, announcePairingCode, pairingCode);
      },
    });
  }

  private async runPairSocketCycle(
    phoneNumber: string,
    onPairingCode?: (code: string) => void,
    pairingCode?: string,
  ): Promise<WhatsAppPairSocketCycleResult> {
    const authStore = await this.ensureAuthStore();
    const authHandle = authStore.createTransientAuthState();
    const {socket} = await this.createSocket({
      authHandle,
      persistCredsOnUpdate: false,
    });
    try {
      return await waitForWhatsAppPairingCycle({
        connectorKey: this.options.connectorKey,
        phoneNumber,
        socket,
        authHandle,
        pairingCode,
        onPairingCode,
      });
    } finally {
      await this.stopSocket();
    }
  }

  async run(): Promise<void> {
    this.stopping = false;
    this.stopPromise = null;
    this.healthState.resetForRun();

    try {
      const identity = await this.whoami();
      if (!identity.accountId) {
        throw new Error(
          `WhatsApp connector ${this.options.connectorKey} is not linked yet. Run \`panda whatsapp link --phone <number>\` first.`,
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
          getSnapshot: () => this.healthState.snapshot(this.stopping),
        });
      })();
      this.healthState.markInitialized(true);
      const outboundWorker = this.createOutboundWorker(stores);
      const actionWorker = this.createActionWorker(stores);
      this.workerRuntime = await startConnectorWorkerRuntime({
        acquireLease: () => this.acquireConnectorLease(stores),
        outboundWorker,
        actionWorker,
        startNotificationListener: () => this.startWorkerNotificationListener(stores, {
          outboundWorker,
          actionWorker,
        }),
        onCleanupError: (step, error) => {
          this.log("shutdown_cleanup_failed", {
            connectorKey: this.options.connectorKey,
            step: step.label,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      });
      this.healthState.markLockHeld(true);
      this.healthState.markListenersActive(true);
      this.log("run_started", {
        connectorKey: this.options.connectorKey,
        accountId: identity.accountId,
        name: identity.name ?? null,
        dataDir: this.options.dataDir,
      });

      while (!this.stopping) {
        this.healthState.markSocketState("connecting");
        const outcome = await this.runSocketCycle(stores);
        if (!outcome.reconnect || this.stopping) {
          break;
        }

        this.healthState.markSocketState("reconnecting");
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
    this.healthState.markStopped();
    this.stopPromise = (async () => {
      this.socketWaiterResolve?.();
      this.socketWaiterResolve = null;

      const workerRuntime = this.workerRuntime;
      const pool = this.pool;
      const poolObserver = this.poolObserver;
      const healthServer = this.healthServer;
      this.workerRuntime = null;
      this.pool = null;
      this.poolObserver = null;
      this.healthServer = null;
      this.authStore = null;
      this.stores = null;
      this.storesPromise = null;

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
      return await waitForWhatsAppSocketCycle({
        connectorKey: this.options.connectorKey,
        socket,
        authHandle,
        requests: stores.requests,
        mediaStore: stores.mediaStore,
        isStopping: () => this.stopping,
        setStopWaiter: (waiter) => {
          this.socketWaiterResolve = waiter;
        },
        markSocketState: (state) => {
          this.healthState.markSocketState(state);
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
