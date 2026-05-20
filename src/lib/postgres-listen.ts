import {runInBackground} from "./async.js";
import type {PgListenClient, PgPoolLike} from "./postgres-query.js";

export const DEFAULT_POSTGRES_LISTEN_RECONNECT_DELAY_MS = 5_000;

export type PostgresListenStatus = "listening" | "reconnecting" | "closed";

export interface PostgresListenSnapshot {
  status: PostgresListenStatus;
  listening: boolean;
  channels: readonly string[];
  lastConnectedAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

export interface PostgresListenerChannel<TNotification = unknown> {
  channel: string;
  label: string;
  parse(payload: string | undefined): TNotification | null;
  listener(notification: TNotification): Promise<void> | void;
}

export interface PostgresListenerHandle {
  close(): Promise<void>;
  getSnapshot(): PostgresListenSnapshot;
}

export interface StartPostgresListenerOptions {
  pool: PgPoolLike<PgListenClient>;
  label: string;
  channels: readonly PostgresListenerChannel[];
  reconnectDelayMs?: number;
  onError?: (error: unknown) => Promise<void> | void;
  onStateChange?: (snapshot: PostgresListenSnapshot) => Promise<void> | void;
}

interface ActiveListenClient {
  client: PgListenClient;
  handleNotification(message: {channel: string; payload?: string}): void;
  handleError(error: unknown): void;
  handleEnd(): void;
  released: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueChannels(channels: readonly PostgresListenerChannel[]): readonly string[] {
  return [...new Set(channels.map((entry) => entry.channel))];
}

function cloneSnapshot(snapshot: PostgresListenSnapshot): PostgresListenSnapshot {
  return {
    ...snapshot,
    channels: [...snapshot.channels],
  };
}

/**
 * Subscribes one Postgres client to one or more notification channels and keeps
 * it self-healing after the initial successful LISTEN setup.
 */
export async function startPostgresListener(options: StartPostgresListenerOptions): Promise<PostgresListenerHandle> {
  if (options.channels.length === 0) {
    throw new Error("Postgres listener requires at least one channel.");
  }

  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_POSTGRES_LISTEN_RECONNECT_DELAY_MS;
  const channels = uniqueChannels(options.channels);
  let snapshot: PostgresListenSnapshot = {
    status: "reconnecting",
    listening: false,
    channels,
    lastConnectedAt: null,
    lastErrorAt: null,
    lastError: null,
  };
  let activeClient: ActiveListenClient | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectPromise: Promise<void> | null = null;

  const getSnapshot = (): PostgresListenSnapshot => cloneSnapshot(snapshot);

  const emitState = (): void => {
    const currentSnapshot = getSnapshot();
    runInBackground(async () => {
      await options.onStateChange?.(currentSnapshot);
    }, {label: `${options.label} state change handler`});
  };

  const setSnapshot = (next: Omit<PostgresListenSnapshot, "channels">): void => {
    snapshot = {
      ...next,
      channels,
    };
    emitState();
  };

  const reportError = (error: unknown): void => {
    runInBackground(async () => {
      await options.onError?.(error);
    }, {label: `${options.label} error handler`});
  };

  const detachClient = (binding: ActiveListenClient): void => {
    binding.client.off("notification", binding.handleNotification);
    binding.client.off("error", binding.handleError);
    binding.client.off("end", binding.handleEnd);
  };

  const releaseClient = (binding: ActiveListenClient): void => {
    if (binding.released) {
      return;
    }

    binding.released = true;
    binding.client.release();
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectPromise = reconnect().finally(() => {
        reconnectPromise = null;
      });
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
  };

  const handleDisconnect = (binding: ActiveListenClient, error: unknown): void => {
    if (closed || activeClient !== binding) {
      return;
    }

    activeClient = null;
    detachClient(binding);
    try {
      releaseClient(binding);
    } catch (releaseError) {
      reportError(releaseError);
    }

    setSnapshot({
      status: "reconnecting",
      listening: false,
      lastConnectedAt: snapshot.lastConnectedAt,
      lastErrorAt: Date.now(),
      lastError: errorMessage(error),
    });
    reportError(error);
    scheduleReconnect();
  };

  const handleNotification = (message: {channel: string; payload?: string}): void => {
    for (const entry of options.channels) {
      if (entry.channel !== message.channel) {
        continue;
      }

      let notification: unknown | null;
      try {
        notification = entry.parse(message.payload);
      } catch (error) {
        reportError(error);
        continue;
      }

      if (notification === null) {
        continue;
      }

      runInBackground(async () => {
        await entry.listener(notification);
      }, {
        label: entry.label,
        onError: options.onError,
      });
    }
  };

  const bindClient = (client: PgListenClient): ActiveListenClient => {
    let binding!: ActiveListenClient;
    const handleClientError = (error: unknown): void => {
      handleDisconnect(binding, error);
    };
    const handleClientEnd = (): void => {
      handleDisconnect(binding, new Error("Postgres LISTEN client ended."));
    };
    binding = {
      client,
      handleNotification,
      handleError: handleClientError,
      handleEnd: handleClientEnd,
      released: false,
    };
    client.on("notification", binding.handleNotification);
    client.on("error", binding.handleError);
    client.on("end", binding.handleEnd);
    return binding;
  };

  const connectAndListen = async (): Promise<ActiveListenClient> => {
    const client = await options.pool.connect();
    const binding = bindClient(client);
    try {
      for (const channel of channels) {
        await client.query(`LISTEN ${channel}`);
      }
    } catch (error) {
      detachClient(binding);
      releaseClient(binding);
      throw error;
    }

    return binding;
  };

  const closeBinding = async (binding: ActiveListenClient): Promise<void> => {
    detachClient(binding);
    try {
      for (const channel of [...channels].reverse()) {
        try {
          await binding.client.query(`UNLISTEN ${channel}`);
        } catch (error) {
          reportError(error);
        }
      }
    } finally {
      releaseClient(binding);
    }
  };

  async function reconnect(): Promise<void> {
    if (closed) {
      return;
    }

    try {
      const binding = await connectAndListen();
      if (closed) {
        await closeBinding(binding);
        return;
      }

      activeClient = binding;
      setSnapshot({
        status: "listening",
        listening: true,
        lastConnectedAt: Date.now(),
        lastErrorAt: snapshot.lastErrorAt,
        lastError: snapshot.lastError,
      });
    } catch (error) {
      if (closed) {
        return;
      }

      setSnapshot({
        status: "reconnecting",
        listening: false,
        lastConnectedAt: snapshot.lastConnectedAt,
        lastErrorAt: Date.now(),
        lastError: errorMessage(error),
      });
      reportError(error);
      scheduleReconnect();
    }
  }

  activeClient = await connectAndListen();
  setSnapshot({
    status: "listening",
    listening: true,
    lastConnectedAt: Date.now(),
    lastErrorAt: null,
    lastError: null,
  });

  return {
    getSnapshot,
    close: async (): Promise<void> => {
      if (closePromise) {
        return closePromise;
      }

      closePromise = (async () => {
        closed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        setSnapshot({
          status: "closed",
          listening: false,
          lastConnectedAt: snapshot.lastConnectedAt,
          lastErrorAt: snapshot.lastErrorAt,
          lastError: snapshot.lastError,
        });

        const binding = activeClient;
        activeClient = null;
        if (binding) {
          await closeBinding(binding);
        }

        await reconnectPromise;
        const reconnectedBinding = activeClient;
        activeClient = null;
        if (reconnectedBinding) {
          await closeBinding(reconnectedBinding);
        }
      })();
      return closePromise;
    },
  };
}

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
  onError?: (error: unknown) => Promise<void> | void;
  onStateChange?: (snapshot: PostgresListenSnapshot) => Promise<void> | void;
  reconnectDelayMs?: number;
}): Promise<() => Promise<void>> {
  const handle = await startPostgresListener({
    pool: options.pool,
    label: options.label,
    channels: [{
      channel: options.channel,
      label: options.label,
      parse: options.parse,
      listener: options.listener,
    }],
    onError: options.onError,
    onStateChange: options.onStateChange,
    reconnectDelayMs: options.reconnectDelayMs,
  });

  return () => handle.close();
}
