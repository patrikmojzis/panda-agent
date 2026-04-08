import type { Pool, PoolClient } from "pg";

export interface PgQueryable {
  query: Pool["query"];
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export async function withTransaction<T>(pool: PgPoolLike, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
