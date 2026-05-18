import {
  parseActionNotification,
} from "../../domain/channels/actions/postgres.js";
import {buildActionNotificationChannel} from "../../domain/channels/actions/postgres-shared.js";
import type {ActionNotification} from "../../domain/channels/actions/types.js";
import {parseDeliveryNotification} from "../../domain/channels/deliveries/postgres.js";
import {buildDeliveryNotificationChannel} from "../../domain/channels/deliveries/postgres-shared.js";
import type {DeliveryNotification} from "../../domain/channels/deliveries/types.js";
import {runInBackground} from "../../lib/async.js";
import type {PgListenClient, PgPoolLike as BasePgPoolLike} from "../../lib/postgres-query.js";

interface PgNotificationClient extends PgListenClient {
  on(event: "notification", listener: (message: {channel: string; payload?: string}) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  off(event: "notification", listener: (message: {channel: string; payload?: string}) => void): this;
  off(event: "error", listener: (error: unknown) => void): this;
}

type PgPoolLike = BasePgPoolLike<PgNotificationClient>;

export interface PostgresNotificationListenerHandle {
  close(): Promise<void>;
}

interface StartPostgresNotificationListenerOptions {
  pool: PgPoolLike;
  onActionNotification?: (notification: ActionNotification) => Promise<void> | void;
  onDeliveryNotification?: (notification: DeliveryNotification) => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
}

interface ChannelWorkerNotificationTarget {
  triggerDrain(): Promise<void>;
}

interface StartChannelWorkerNotificationListenerOptions {
  actionWorker: ChannelWorkerNotificationTarget;
  connectorKey: string;
  outboundWorker: ChannelWorkerNotificationTarget;
  pool: PgPoolLike;
  source: string;
  onError?: (error: unknown) => Promise<void> | void;
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
  });
}

export async function startPostgresNotificationListener(
  options: StartPostgresNotificationListenerOptions,
): Promise<PostgresNotificationListenerHandle> {
  const client = await options.pool.connect();
  const actionChannel = buildActionNotificationChannel();
  const deliveryChannel = buildDeliveryNotificationChannel();

  const handleError = (error: unknown) => {
    runInBackground(async () => {
      await options.onError?.(error);
    }, {label: "Channel notification listener error handler"});
  };
  const handleNotification = (message: {channel: string; payload?: string}) => {
    if (typeof message.payload !== "string") {
      return;
    }

    if (message.channel === actionChannel) {
      const notification = parseActionNotification(message.payload);
      if (notification) {
        runInBackground(async () => {
          await options.onActionNotification?.(notification);
        }, {label: "Channel action notification callback"});
      }
      return;
    }

    if (message.channel === deliveryChannel) {
      const notification = parseDeliveryNotification(message.payload);
      if (notification) {
        runInBackground(async () => {
          await options.onDeliveryNotification?.(notification);
        }, {label: "Channel delivery notification callback"});
      }
    }
  };

  client.on("error", handleError);
  client.on("notification", handleNotification);

  try {
    await client.query(`LISTEN ${actionChannel}`);
    if (deliveryChannel !== actionChannel) {
      await client.query(`LISTEN ${deliveryChannel}`);
    }
  } catch (error) {
    client.off("error", handleError);
    client.off("notification", handleNotification);
    client.release();
    throw error;
  }

  let closed = false;
  return {
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      client.off("error", handleError);
      client.off("notification", handleNotification);

      try {
        if (deliveryChannel !== actionChannel) {
          await client.query(`UNLISTEN ${deliveryChannel}`).catch(handleError);
        }
        await client.query(`UNLISTEN ${actionChannel}`).catch(handleError);
      } finally {
        client.release();
      }
    },
  };
}
