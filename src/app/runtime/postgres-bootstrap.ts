import type {Pool} from "pg";

import {createPandaPool, requirePandaDatabaseUrl} from "./database.js";

interface SchemaResource {
  ensureSchema(): Promise<void>;
}

export async function withPandaPool<T>(
  dbUrl: string | undefined,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = createPandaPool(requirePandaDatabaseUrl(dbUrl));

  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export async function ensureSchemas(
  resources: readonly (SchemaResource | null | undefined)[],
): Promise<void> {
  for (const resource of resources) {
    if (!resource) {
      continue;
    }

    await resource.ensureSchema();
  }
}
