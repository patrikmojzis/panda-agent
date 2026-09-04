import type {PgQueryable} from "../../lib/postgres-query.js";

export async function ensureSessionCompactionSchema(queryable: PgQueryable): Promise<void> {
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS "runtime"."session_compaction_requests" (
      session_id TEXT PRIMARY KEY REFERENCES "runtime"."agent_sessions" (id) ON DELETE CASCADE,
      id UUID NOT NULL UNIQUE,
      outcome_id UUID NOT NULL UNIQUE,
      instructions TEXT NOT NULL CHECK (char_length(instructions) <= 4096),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
