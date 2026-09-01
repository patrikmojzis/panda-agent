import {
  ChannelOutboundDeliveryWorker,
  type ChannelOutboundDeliveryWorkerOptions,
} from "../../domain/channels/deliveries/worker.js";
import {runCleanupSteps} from "../../lib/cleanup.js";
import {
  buildObservedPoolConfig,
  createPostgresPool,
  observePostgresPool,
  requireDatabaseUrl,
  type PostgresPoolObserver,
} from "../../lib/postgres-database.js";
import type {PostgresListenSnapshot} from "../../lib/postgres-listen.js";
import {createPandaSchemaVerifier} from "../postgres/schema-version.js";
import {
  startPostgresNotificationListener,
  type PostgresNotificationListenerHandle,
} from "./postgres-notification-listener.js";

type ConnectorWorkerLogger = (event: string, payload: Record<string, unknown>) => void;

export interface ConnectorWorkerRuntimeWorker {
  start(options?: {subscribeToNotifications?: boolean}): Promise<void>;
  stop(): Promise<void>;
  triggerDrain(): Promise<void>;
}

export interface ConnectorWorkerRuntimeLease {
  release(): Promise<void>;
}

export interface ConnectorWorkerRuntimeCleanupStep {
  label: string;
}

export interface ConnectorWorkerRuntimeHandle<
  TOutboundWorker extends ConnectorWorkerRuntimeWorker = ConnectorWorkerRuntimeWorker,
  TActionWorker extends ConnectorWorkerRuntimeWorker = ConnectorWorkerRuntimeWorker,
> {
  actionWorker: TActionWorker;
  lease: ConnectorWorkerRuntimeLease;
  notificationRegistration: ConnectorWorkerRuntimeNotificationRegistration | null;
  outboundWorker: TOutboundWorker;
}

interface ConnectorWorkerNotificationTarget {
  triggerDrain(cause?: "startup" | "notification" | "listener_reconnect"): Promise<void>;
}

export interface ConnectorWorkerRuntimeNotificationRegistration {
  unregister(): void;
}

export interface ConnectorWorkerRuntimeNotificationRouter {
  register(input: {
    actionWorker: ConnectorWorkerNotificationTarget;
    additionalTargets?: Readonly<Record<string, ConnectorWorkerNotificationTarget>>;
    connectorKey: string;
    outboundWorker: ConnectorWorkerNotificationTarget;
  }): ConnectorWorkerRuntimeNotificationRegistration;
}

export interface ConnectorDaemonAdditionalNotification<TNotification = unknown> {
  channel: string;
  key: string;
  label: string;
  connectorKey(notification: TNotification): string | null;
  parse(payload: string | undefined): TNotification | null;
}

export interface ConnectorDaemonRuntimeHandle {
  close(): Promise<void>;
  getNotificationSnapshot(): PostgresListenSnapshot;
  notifications: ConnectorWorkerRuntimeNotificationRouter;
  pool: ReturnType<typeof createPostgresPool>;
  poolConfig: ReturnType<typeof buildObservedPoolConfig>;
}

interface ConnectorNotificationRegistration {
  actionWorker: ConnectorWorkerNotificationTarget;
  additionalTargets: Readonly<Record<string, ConnectorWorkerNotificationTarget>>;
  connectorKey: string;
  outboundWorker: ConnectorWorkerNotificationTarget;
}

export interface ConnectorDaemonRuntimeDependencies {
  createPool?: typeof createPostgresPool;
  observePool?: (input: Parameters<typeof observePostgresPool>[0]) => PostgresPoolObserver;
  startNotificationListener?: typeof startPostgresNotificationListener;
  verifySchema?: (pool: ReturnType<typeof createPostgresPool>) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createConnectorOutboundWorker(
  input: Omit<ChannelOutboundDeliveryWorkerOptions, "onError"> & {
    log: ConnectorWorkerLogger;
  },
): ChannelOutboundDeliveryWorker {
  const {log, ...workerOptions} = input;
  return new ChannelOutboundDeliveryWorker({
    ...workerOptions,
    onError: (error, deliveryId) => {
      log("outbound_delivery_failed", {
        connectorKey: input.connectorKey,
        deliveryId: deliveryId ?? null,
        message: errorMessage(error),
      });
    },
  });
}

function drainTarget(
  target: ConnectorWorkerNotificationTarget,
  input: {
    cause: "startup" | "notification" | "listener_reconnect";
    connectorKey: string;
    kind: string;
    log: ConnectorWorkerLogger;
  },
): void {
  void target.triggerDrain(input.cause).catch((error) => input.log("worker_notification_drain_failed", {
    connectorKey: input.connectorKey,
    kind: input.kind,
    message: errorMessage(error),
  }));
}

/** Owns one channel daemon pool and one listener, regardless of account count. */
export async function startConnectorDaemonRuntime(input: {
  additionalNotifications?: readonly ConnectorDaemonAdditionalNotification[];
  dbUrl?: string;
  dependencies?: ConnectorDaemonRuntimeDependencies;
  log: ConnectorWorkerLogger;
  poolMaxEnvKey: string;
  reconnectDelayMs?: number;
  source: string;
}): Promise<ConnectorDaemonRuntimeHandle> {
  const applicationName = `panda/${input.source}`;
  const configuredPoolMax = process.env[input.poolMaxEnvKey]?.trim();
  if (configuredPoolMax) {
    const parsedPoolMax = Number.parseInt(configuredPoolMax, 10);
    if (Number.isInteger(parsedPoolMax) && parsedPoolMax < 2) {
      throw new Error(`${input.poolMaxEnvKey} must be at least 2 because the connector daemon reserves one connection for LISTEN.`);
    }
  }
  const poolConfig = buildObservedPoolConfig(applicationName, input.poolMaxEnvKey, 2);
  if (poolConfig.max < 2) {
    throw new Error(`${input.poolMaxEnvKey} must be at least 2 because the connector daemon reserves one connection for LISTEN.`);
  }

  const createPool = input.dependencies?.createPool ?? createPostgresPool;
  const pool = createPool({
    connectionString: requireDatabaseUrl(input.dbUrl),
    applicationName,
    max: poolConfig.max,
    idleTimeoutMillis: poolConfig.idleTimeoutMillis,
    connectionTimeoutMillis: poolConfig.acquireTimeoutMillis,
  });
  let observer: PostgresPoolObserver | null = null;
  const registrations = new Map<string, ConnectorNotificationRegistration>();
  let listener: PostgresNotificationListenerHandle | null = null;
  let closed = false;

  const drainRegistration = (
    registration: ConnectorNotificationRegistration,
    cause: "startup" | "notification" | "listener_reconnect",
  ): void => {
    drainTarget(registration.actionWorker, {
      cause,
      connectorKey: registration.connectorKey,
      kind: "action",
      log: input.log,
    });
    drainTarget(registration.outboundWorker, {
      cause,
      connectorKey: registration.connectorKey,
      kind: "delivery",
      log: input.log,
    });
    for (const [kind, target] of Object.entries(registration.additionalTargets)) {
      drainTarget(target, {cause, connectorKey: registration.connectorKey, kind, log: input.log});
    }
  };
  const drainAll = (cause: "listener_reconnect"): void => {
    for (const registration of registrations.values()) drainRegistration(registration, cause);
  };

  const additionalChannels = (input.additionalNotifications ?? []).map((notification) => ({
    channel: notification.channel,
    label: notification.label,
    parse: notification.parse,
    listener: async (payload: unknown) => {
      const connectorKey = notification.connectorKey(payload);
      if (!connectorKey) return;
      const registration = registrations.get(connectorKey);
      const target = registration?.additionalTargets[notification.key];
      if (target) drainTarget(target, {
        cause: "notification",
        connectorKey,
        kind: notification.key,
        log: input.log,
      });
    },
  }));

  try {
    observer = (input.dependencies?.observePool ?? observePostgresPool)({
      pool,
      applicationName,
      max: poolConfig.max,
      idleTimeoutMillis: poolConfig.idleTimeoutMillis,
      waitingLogIntervalMs: poolConfig.waitingLogIntervalMs,
      log: input.log,
    });
    await (input.dependencies?.verifySchema ?? ((targetPool) => (
      createPandaSchemaVerifier(targetPool).assertCurrent()
    )))(pool);
    listener = await (input.dependencies?.startNotificationListener ?? startPostgresNotificationListener)({
      pool,
      additionalChannels,
      onActionNotification: async (notification) => {
        if (notification.channel !== input.source) return;
        const registration = registrations.get(notification.connectorKey);
        if (registration) drainTarget(registration.actionWorker, {
          cause: "notification",
          connectorKey: notification.connectorKey,
          kind: "action",
          log: input.log,
        });
      },
      onDeliveryNotification: async (notification) => {
        if (notification.channel !== input.source) return;
        const registration = registrations.get(notification.connectorKey);
        if (registration) drainTarget(registration.outboundWorker, {
          cause: "notification",
          connectorKey: notification.connectorKey,
          kind: "delivery",
          log: input.log,
        });
      },
      onError: async (error) => input.log("worker_notification_listener_failed", {
        message: errorMessage(error),
        source: input.source,
      }),
      onStateChange: async (snapshot) => {
        if (snapshot.status === "listening") drainAll("listener_reconnect");
      },
      reconnectDelayMs: input.reconnectDelayMs,
    });
  } catch (error) {
    observer?.stop();
    await pool.end();
    throw error;
  }

  const notifications: ConnectorWorkerRuntimeNotificationRouter = {
    register(registrationInput) {
      if (closed) throw new Error(`Cannot register ${registrationInput.connectorKey}; ${input.source} daemon runtime is closed.`);
      if (registrations.has(registrationInput.connectorKey)) {
        throw new Error(`Connector notification worker already registered: ${input.source}/${registrationInput.connectorKey}`);
      }
      const registration: ConnectorNotificationRegistration = {
        ...registrationInput,
        additionalTargets: registrationInput.additionalTargets ?? {},
      };
      registrations.set(registrationInput.connectorKey, registration);
      if (listener?.getSnapshot().listening) drainRegistration(registration, "startup");
      return {
        unregister(): void {
          if (registrations.get(registrationInput.connectorKey) === registration) {
            registrations.delete(registrationInput.connectorKey);
          }
        },
      };
    },
  };

  return {
    pool,
    poolConfig,
    notifications,
    getNotificationSnapshot: () => listener!.getSnapshot(),
    close: async () => {
      if (closed) return;
      closed = true;
      registrations.clear();
      await runCleanupSteps([
        {label: "notification-listener", run: async () => listener?.close()},
        {label: "pool-observer", run: () => observer?.stop()},
        {label: "postgres-pool", run: async () => pool.end()},
      ], (step, error) => input.log("connector_daemon_cleanup_failed", {
        message: errorMessage(error),
        source: input.source,
        step: step.label,
      }));
    },
  };
}

export async function stopConnectorWorkerRuntime(
  handle: ConnectorWorkerRuntimeHandle | null | undefined,
  onError?: (step: ConnectorWorkerRuntimeCleanupStep, error: unknown) => void,
): Promise<void> {
  if (!handle) {
    return;
  }

  await runCleanupSteps([
    {
      label: "notification-registration",
      run: async () => {
        handle.notificationRegistration?.unregister();
      },
    },
    {
      label: "action-worker",
      run: async () => {
        await handle.actionWorker.stop();
      },
    },
    {
      label: "outbound-worker",
      run: async () => {
        await handle.outboundWorker.stop();
      },
    },
    {
      label: "connector-lease",
      run: async () => {
        await handle.lease.release();
      },
    },
  ], onError ? (step, error) => onError({label: step.label}, error) : undefined);
}

export async function startConnectorWorkerRuntime<
  TOutboundWorker extends ConnectorWorkerRuntimeWorker,
  TActionWorker extends ConnectorWorkerRuntimeWorker,
>(input: {
  acquireLease(): Promise<ConnectorWorkerRuntimeLease>;
  actionWorker: TActionWorker;
  connectorKey: string;
  notificationRouter: ConnectorWorkerRuntimeNotificationRouter;
  outboundWorker: TOutboundWorker;
  additionalNotificationTargets?: Readonly<Record<string, ConnectorWorkerNotificationTarget>>;
  onCleanupError?: (step: ConnectorWorkerRuntimeCleanupStep, error: unknown) => void;
}): Promise<ConnectorWorkerRuntimeHandle<TOutboundWorker, TActionWorker>> {
  const lease = await input.acquireLease();
  const handle: ConnectorWorkerRuntimeHandle<TOutboundWorker, TActionWorker> = {
    lease,
    outboundWorker: input.outboundWorker,
    actionWorker: input.actionWorker,
    notificationRegistration: null,
  };

  try {
    await input.outboundWorker.start({
      subscribeToNotifications: false,
    });
    await input.actionWorker.start({
      subscribeToNotifications: false,
    });
    handle.notificationRegistration = input.notificationRouter.register({
      connectorKey: input.connectorKey,
      actionWorker: input.actionWorker,
      outboundWorker: input.outboundWorker,
      additionalTargets: input.additionalNotificationTargets,
    });
    return handle;
  } catch (error) {
    await stopConnectorWorkerRuntime(handle, input.onCleanupError);
    throw error;
  }
}
