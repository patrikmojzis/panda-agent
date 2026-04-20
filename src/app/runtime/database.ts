import {Pool} from "pg";

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

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function resolveDatabaseUrl(explicitDbUrl?: string): string | null {
  return (
    trimNonEmptyString(explicitDbUrl)
    ?? trimNonEmptyString(process.env.DATABASE_URL)
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
  const rawValue = trimNonEmptyString(process.env[name]);
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
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

  const originalConnect = options.pool.connect.bind(options.pool) as () => Promise<unknown>;
  const originalQuery = options.pool.query.bind(options.pool) as (...args: unknown[]) => unknown;

  options.pool.connect = (async () => {
    try {
      return await originalConnect();
    } catch (error) {
      logError("connect", error);
      throw error;
    }
  }) as Pool["connect"];

  options.pool.query = ((...args: unknown[]) => {
    const result = originalQuery(...args);
    if (typeof args.at(-1) === "function" || !(result instanceof Promise)) {
      return result;
    }

    return result.catch((error) => {
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
