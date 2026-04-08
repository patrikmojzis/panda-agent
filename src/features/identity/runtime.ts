import { PostgresIdentityStore } from "./postgres.js";
import { createPandaPool, resolvePandaDatabaseUrl } from "../panda/runtime.js";

export interface IdentityRuntimeOptions {
  dbUrl?: string;
  tablePrefix?: string;
}

export interface IdentityRuntime {
  store: PostgresIdentityStore;
  close(): Promise<void>;
}

export function requireIdentityDatabaseUrl(explicitDbUrl?: string): string {
  const dbUrl = resolvePandaDatabaseUrl(explicitDbUrl);
  if (dbUrl) {
    return dbUrl;
  }

  throw new Error("Identity management requires Postgres. Pass --db-url or set PANDA_DATABASE_URL.");
}

export async function createIdentityRuntime(options: IdentityRuntimeOptions = {}): Promise<IdentityRuntime> {
  const pool = createPandaPool(requireIdentityDatabaseUrl(options.dbUrl));
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
