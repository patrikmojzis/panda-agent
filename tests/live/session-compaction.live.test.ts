import {randomUUID} from "node:crypto";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresConnectorLeaseRepo} from "../../src/domain/connector-leases/repo.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {PostgresSessionArchive} from "../../src/domain/sessions/archive.js";
import {resetSessionCurrentThread} from "../../src/domain/sessions/lifecycle.js";
import {PostgresSessionCompactionStore} from "../../src/domain/sessions/compaction-postgres.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {RuntimeRequestRepo} from "../../src/domain/threads/requests/repo.js";
import {processSessionCompaction} from "../../src/domain/threads/runtime/session-compaction.js";
import {createCompactBoundaryMessage} from "../../src/kernel/transcript/compaction.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

describe("session compaction on PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let sessions: PostgresSessionStore;
  let threads: PostgresThreadRuntimeStore;
  let requests: PostgresSessionCompactionStore;
  let leases: PostgresConnectorLeaseRepo;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({connectionString: target.connectionString, applicationName: "panda/compaction-live-test", max: 4});
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    await new PostgresAgentStore({pool}).bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    sessions = new PostgresSessionStore({pool});
    threads = new PostgresThreadRuntimeStore({pool});
    requests = new PostgresSessionCompactionStore(pool);
    leases = new PostgresConnectorLeaseRepo({pool});
  });
  afterAll(async () => { await pool?.end(); });

  async function lane() {
    const sessionId = randomUUID();
    const threadId = randomUUID();
    await sessions.createSession({id: sessionId, agentKey: "panda", kind: "branch", currentThreadId: threadId});
    const thread = await threads.createThread({id: threadId, sessionId});
    const owner = {source: "test", connectorKey: threadId, holderId: randomUUID()};
    await leases.tryAcquire({...owner, ttlMs: 120_000});
    await threads.requestWake(threadId);
    const run = (await threads.tryStartRun(threadId, owner, randomUUID()))!;
    return {sessionId, threadId, thread, run, owner};
  }

  liveIt("coalesces concurrent requests and atomically records one completion", async () => {
    const h = await lane();
    const results = await Promise.all(Array.from({length: 4}, () => requests.request(h.sessionId, h.run.id, "Keep the constraints.")));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await threads.hasPendingWake(h.threadId)).toBe(true);
    const completed = await requests.complete(results[0]!, h.run.id, {status: "skipped", reason: "Too little history."});
    expect(completed).toMatchObject({threadId: h.threadId, source: "runtime", metadata: {status: "skipped"}});
    expect(await requests.read(h.sessionId)).toBeNull();
    expect(await requests.complete(results[0]!, h.run.id, {status: "skipped", reason: "Too little history."})).toBeNull();
    expect((await threads.loadActiveTranscript(h.threadId)).records).toHaveLength(1);
  });

  liveIt("rejects another session, aborted runs, and expired ownership", async () => {
    const h = await lane();
    const other = await lane();
    await expect(requests.request(other.sessionId, h.run.id, "")).rejects.toThrow("no longer owned");
    await threads.requestRunAbort(h.threadId, "Stop");
    await expect(requests.request(h.sessionId, h.run.id, "")).rejects.toThrow("no longer owned");
    await leases.release(other.owner);
    await expect(requests.request(other.sessionId, other.run.id, "")).rejects.toThrow("no longer owned");
  });

  liveIt("recovers a lost settlement response from its durable outcome receipt", async () => {
    const h = await lane();
    const request = await requests.request(h.sessionId, h.run.id, "");
    let lost = false;
    const ambiguous = new PostgresSessionCompactionStore({
      async query(sql, params) {
        const result = await pool.query(sql, params ? [...params] : []);
        if (!lost && sql.includes("settled AS")) {
          lost = true;
          throw new Error("Connection lost after settlement");
        }
        return result;
      },
    });
    expect(await ambiguous.complete(request, h.run.id, {status: "skipped", reason: "Too little history."})).toMatchObject({
      id: request.outcomeId, metadata: {status: "skipped"},
    });
    expect(await requests.read(h.sessionId)).toBeNull();
    expect((await threads.loadActiveTranscript(h.threadId)).records).toHaveLength(1);
  });

  liveIt("preserves a pending request across reset and settles only into the current thread", async () => {
    const h = await lane();
    const request = await requests.request(h.sessionId, h.run.id, "Preserve pending work.");
    const reset = await new RuntimeRequestRepo({pool}).enqueueRequest({kind: "reset_session", payload: {source: "test", sessionId: h.sessionId}});
    await threads.requestRunAbort(h.threadId, "Reset", reset.id, {blocksNewRuns: true});
    await threads.failRun(h.run.id, "Reset");
    const nextId = randomUUID();
    await resetSessionCurrentThread({
      pool, sessionStore: sessions, threadStore: threads, owner: h.owner,
      previousThreadId: h.threadId,
      session: {sessionId: h.sessionId, currentThreadId: nextId},
      thread: {id: nextId, sessionId: h.sessionId, replacesThreadId: h.threadId},
    });
    await threads.requestWake(nextId);
    const nextRun = (await threads.tryStartRun(nextId, h.owner, randomUUID()))!;
    const restartedRequests = new PostgresSessionCompactionStore(pool);
    expect(await restartedRequests.read(h.sessionId)).toEqual(request);
    await expect(restartedRequests.complete(request, h.run.id, {status: "skipped", reason: "Old run"})).rejects.toThrow("no longer owned");
    expect(await restartedRequests.complete(request, nextRun.id, {status: "skipped", reason: "Fresh thread"})).toMatchObject({threadId: nextId});
  });

  liveIt("clears pending compaction on archive so restore cannot replay it", async () => {
    const h = await lane();
    await requests.request(h.sessionId, h.run.id, "");
    await threads.requestRunAbort(h.threadId, "Archive");
    await threads.failRun(h.run.id, "Archive");
    await pool.query('UPDATE "runtime"."threads" SET run_claims_blocked_at = NOW() WHERE id = $1', [h.threadId]);
    const archive = new PostgresSessionArchive({pool, sessions, threads});
    await archive.archive({sessionId: h.sessionId, expectedThreadId: h.threadId, owner: h.owner});
    await archive.restore({sessionId: h.sessionId, expectedThreadId: h.threadId, owner: h.owner});
    expect(await requests.read(h.sessionId)).toBeNull();
    expect(await threads.hasPendingWake(h.threadId)).toBe(false);
  });

  liveIt("rearms interrupted compaction and replays a committed receipt without a provider call", async () => {
    const h = await lane();
    const old = await threads.appendRuntimeMessage(h.threadId, {runId: h.run.id, source: "runtime",
      message: {role: "user", content: "Earlier work", timestamp: 1}});
    const request = await requests.request(h.sessionId, h.run.id, "");
    await threads.takeRunBoundary(h.threadId, h.run.id);
    await threads.commitCompaction(h.threadId, {
      id: request.id, runId: h.run.id, expectedCheckpointId: null,
      message: createCompactBoundaryMessage("Earlier work summarized."),
      metadata: {kind: "compact_boundary", trigger: "manual", compactedThroughSequence: old.sequence,
        preservedTailUserTurns: 0, tokensBefore: 1000, tokensAfter: 100},
    });
    await threads.failRun(h.run.id, "Connection lost after checkpoint commit");
    expect(await threads.hasPendingWake(h.threadId)).toBe(true);
    const nextRun = (await threads.tryStartRun(h.threadId, h.owner, randomUUID()))!;
    await processSessionCompaction({requests, threads, thread: h.thread, run: nextRun,
      transcript: await threads.loadActiveTranscript(h.threadId), model: "invalid/no-provider-needed",
      signal: new AbortController().signal});
    expect(await requests.read(h.sessionId)).toBeNull();
    expect((await threads.loadActiveTranscript(h.threadId)).records.at(-1)?.metadata).toMatchObject({status: "compacted", tokensBefore: 1000, tokensAfter: 100});
  });

  liveIt("rearms a pending request when a daemon dies after consuming its wake", async () => {
    const h = await lane();
    await requests.request(h.sessionId, h.run.id, "");
    await threads.takeRunBoundary(h.threadId, h.run.id);
    expect(await threads.hasPendingWake(h.threadId)).toBe(false);
    await leases.release(h.owner);
    const successor = {...h.owner, holderId: randomUUID()};
    await leases.tryAcquire({...successor, ttlMs: 120_000});
    await threads.failOrphanedRuns(successor, "Daemon restarted", 100);
    expect(await threads.hasPendingWake(h.threadId)).toBe(true);
    expect(await requests.read(h.sessionId)).not.toBeNull();
  });
});
