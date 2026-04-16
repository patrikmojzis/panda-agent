import type {Pool} from "pg";

import {createPostgresPool, requireDatabaseUrl} from "./database.js";

interface SchemaResource {
  ensureSchema(): Promise<void>;
}

export async function withPostgresPool<T>(
  dbUrl: string | undefined,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = createPostgresPool(requireDatabaseUrl(dbUrl));

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
