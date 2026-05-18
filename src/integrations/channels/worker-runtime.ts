import {
  ChannelOutboundDeliveryWorker,
  type ChannelOutboundDeliveryWorkerOptions,
} from "../../domain/channels/deliveries/worker.js";
import {runCleanupSteps} from "../../lib/cleanup.js";
import {
  startChannelWorkerNotificationListener,
  type PostgresNotificationListenerHandle,
} from "./postgres-notification-listener.js";

type ConnectorWorkerLogger = (event: string, payload: Record<string, unknown>) => void;

type ChannelWorkerNotificationListenerOptions = Parameters<typeof startChannelWorkerNotificationListener>[0];

export interface ConnectorWorkerRuntimeWorker {
  start(options?: {subscribeToNotifications?: boolean}): Promise<void>;
  stop(): Promise<void>;
}

export interface ConnectorWorkerRuntimeLease {
  release(): Promise<void>;
}

export interface ConnectorWorkerRuntimeListener {
  close(): Promise<void>;
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
  notificationListener: ConnectorWorkerRuntimeListener | null;
  outboundWorker: TOutboundWorker;
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

export function startConnectorWorkerNotificationListener(input: {
  actionWorker: ChannelWorkerNotificationListenerOptions["actionWorker"];
  connectorKey: string;
  log: ConnectorWorkerLogger;
  onListenerFailure?: (error: unknown) => Promise<void> | void;
  outboundWorker: ChannelWorkerNotificationListenerOptions["outboundWorker"];
  pool: ChannelWorkerNotificationListenerOptions["pool"];
  source: string;
}): Promise<PostgresNotificationListenerHandle> {
  return startChannelWorkerNotificationListener({
    pool: input.pool,
    source: input.source,
    connectorKey: input.connectorKey,
    actionWorker: input.actionWorker,
    outboundWorker: input.outboundWorker,
    onError: async (error) => {
      input.log("worker_notification_listener_failed", {
        connectorKey: input.connectorKey,
        message: errorMessage(error),
      });
      await input.onListenerFailure?.(error);
    },
  });
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
      label: "notification-listener",
      run: async () => {
        await handle.notificationListener?.close();
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
  outboundWorker: TOutboundWorker;
  startNotificationListener(): Promise<ConnectorWorkerRuntimeListener>;
  onCleanupError?: (step: ConnectorWorkerRuntimeCleanupStep, error: unknown) => void;
}): Promise<ConnectorWorkerRuntimeHandle<TOutboundWorker, TActionWorker>> {
  const lease = await input.acquireLease();
  const handle: ConnectorWorkerRuntimeHandle<TOutboundWorker, TActionWorker> = {
    lease,
    outboundWorker: input.outboundWorker,
    actionWorker: input.actionWorker,
    notificationListener: null,
  };

  try {
    await input.outboundWorker.start({
      subscribeToNotifications: false,
    });
    await input.actionWorker.start({
      subscribeToNotifications: false,
    });
    handle.notificationListener = await input.startNotificationListener();
    return handle;
  } catch (error) {
    await stopConnectorWorkerRuntime(handle, input.onCleanupError);
    throw error;
  }
}
