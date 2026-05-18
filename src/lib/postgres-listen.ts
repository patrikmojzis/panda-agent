import {runInBackground} from "./async.js";
import type {PgListenClient, PgPoolLike} from "./postgres-query.js";

/**
 * Subscribes to one Postgres notification channel and runs parsed callbacks in
 * the background while keeping LISTEN/UNLISTEN cleanup consistent.
 */
export async function listenPostgresChannel<TNotification>(options: {
  pool: PgPoolLike<PgListenClient>;
  channel: string;
  label: string;
  parse(payload: string | undefined): TNotification | null;
  listener(notification: TNotification): Promise<void> | void;
}): Promise<() => Promise<void>> {
  const client = await options.pool.connect();
  const handleNotification = (message: {channel: string; payload?: string}) => {
    if (message.channel !== options.channel) {
      return;
    }

    const notification = options.parse(message.payload);
    if (notification === null) {
      return;
    }

    runInBackground(async () => {
      await options.listener(notification);
    }, {label: options.label});
  };

  client.on("notification", handleNotification);
  try {
    await client.query(`LISTEN ${options.channel}`);
  } catch (error) {
    client.off("notification", handleNotification);
    client.release();
    throw error;
  }

  return async () => {
    client.off("notification", handleNotification);
    try {
      await client.query(`UNLISTEN ${options.channel}`);
    } finally {
      client.release();
    }
  };
}
