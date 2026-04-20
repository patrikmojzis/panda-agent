import {Pool} from "pg";

import {isDuplicateObjectError} from "../../lib/postgres-errors.js";
import {trimToNull} from "../../lib/strings.js";

export const DEFAULT_POSTGRES_POOL_MAX = 10;
export const DEFAULT_POSTGRES_POOL_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_POSTGRES_POOL_WAITING_LOG_INTERVAL_MS = 60_000;

export interface CreatePostgresPoolOptions {
  connectionString: string;
  applicationName?: string;
  max?: number;
  idleTimeoutMillis?: number;
}

export interface PostgresPoolObserverOptions {
  pool: Pool;
  applicationName: string;
  max?: number;
  idleTimeoutMillis?: number;
  waitingLogIntervalMs?: number;
  log(event: string, payload: Record<string, unknown>): void;
}

export interface PostgresPoolObserver {
  stop(): void;
}

export function resolveDatabaseUrl(explicitDbUrl?: string): string | null {
  return (
    trimToNull(explicitDbUrl)
    ?? trimToNull(process.env.DATABASE_URL)
  );
}

export function requireDatabaseUrl(explicitDbUrl?: string): string {
  const dbUrl = resolveDatabaseUrl(explicitDbUrl);
  if (dbUrl) {
    return dbUrl;
  }

  throw new Error("Panda requires Postgres. Pass --db-url or set DATABASE_URL.");
}

export function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = trimToNull(process.env[name]);
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

/**
 * Builds the standard observed Postgres pool config using Panda's shared env
 * knobs for max connections, idle timeout, and waiting-queue logging.
 */
export function buildObservedPoolConfig(applicationName: string, maxEnvKey: string, fallbackMax: number): {
  applicationName: string;
  max: number;
  idleTimeoutMillis: number;
  waitingLogIntervalMs: number;
} {
  return {
    applicationName,
    max: readPositiveIntegerEnv(maxEnvKey, fallbackMax),
    idleTimeoutMillis: readPositiveIntegerEnv(
      "PANDA_DB_POOL_IDLE_TIMEOUT_MS",
      DEFAULT_POSTGRES_POOL_IDLE_TIMEOUT_MS,
    ),
    waitingLogIntervalMs: readPositiveIntegerEnv(
      "PANDA_DB_POOL_WAITING_LOG_INTERVAL_MS",
      DEFAULT_POSTGRES_POOL_WAITING_LOG_INTERVAL_MS,
    ),
  };
}

function buildPoolStats(options: {
  pool: Pool;
  applicationName: string;
  max: number;
  idleTimeoutMillis: number;
}): Record<string, unknown> {
  return {
    applicationName: options.applicationName,
    max: options.max,
    idleTimeoutMillis: options.idleTimeoutMillis,
    totalCount: options.pool.totalCount,
    idleCount: options.pool.idleCount,
    waitingCount: options.pool.waitingCount,
  };
}

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      message: String(error),
    };
  }

  const described: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  const candidate = error as Error & {
    code?: unknown;
    severity?: unknown;
    detail?: unknown;
  };
  if (typeof candidate.code === "string" || typeof candidate.code === "number") {
    described.code = candidate.code;
  }
  if (typeof candidate.severity === "string") {
    described.severity = candidate.severity;
  }
  if (typeof candidate.detail === "string" && candidate.detail.trim().length > 0) {
    described.detail = candidate.detail;
  }

  return described;
}

export function createPostgresPool(options: CreatePostgresPoolOptions): Pool {
  const max = options.max ?? DEFAULT_POSTGRES_POOL_MAX;
  const idleTimeoutMillis = options.idleTimeoutMillis ?? DEFAULT_POSTGRES_POOL_IDLE_TIMEOUT_MS;

  return new Pool({
    connectionString: options.connectionString,
    max,
    idleTimeoutMillis,
    ...(options.applicationName ? {application_name: options.applicationName} : {}),
  });
}

export function observePostgresPool(options: PostgresPoolObserverOptions): PostgresPoolObserver {
  const max = options.max ?? DEFAULT_POSTGRES_POOL_MAX;
  const idleTimeoutMillis = options.idleTimeoutMillis ?? DEFAULT_POSTGRES_POOL_IDLE_TIMEOUT_MS;
  const waitingLogIntervalMs = options.waitingLogIntervalMs ?? DEFAULT_POSTGRES_POOL_WAITING_LOG_INTERVAL_MS;
  const logStats = (reason: string, extra: Record<string, unknown> = {}): void => {
    options.log("postgres_pool_stats", {
      reason,
      ...buildPoolStats({
        pool: options.pool,
        applicationName: options.applicationName,
        max,
        idleTimeoutMillis,
      }),
      ...extra,
    });
  };
  const logError = (reason: string, error: unknown): void => {
    options.log("postgres_pool_error", {
      reason,
      ...buildPoolStats({
        pool: options.pool,
        applicationName: options.applicationName,
        max,
        idleTimeoutMillis,
      }),
      ...describeError(error),
    });
  };

  const handlePoolError = (error: Error): void => {
    logError("pool", error);
  };
  options.pool.on("error", handlePoolError);

  const originalConnect = options.pool.connect.bind(options.pool) as (...args: unknown[]) => unknown;
  const originalQuery = options.pool.query.bind(options.pool) as (...args: unknown[]) => unknown;

  // `pg.Pool.query()` internally calls `pool.connect(callback)`, so the observer
  // must preserve both the callback and promise overloads here.
  options.pool.connect = ((...args: unknown[]) => {
    const callback = args[0];
    if (typeof callback === "function") {
      return originalConnect((error: unknown, client: unknown, done: unknown) => {
        if (error) {
          logError("connect", error);
        }
        callback(error, client, done);
      });
    }

    const result = originalConnect();
    if (!result || typeof (result as {catch?: unknown}).catch !== "function") {
      return result;
    }

    return (result as Promise<unknown>).catch((error) => {
      logError("connect", error);
      throw error;
    });
  }) as Pool["connect"];

  options.pool.query = ((...args: unknown[]) => {
    const result = originalQuery(...args);
    if (
      typeof args.at(-1) === "function"
      || !result
      || typeof (result as {catch?: unknown}).catch !== "function"
    ) {
      return result;
    }

    return (result as Promise<unknown>).catch((error) => {
      if (isDuplicateObjectError(error)) {
        throw error;
      }
      logError("query", error);
      throw error;
    });
  }) as Pool["query"];

  const interval = setInterval(() => {
    if (options.pool.waitingCount > 0) {
      logStats("waiting");
    }
  }, waitingLogIntervalMs);
  interval.unref();

  logStats("startup");

  return {
    stop(): void {
      clearInterval(interval);
      options.pool.off("error", handlePoolError);
      options.pool.connect = originalConnect as Pool["connect"];
      options.pool.query = originalQuery as Pool["query"];
    },
  };
}
