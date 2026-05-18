import type {PgListenClient, PgPoolLike} from "../../lib/postgres-query.js";
import {listenPostgresChannel} from "../../lib/postgres-listen.js";
import {
  buildThreadRuntimeNotificationChannel,
  parseThreadRuntimeNotification,
  type ThreadRuntimeNotification,
} from "../../domain/threads/runtime/postgres-notifications.js";

type NotificationPool = PgPoolLike<PgListenClient>;

export async function listenThreadRuntimeNotifications(options: {
  pool: NotificationPool;
  listener: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}): Promise<() => Promise<void>> {
  const channel = buildThreadRuntimeNotificationChannel();
  return listenPostgresChannel({
    pool: options.pool,
    channel,
    label: "Thread runtime notification listener",
    parse: (payload) => typeof payload === "string" ? parseThreadRuntimeNotification(payload) : null,
    listener: options.listener,
  });
}
