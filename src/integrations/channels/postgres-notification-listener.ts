import type {PoolClient} from "pg";

import {
    type ActionNotification,
    buildActionNotificationChannel,
    parseActionNotification,
} from "../../domain/channels/actions/index.js";
import {
    buildDeliveryNotificationChannel,
    type DeliveryNotification,
    parseDeliveryNotification,
} from "../../domain/channels/deliveries/index.js";

interface PgPoolLike {
  connect(): Promise<PoolClient>;
}

export interface PostgresNotificationListenerHandle {
  close(): Promise<void>;
}

export interface StartPostgresNotificationListenerOptions {
  pool: PgPoolLike;
  onActionNotification?: (notification: ActionNotification) => Promise<void> | void;
  onDeliveryNotification?: (notification: DeliveryNotification) => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
}

export async function startPostgresNotificationListener(
  options: StartPostgresNotificationListenerOptions,
): Promise<PostgresNotificationListenerHandle> {
  const client = await options.pool.connect();
  const actionChannel = buildActionNotificationChannel();
  const deliveryChannel = buildDeliveryNotificationChannel();

  const handleError = (error: unknown) => {
    void options.onError?.(error);
  };
  const handleNotification = (message: {channel: string; payload?: string}) => {
    if (typeof message.payload !== "string") {
      return;
    }

    if (message.channel === actionChannel) {
      const notification = parseActionNotification(message.payload);
      if (notification) {
        void options.onActionNotification?.(notification);
      }
      return;
    }

    if (message.channel === deliveryChannel) {
      const notification = parseDeliveryNotification(message.payload);
      if (notification) {
        void options.onDeliveryNotification?.(notification);
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
          await client.query(`UNLISTEN ${deliveryChannel}`);
        }
        await client.query(`UNLISTEN ${actionChannel}`);
      } finally {
        client.release();
      }
    },
  };
}
