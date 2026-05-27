import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {RuntimeRequestDrain} from "../src/app/runtime/request-drain.js";
import {
  createDaemonRequestProcessor,
  UNSUPPORTED_CREATE_WORKER_SESSION_REQUEST_ERROR,
} from "../src/app/runtime/daemon-requests.js";
import {ensureSchemas} from "../src/app/runtime/postgres-bootstrap.js";
import {PostgresAgentStore} from "../src/domain/agents/postgres.js";
import {PostgresIdentityStore} from "../src/domain/identity/postgres.js";
import {PostgresExecutionEnvironmentStore} from "../src/domain/execution-environments/postgres.js";
import {buildExecutionEnvironmentTableNames} from "../src/domain/execution-environments/postgres-shared.js";
import {PostgresSessionStore} from "../src/domain/sessions/postgres.js";
import {buildSessionTableNames} from "../src/domain/sessions/postgres-shared.js";
import {RuntimeRequestRepo} from "../src/domain/threads/requests/repo.js";
import {buildRuntimeRequestTableNames} from "../src/domain/threads/requests/postgres-shared.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/postgres.js";
import {buildThreadRuntimeTableNames} from "../src/domain/threads/runtime/postgres-shared.js";
import {waitFor} from "./helpers/wait-for.js";

describe("runtime request drain stale legacy worker rows", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  function createPool() {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    return pool;
  }

  async function countRows(pool: {query(sql: string): Promise<{rows: readonly unknown[]}>}, table: string): Promise<number> {
    const result = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table}`);
    return Number((result.rows[0] as {count: number | string}).count);
  }

  it("claims stale persisted create_worker_session rows and fails them without creating runtime rows", async () => {
    const pool = createPool();
    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const sessionStore = new PostgresSessionStore({pool});
    const threadStore = new PostgresThreadRuntimeStore({pool});
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    const requests = new RuntimeRequestRepo({pool, staleRunningRequestMs: 1});
    await ensureSchemas([identityStore, agentStore, sessionStore, threadStore, environmentStore, requests]);

    const sessionTables = buildSessionTableNames();
    const threadTables = buildThreadRuntimeTableNames();
    const environmentTables = buildExecutionEnvironmentTableNames();
    const requestTables = buildRuntimeRequestTableNames();
    const before = {
      sessions: await countRows(pool, sessionTables.sessions),
      threads: await countRows(pool, threadTables.threads),
      environments: await countRows(pool, environmentTables.executionEnvironments),
      bindings: await countRows(pool, environmentTables.sessionEnvironmentBindings),
    };
    const staleClaimedAt = new Date(Date.now() - 10 * 60_000);
    await pool.query(`
      INSERT INTO ${requestTables.runtimeRequests} (
        id,
        kind,
        status,
        payload,
        claimed_at,
        created_at,
        updated_at
      ) VALUES (
        $1,
        'create_worker_session',
        'running',
        $2::jsonb,
        $3,
        $3,
        $3
      )
    `, [
      "00000000-0000-4000-8000-000000000016",
      JSON.stringify({sessionId: "stale-worker-session", role: "workspace"}),
      staleClaimedAt,
    ]);

    const unexpected = vi.fn(async () => {
      throw new Error("Legacy worker request must fail before helper side effects.");
    });
    const processRequest = createDaemonRequestProcessor({
      runtime: {
        coordinator: {
          abort: unexpected,
          resolveThreadRunConfig: unexpected,
          runExclusively: unexpected,
          submitInput: unexpected,
        },
        identityStore: {
          getIdentity: unexpected,
          resolveIdentityBinding: unexpected,
        },
        sessionStore: {
          getSession: unexpected,
          updateSessionRuntimeConfig: unexpected,
        },
        store: {
          appendRuntimeMessage: unexpected,
          getThread: unexpected,
          hasRunnableInputs: unexpected,
          loadTranscript: unexpected,
          updateThread: unexpected,
        },
      },
      a2aBindings: {
        hasBinding: unexpected,
        hasReceivedMessage: unexpected,
      },
      sessionRoutes: {
        saveLastRoute: unexpected,
      },
    }, {
      createBranchSession: unexpected,
      createSubagentSession: unexpected,
      ensureIdentity: unexpected,
      handleResetSession: unexpected,
      openMainSession: unexpected,
      queueSystemReply: unexpected,
      relocateThreadMedia: unexpected,
      resolveBoundConversationThread: unexpected,
      resolveOrCreateConversationThread: unexpected,
    });
    const drain = new RuntimeRequestDrain({
      requests,
      processRequest,
      pollIntervalMs: 1,
    });

    drain.start();
    await waitFor(async () => {
      const request = await requests.getRequest("00000000-0000-4000-8000-000000000016");
      expect(request.status).toBe("failed");
      expect(request.error).toBe(UNSUPPORTED_CREATE_WORKER_SESSION_REQUEST_ERROR);
    });
    await drain.stop();

    const failed = await requests.getRequest("00000000-0000-4000-8000-000000000016");
    expect(failed.kind).toBe("create_worker_session");
    expect(failed.claimedAt).toBeGreaterThan(staleClaimedAt.getTime());
    expect(unexpected).not.toHaveBeenCalled();
    await expect(countRows(pool, sessionTables.sessions)).resolves.toBe(before.sessions);
    await expect(countRows(pool, threadTables.threads)).resolves.toBe(before.threads);
    await expect(countRows(pool, environmentTables.executionEnvironments)).resolves.toBe(before.environments);
    await expect(countRows(pool, environmentTables.sessionEnvironmentBindings)).resolves.toBe(before.bindings);
  });
});
