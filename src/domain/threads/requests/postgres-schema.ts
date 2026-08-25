import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../../lib/postgres-relations.js";
import {addConstraint} from "../../../lib/postgres-integrity.js";
import {isJsonObject, type JsonObject} from "../../../lib/json.js";

import {type PgQueryable} from "../../../lib/postgres-query.js";
import {buildRuntimeRequestTableNames} from "./postgres-shared.js";
import {deriveRuntimeRequestOrderingKey} from "./ordering-key.js";
import {
  RUNTIME_REQUEST_KINDS,
  RUNTIME_REQUEST_STATUSES,
  type CreateRuntimeRequestInput,
  type RuntimeRequestKind,
} from "./types.js";
import {ensurePostgresRuntimeOperationReceiptSchema} from "./postgres-operation-schema.js";

export async function ensurePostgresRuntimeRequestSchema(pool: PgQueryable): Promise<void> {
  const tables = buildRuntimeRequestTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.runtimeRequests} (
      id UUID PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload JSONB NOT NULL,
      ordering_key TEXT NOT NULL,
      idempotency_key TEXT,
      result JSONB,
      error TEXT,
      claimed_at TIMESTAMPTZ,
      claim_token UUID,
      claim_expires_at TIMESTAMPTZ,
      execution_attempts INTEGER NOT NULL DEFAULT 0,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ${tables.runtimeRequests} ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
  await pool.query(`ALTER TABLE ${tables.runtimeRequests} ADD COLUMN IF NOT EXISTS ordering_key TEXT`);
  await pool.query(`ALTER TABLE ${tables.runtimeRequests} ADD COLUMN IF NOT EXISTS claim_token UUID`);
  await pool.query(`ALTER TABLE ${tables.runtimeRequests} ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE ${tables.runtimeRequests} ADD COLUMN IF NOT EXISTS execution_attempts INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`DELETE FROM ${tables.runtimeRequests} WHERE kind = 'create_worker_session'`);
  // Resource ids became mandatory so replay can converge on one effect. Finish
  // old queued create requests deterministically instead of retaining random-id
  // behavior behind an optional compatibility path.
  const parseMigrationPayload = (row: Record<string, unknown>): JsonObject => {
    const value = typeof row.payload === "string" ? JSON.parse(row.payload) as unknown : row.payload;
    if (!isJsonObject(value)) {
      throw new Error(`Cannot migrate runtime request ${String(row.id)} with a non-object payload.`);
    }
    return value;
  };
  const legacyCreates = await pool.query(`
    SELECT id, kind, payload
    FROM ${tables.runtimeRequests}
    WHERE kind IN ('create_branch_session', 'create_subagent_session')
  `);
  for (const row of legacyCreates.rows as Array<Record<string, unknown>>) {
    const payload = parseMigrationPayload(row);
    const prefix = row.kind === "create_branch_session" ? "branch" : "subagent";
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim()
      ? payload.sessionId
      : `${prefix}-session:${String(row.id)}`;
    const threadId = typeof payload.threadId === "string" && payload.threadId.trim()
      ? payload.threadId
      : `${prefix}-thread:${String(row.id)}`;
    await pool.query(`UPDATE ${tables.runtimeRequests} SET payload = $2::jsonb WHERE id = $1`, [
      row.id,
      JSON.stringify({...payload, sessionId, threadId}),
    ]);
  }
  const liveVoiceTable = await pool.query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'runtime' AND table_name = 'live_voice_turns'
    LIMIT 1
  `);
  const legacyVoiceRequests = await pool.query(`
    SELECT id, payload
    FROM ${tables.runtimeRequests}
    WHERE kind = 'live_voice_delegation'
  `);
  for (const row of legacyVoiceRequests.rows as Array<Record<string, unknown>>) {
    const payload = parseMigrationPayload(row);
    if (typeof payload.sessionId === "string" && payload.sessionId.trim()) continue;
    let sessionId: string | undefined;
    if (liveVoiceTable.rows.length > 0 && typeof payload.liveVoiceTurnId === "string") {
      const turn = await pool.query(
        `SELECT session_id FROM "runtime"."live_voice_turns" WHERE id::text = $1`,
        [payload.liveVoiceTurnId],
      );
      const value = (turn.rows[0] as {session_id?: unknown} | undefined)?.session_id;
      if (typeof value === "string" && value.trim()) sessionId = value;
    }
    if (sessionId) {
      await pool.query(`UPDATE ${tables.runtimeRequests} SET payload = $2::jsonb WHERE id = $1`, [
        row.id,
        JSON.stringify({...payload, sessionId}),
      ]);
    } else {
      // An orphaned delegation cannot be routed after the hard cut. The voice
      // migration independently terminalizes interrupted turns.
      await pool.query(`DELETE FROM ${tables.runtimeRequests} WHERE id = $1`, [row.id]);
    }
  }
  // A pre-ledger running request may already have committed its side effect
  // before losing settlement. Those requests predate stable operation ids, so
  // replay could reset a session twice or enqueue a duplicate control reply.
  // Fail them closed; only requests that were never claimed remain replayable.
  await pool.query(`
    UPDATE ${tables.runtimeRequests}
    SET status = 'failed',
        error = 'Legacy running runtime request was interrupted by schema migration and cannot be replayed safely.',
        claim_token = NULL,
        claim_expires_at = NULL,
        finished_at = NOW(),
        updated_at = NOW()
    WHERE status = 'running'
  `);
  const missingOrderingKeys = await pool.query(`
    SELECT id, kind, payload
    FROM ${tables.runtimeRequests}
    WHERE ordering_key IS NULL
    ORDER BY created_at, id
  `);
  for (const row of missingOrderingKeys.rows as Array<Record<string, unknown>>) {
    if (typeof row.kind !== "string" || !RUNTIME_REQUEST_KINDS.includes(row.kind as RuntimeRequestKind)) {
      throw new Error(`Cannot migrate runtime request ${String(row.id)} with unsupported kind ${String(row.kind)}.`);
    }
    const kind = row.kind as RuntimeRequestKind;
    const orderingKey = deriveRuntimeRequestOrderingKey({
      kind,
      payload: row.payload,
    } as CreateRuntimeRequestInput);
    await pool.query(`
      UPDATE ${tables.runtimeRequests}
      SET ordering_key = $2
      WHERE id = $1 AND ordering_key IS NULL
    `, [row.id, orderingKey]);
  }
  await pool.query(`ALTER TABLE ${tables.runtimeRequests} ALTER COLUMN ordering_key SET NOT NULL`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runtime_requests_idempotency_idx`)}
    ON ${tables.runtimeRequests} (idempotency_key)
  `);
  await pool.query(`
    DROP INDEX IF EXISTS ${quoteIdentifier(tables.prefix)}.${quoteIdentifier(`${tables.prefix}_runtime_requests_claimable_idx`)}
  `);
  await pool.query(`DROP INDEX IF EXISTS ${quoteIdentifier(tables.prefix)}.${quoteIdentifier(`${tables.prefix}_runtime_requests_pending_idx`)}`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runtime_requests_settled_idx`)}
    ON ${tables.runtimeRequests} (status, finished_at, id)
    WHERE status IN ('completed', 'failed')
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runtime_requests_running_key_idx`)}
    ON ${tables.runtimeRequests} (ordering_key)
    WHERE status = 'running'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runtime_requests_unsettled_key_idx`)}
    ON ${tables.runtimeRequests} (ordering_key, created_at, id)
    WHERE status IN ('pending', 'running')
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_runtime_requests_unsettled_fifo_idx`)}
    ON ${tables.runtimeRequests} (created_at, id)
    WHERE status IN ('pending', 'running')
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.runtimeRequests}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_runtime_requests_kind_check`)}
    CHECK (kind IN (${RUNTIME_REQUEST_KINDS.map((kind) => `'${kind}'`).join(", ")}))
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.runtimeRequests}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_runtime_requests_ordering_key_check`)}
    CHECK (ordering_key LIKE 'v1:%')
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.runtimeRequests}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_runtime_requests_lifecycle_check`)}
    CHECK (
      (
        status = 'pending'
        AND claimed_at IS NULL
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
        AND finished_at IS NULL
      ) OR (
        status = 'running'
        AND claimed_at IS NOT NULL
        AND claim_token IS NOT NULL
        AND claim_expires_at IS NOT NULL
        AND finished_at IS NULL
      ) OR (
        status IN ('completed', 'failed')
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
        AND finished_at IS NOT NULL
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.runtimeRequests}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_runtime_requests_status_check`)}
    CHECK (status IN (${RUNTIME_REQUEST_STATUSES.map((status) => `'${status}'`).join(", ")}))
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.runtimeRequests}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_runtime_requests_execution_attempts_check`)}
    CHECK (execution_attempts >= 0)
  `);
  await ensurePostgresRuntimeOperationReceiptSchema(pool);
}
