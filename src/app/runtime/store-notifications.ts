import type {PgListenClient, PgPoolLike} from "../../lib/postgres-query.js";
import {listenPostgresChannel, type PostgresListenSnapshot} from "../../lib/postgres-listen.js";
import {
  buildThreadRuntimeNotificationChannel,
  parseThreadRuntimeNotification,
  type ThreadRuntimeNotification,
} from "../../domain/threads/runtime/postgres-notifications.js";

type NotificationPool = PgPoolLike<PgListenClient>;

export async function listenThreadRuntimeNotifications(options: {
  pool: NotificationPool;
  listener: (notification: ThreadRuntimeNotification) => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
  onStateChange?: (snapshot: PostgresListenSnapshot) => Promise<void> | void;
  reconnectDelayMs?: number;
}): Promise<() => Promise<void>> {
  const channel = buildThreadRuntimeNotificationChannel();
  return listenPostgresChannel({
    pool: options.pool,
    channel,
    label: "Thread runtime notification listener",
    parse: (payload) => typeof payload === "string" ? parseThreadRuntimeNotification(payload) : null,
    listener: options.listener,
    ...(options.onError ? {onError: options.onError} : {}),
    ...(options.onStateChange ? {onStateChange: options.onStateChange} : {}),
    ...(options.reconnectDelayMs !== undefined ? {reconnectDelayMs: options.reconnectDelayMs} : {}),
  });
}
