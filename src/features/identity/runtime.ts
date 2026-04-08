import { Pool } from "pg";

import { PostgresIdentityStore } from "./postgres.js";

export interface IdentityRuntimeOptions {
  dbUrl?: string;
  tablePrefix?: string;
}

export interface IdentityRuntime {
  store: PostgresIdentityStore;
  close(): Promise<void>;
}

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function resolveIdentityDatabaseUrl(explicitDbUrl?: string): string | null {
  return (
    trimNonEmptyString(explicitDbUrl)
    ?? trimNonEmptyString(process.env.PANDA_DATABASE_URL)
    ?? trimNonEmptyString(process.env.DATABASE_URL)
  );
}

export function requireIdentityDatabaseUrl(explicitDbUrl?: string): string {
  const dbUrl = resolveIdentityDatabaseUrl(explicitDbUrl);
  if (dbUrl) {
    return dbUrl;
  }

  throw new Error("Identity management requires Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
}

export async function createIdentityRuntime(options: IdentityRuntimeOptions = {}): Promise<IdentityRuntime> {
  const pool = new Pool({
    connectionString: requireIdentityDatabaseUrl(options.dbUrl),
  });
  const store = new PostgresIdentityStore({
    pool,
    tablePrefix: options.tablePrefix,
  });

  try {
    await store.ensureSchema();
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    store,
    close: async () => {
      await pool.end();
    },
  };
}
