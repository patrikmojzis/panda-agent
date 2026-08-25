import {afterEach, describe, expect, it} from "vitest";
import {newDb} from "pg-mem";

import {ensurePostgresRuntimeOperationReceiptSchema} from "../src/domain/threads/requests/postgres-operation-schema.js";

describe("runtime operation receipt schema convergence", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) await pools.pop()!.end();
  });

  it("adds request ownership to pre-existing thread receipts and cascades every receipt", async () => {
    const adapter = newDb({noAstCoverageCheck: true}).adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    await pool.query("CREATE SCHEMA runtime");
    await pool.query("CREATE TABLE runtime.runtime_requests (id UUID PRIMARY KEY)");
    await pool.query("CREATE TABLE runtime.agent_sessions (id TEXT PRIMARY KEY)");
    await pool.query(`
      CREATE TABLE runtime.threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        UNIQUE (session_id, id)
      )
    `);
    await pool.query(`
      CREATE TABLE runtime.thread_abort_operations (
        operation_id UUID PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id UUID,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE runtime.thread_compaction_noop_operations (
        operation_id UUID PRIMARY KEY,
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (session_id, thread_id)
          REFERENCES runtime.threads(session_id, id) ON DELETE CASCADE
      )
    `);

    await ensurePostgresRuntimeOperationReceiptSchema(pool);
    const operationId = "11111111-1111-4111-8111-111111111111";
    await pool.query("INSERT INTO runtime.agent_sessions (id) VALUES ('session-1')");
    await pool.query("INSERT INTO runtime.threads (id, session_id) VALUES ('thread-1', 'session-1')");
    await pool.query("INSERT INTO runtime.runtime_requests (id) VALUES ($1)", [operationId]);
    await pool.query(`INSERT INTO runtime.thread_abort_operations (operation_id, thread_id, reason) VALUES ($1, 'thread-1', 'stop')`, [operationId]);
    await pool.query(`INSERT INTO runtime.thread_compaction_noop_operations (operation_id, session_id, thread_id) VALUES ($1, 'session-1', 'thread-1')`, [operationId]);
    await pool.query(`INSERT INTO runtime.session_runtime_config_operations (operation_id, session_id, thread_id) VALUES ($1, 'session-1', 'thread-1')`, [operationId]);
    await pool.query(`INSERT INTO runtime.session_creation_operations (operation_id, identity_id, agent_key, session_id, thread_id, kind) VALUES ($1, 'identity-1', 'panda', 'session-1', 'thread-1', 'main')`, [operationId]);

    await pool.query("DELETE FROM runtime.runtime_requests WHERE id = $1", [operationId]);

    for (const table of [
      "thread_abort_operations",
      "thread_compaction_noop_operations",
      "session_runtime_config_operations",
      "session_creation_operations",
    ]) {
      await expect(pool.query(`SELECT operation_id FROM runtime.${table}`)).resolves.toMatchObject({rows: []});
    }
  });
});
