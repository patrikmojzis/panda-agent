import type {PgClientLike, PgPoolLike} from "./postgres-query.js";

/** Runs a callback inside a Postgres transaction and always releases the client. */
export async function withTransaction<T>(
  pool: PgPoolLike,
  fn: (client: PgClientLike) => Promise<T>,
): Promise<T> {
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
