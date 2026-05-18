import {createHash} from "node:crypto";

import type {ThreadLease, ThreadLeaseManager} from "./coordinator.js";
import type {PgPoolLike} from "../../../lib/postgres-query.js";

/** Thread lease manager backed by Postgres advisory locks. */
export class PostgresThreadLeaseManager implements ThreadLeaseManager {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async tryAcquire(threadId: string): Promise<ThreadLease | null> {
    const client = await this.pool.connect();
    const [keyA, keyB] = hashThreadLeaseKey(threadId);

    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [keyA, keyB],
      );

      const acquired = parseAdvisoryLockAcquired(
        (result.rows[0] as Record<string, unknown> | undefined)?.acquired,
      );
      if (!acquired) {
        client.release();
        return null;
      }

      let released = false;
      return {
        threadId,
        release: async () => {
          if (released) {
            return;
          }

          released = true;

          try {
            await client.query("SELECT pg_advisory_unlock($1, $2)", [keyA, keyB]);
          } finally {
            client.release();
          }
        },
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }
}

function hashThreadLeaseKey(threadId: string): readonly [number, number] {
  const digest = createHash("sha256").update(threadId).digest();
  return [
    digest.readInt32BE(0),
    digest.readInt32BE(4),
  ] as const;
}

function parseAdvisoryLockAcquired(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  throw new Error("Thread lease acquisition result must be a boolean.");
}
