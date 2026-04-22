import type {PoolClient} from "pg";

import {
  buildThreadRuntimeNotificationChannel,
  parseThreadRuntimeNotification,
  type ThreadRuntimeNotification,
} from "../../domain/threads/runtime/postgres.js";

interface NotificationPool {
  connect(): Promise<PoolClient>;
}

export async function listenThreadRuntimeNotifications(options: {
  pool: NotificationPool;
  listener: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}): Promise<() => Promise<void>> {
  const client = await options.pool.connect();
  const channel = buildThreadRuntimeNotificationChannel();
  const handleNotification = (message: { channel: string; payload?: string }) => {
    if (message.channel !== channel || typeof message.payload !== "string") {
      return;
    }

    const notification = parseThreadRuntimeNotification(message.payload);
    if (!notification) {
      return;
    }

    void options.listener(notification);
  };

  client.on("notification", handleNotification);
  await client.query(`LISTEN ${channel}`);

  return async () => {
    client.off("notification", handleNotification);
    try {
      await client.query(`UNLISTEN ${channel}`);
    } finally {
      client.release();
    }
  };
}
