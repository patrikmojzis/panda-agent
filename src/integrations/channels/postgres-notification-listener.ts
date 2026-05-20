import {
  parseActionNotification,
} from "../../domain/channels/actions/postgres.js";
import {buildActionNotificationChannel} from "../../domain/channels/actions/postgres-shared.js";
import type {ActionNotification} from "../../domain/channels/actions/types.js";
import {parseDeliveryNotification} from "../../domain/channels/deliveries/postgres.js";
import {buildDeliveryNotificationChannel} from "../../domain/channels/deliveries/postgres-shared.js";
import type {DeliveryNotification} from "../../domain/channels/deliveries/types.js";
import {
  startPostgresListener,
  type PostgresListenSnapshot,
  type PostgresListenerHandle,
} from "../../lib/postgres-listen.js";
import type {PgListenClient, PgPoolLike} from "../../lib/postgres-query.js";

type PgPoolLikeForNotifications = PgPoolLike<PgListenClient>;

export type PostgresNotificationListenerHandle = PostgresListenerHandle;

interface StartPostgresNotificationListenerOptions {
  pool: PgPoolLikeForNotifications;
  onActionNotification?: (notification: ActionNotification) => Promise<void> | void;
  onDeliveryNotification?: (notification: DeliveryNotification) => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
  onStateChange?: (snapshot: PostgresListenSnapshot) => Promise<void> | void;
  reconnectDelayMs?: number;
}

interface ChannelWorkerNotificationTarget {
  triggerDrain(): Promise<void>;
}

interface StartChannelWorkerNotificationListenerOptions {
  actionWorker: ChannelWorkerNotificationTarget;
  connectorKey: string;
  outboundWorker: ChannelWorkerNotificationTarget;
  pool: PgPoolLikeForNotifications;
  source: string;
  onError?: (error: unknown) => Promise<void> | void;
  onStateChange?: (snapshot: PostgresListenSnapshot) => Promise<void> | void;
  reconnectDelayMs?: number;
}

export function startChannelWorkerNotificationListener(
  options: StartChannelWorkerNotificationListenerOptions,
): Promise<PostgresNotificationListenerHandle> {
  return startPostgresNotificationListener({
    pool: options.pool,
    onActionNotification: async (notification) => {
      if (notification.channel !== options.source || notification.connectorKey !== options.connectorKey) {
        return;
      }

      await options.actionWorker.triggerDrain();
    },
    onDeliveryNotification: async (notification) => {
      if (notification.channel !== options.source || notification.connectorKey !== options.connectorKey) {
        return;
      }

      await options.outboundWorker.triggerDrain();
    },
    onError: options.onError,
    onStateChange: options.onStateChange,
    reconnectDelayMs: options.reconnectDelayMs,
  });
}

export function startPostgresNotificationListener(
  options: StartPostgresNotificationListenerOptions,
): Promise<PostgresNotificationListenerHandle> {
  const actionChannel = buildActionNotificationChannel();
  const deliveryChannel = buildDeliveryNotificationChannel();

  return startPostgresListener({
    pool: options.pool,
    label: "Channel worker notification listener",
    channels: [
      {
        channel: actionChannel,
        label: "Channel action notification callback",
        parse: (payload) => typeof payload === "string" ? parseActionNotification(payload) : null,
        listener: async (notification) => {
          await options.onActionNotification?.(notification as ActionNotification);
        },
      },
      {
        channel: deliveryChannel,
        label: "Channel delivery notification callback",
        parse: (payload) => typeof payload === "string" ? parseDeliveryNotification(payload) : null,
        listener: async (notification) => {
          await options.onDeliveryNotification?.(notification as DeliveryNotification);
        },
      },
    ],
    onError: options.onError,
    onStateChange: options.onStateChange,
    reconnectDelayMs: options.reconnectDelayMs,
  });
}
