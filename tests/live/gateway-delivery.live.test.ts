import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, mkdir, writeFile, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresConnectorLeaseRepo} from "../../src/domain/connector-leases/repo.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {GatewayDeliveryTargetUnavailableError, PostgresGatewayStore} from "../../src/domain/gateway/postgres.js";
import {PostgresIdentityStore} from "../../src/domain/identity/postgres.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {createSessionWithInitialThread, resetSessionCurrentThread} from "../../src/domain/sessions/lifecycle.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {startGatewayWorker} from "../../src/integrations/gateway/worker.js";
import type {PgPoolLike} from "../../src/lib/postgres-query.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;
const owner = {source: "panda-core", connectorKey: "primary", holderId: "gateway-delivery-test"};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return {promise, release};
}

describe.sequential("atomic Gateway delivery with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let store: PostgresGatewayStore;
  let sessions: PostgresSessionStore;
  let threads: PostgresThreadRuntimeStore;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({connectionString: target.connectionString, applicationName: "panda/gateway-delivery-live", max: 5});
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    await new PostgresAgentStore({pool}).bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await new PostgresIdentityStore({pool}).createIdentity({id: "gateway-actor", handle: "gateway-test", displayName: "Gateway test"});
    await new PostgresConnectorLeaseRepo({pool}).tryAcquire({...owner, ttlMs: 120_000});
    store = new PostgresGatewayStore({pool});
    sessions = new PostgresSessionStore({pool});
    threads = new PostgresThreadRuntimeStore({pool});
  });
  afterAll(async () => { await pool?.end(); });

  async function fixture(mode: "queue" | "wake" = "wake", legacyEventId?: string) {
    const id = randomUUID();
    const sessionId = `gateway-${id}`;
    const threadId = `gateway-thread-${id}`;
    await createSessionWithInitialThread({pool, sessionStore: sessions, threadStore: threads,
      session: {id: sessionId, agentKey: "panda", kind: "branch", currentThreadId: threadId}, thread: {id: threadId, sessionId}});
    const {source} = await store.createSource({sourceId: `gateway-${id}`, agentKey: "panda", identityId: "gateway-actor", sessionId});
    await store.upsertEventType({sourceId: source.sourceId, type: "test.event", delivery: mode, trusted: false});
    const text = "Guarded event";
    let {event} = await store.storeEvent({sourceId: source.sourceId, type: "test.event", deliveryRequested: mode,
      idempotencyKey: id, text, textBytes: Buffer.byteLength(text), textSha256: createHash("sha256").update(text).digest("hex")});
    if (legacyEventId) {
      await pool.query("UPDATE runtime.gateway_events SET id = $2 WHERE id = $1", [event.id, legacyEventId]);
      event = await store.getEvent(legacyEventId);
    }
    const claimId = randomUUID();
    await pool.query("UPDATE runtime.gateway_events SET status = 'processing', claim_id = $2, claimed_at = NOW() WHERE id = $1", [event.id, claimId]);
    const assessed = await store.recordEventAssessment({eventId: event.id, claimId, riskScore: 0.1, metadata: {gateway: {guardStatus: "scored", trusted: false}}});
    if (!assessed?.inputId) throw new Error("Missing assessment receipt");
    const attachmentId = randomUUID();
    await pool.query(`INSERT INTO runtime.gateway_attachments
      (id,source_id,idempotency_key,status,scan_status,mime_type,size_bytes,sha256,local_path,media_source,connector_key,expires_at)
      VALUES ($1,$2,$1,'bound','not_scanned','text/plain',1,$3,'/test/not-read','gateway',$2,NOW() + INTERVAL '1 hour')`,
    [attachmentId, source.sourceId, "a".repeat(64)]);
    await pool.query(`INSERT INTO runtime.gateway_event_attachments (event_id,attachment_id,position,sha256,size_bytes,mime_type)
      VALUES ($1,$2,0,$3,1,'text/plain')`, [event.id, attachmentId, "a".repeat(64)]);
    const input = {eventId: event.id, claimId, source, attachmentRetentionMs: 60_000,
      payload: {source: "gateway", message: {role: "user" as const, content: [{type: "text" as const, text}], timestamp: Date.now()}}};
    return {event: assessed, source, input, attachmentId, sessionId, threadId};
  }

  function intercepted(before: (sql: string) => Promise<void> | void, after?: (sql: string) => Promise<void> | void) {
    const wrapped: PgPoolLike = {
      query: (sql, params) => pool.query(sql, params),
      connect: async () => {
        const client = await pool.connect();
        return {release: () => client.release(), query: async (sql, params) => {
          await before(sql);
          const result = await client.query(sql, params);
          await after?.(sql);
          return result;
        }};
      },
    };
    return new PostgresGatewayStore({pool: wrapped});
  }

  async function inputCount(eventId: string) {
    const result = await pool.query("SELECT COUNT(*)::integer AS count FROM runtime.inputs WHERE source = 'gateway' AND external_message_id = $1", [eventId]);
    return (result.rows[0] as {count: number}).count;
  }

  liveIt("accepts schema-permitted TEXT event IDs using a separate stable UUID", async () => {
    const f = await fixture("wake", "historical-not-a-uuid");
    const receipt = await store.commitEventDelivery(f.input);
    expect(receipt).toMatchObject({status: "delivered", text: "", inputId: f.event.inputId, threadId: f.threadId});
    expect(f.event.inputId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await threads.getInput(f.event.inputId!)).toMatchObject({externalMessageId: f.event.id, threadId: f.threadId});
    expect(await store.getAttachment(f.attachmentId)).toMatchObject({status: "delivered"});
  });

  for (const mode of ["queue", "wake"] as const) {
    liveIt(`preserves ${mode} and admits once under concurrent duplicate commits`, async () => {
      const f = await fixture(mode);
      const results = await Promise.all([store.commitEventDelivery(f.input), new PostgresGatewayStore({pool}).commitEventDelivery(f.input)]);
      expect(results.map((r) => r?.inputId)).toEqual([f.event.inputId, f.event.inputId]);
      expect(await inputCount(f.event.id)).toBe(1);
      expect(await threads.hasPendingWake(f.threadId)).toBe(mode === "wake");
    });
  }

  for (const [name, matches] of [
    ["input admission", (sql: string) => sql.includes('INSERT INTO "runtime"."inputs"')],
    ["event receipt", (sql: string) => sql.includes("SET status = 'delivered', thread_id")],
    ["attachment receipt", (sql: string) => sql.includes("SET status = 'delivered', delivered_at")],
    ["commit", (sql: string) => sql === "COMMIT"],
  ] as const) {
    liveIt(`rolls back all handoff effects on failure at ${name}`, async () => {
      const f = await fixture();
      const failing = intercepted((sql) => { if (matches(sql)) throw new Error("injected handoff failure"); });
      await expect(failing.commitEventDelivery(f.input)).rejects.toThrow("injected handoff failure");
      expect(await inputCount(f.event.id)).toBe(0);
      expect(await store.getEvent(f.event.id)).toMatchObject({status: "processing", text: "Guarded event", inputId: f.event.inputId});
      expect(await store.getAttachment(f.attachmentId)).toMatchObject({status: "bound"});
      expect(await threads.hasPendingWake(f.threadId)).toBe(false);
      await store.commitEventDelivery(f.input);
      expect(await inputCount(f.event.id)).toBe(1);
    });
  }

  liveIt("resolves a lost commit acknowledgement across reset without waking the replacement", async () => {
    const f = await fixture();
    const lost = intercepted(() => {}, (sql) => { if (sql === "COMMIT") throw new Error("commit ack lost"); });
    await expect(lost.commitEventDelivery(f.input)).rejects.toThrow("commit ack lost");
    const replacement = `replacement-${randomUUID()}`;
    await resetSessionCurrentThread({pool, sessionStore: sessions, threadStore: threads, owner,
      previousThreadId: f.threadId, session: {sessionId: f.sessionId, currentThreadId: replacement},
      thread: {id: replacement, sessionId: f.sessionId, replacesThreadId: f.threadId}});
    expect(await store.commitEventDelivery(f.input)).toMatchObject({status: "delivered", threadId: f.threadId});
    expect(await inputCount(f.event.id)).toBe(1);
    expect(await threads.hasPendingWake(replacement)).toBe(false);
  });

  liveIt("reuses a persisted guard result after claim expiry", async () => {
    const f = await fixture();
    await pool.query("UPDATE runtime.gateway_events SET claimed_at = NOW() - INTERVAL '10 minutes' WHERE id = $1", [f.event.id]);
    const guard = {score: vi.fn(async () => ({riskScore: 1}))};
    const worker = startGatewayWorker({store, guard, pollMs: 60_000});
    try {
      await vi.waitFor(async () => { expect((await store.getEvent(f.event.id)).status).toBe("delivered"); });
      expect(guard.score).not.toHaveBeenCalled();
      expect((await store.getEvent(f.event.id)).riskScore).toBe(0.1);
    } finally { await worker.close(); }
  });

  liveIt("fences stale claim holders without changing the accepted guard or attachments", async () => {
    const f = await fixture();
    await pool.query("UPDATE runtime.gateway_events SET claim_id = $2 WHERE id = $1", [f.event.id, randomUUID()]);
    expect(await store.commitEventDelivery(f.input)).toBeNull();
    expect(await store.recordEventAssessment({eventId: f.event.id, claimId: f.input.claimId, riskScore: 0.9, metadata: {}})).toBeNull();
    expect(await inputCount(f.event.id)).toBe(0);
    expect(await store.getAttachment(f.attachmentId)).toMatchObject({status: "bound"});
  });

  for (const change of ["reset", "archive"] as const) {
    liveIt(`observes ${change} while waiting for the session lock`, async () => {
      const f = await fixture();
      const replacement = `replacement-${randomUUID()}`;
      if (change === "reset") await threads.createThread({id: replacement, sessionId: f.sessionId, replacesThreadId: f.threadId});
      const blocker = await pool.connect();
      const reachedLock = gate();
      const waiting = intercepted((sql) => { if (sql.includes("SELECT id, archived_at")) reachedLock.release(); });
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM runtime.agent_sessions WHERE id = $1 FOR UPDATE", [f.sessionId]);
      const acceptance = waiting.commitEventDelivery(f.input);
      const outcome = acceptance.then((value) => ({value}), (error: unknown) => ({error}));
      try {
        await reachedLock.promise;
        if (change === "reset") await blocker.query("UPDATE runtime.agent_sessions SET current_thread_id = $2 WHERE id = $1", [f.sessionId, replacement]);
        else await blocker.query("UPDATE runtime.agent_sessions SET archived_at = NOW() WHERE id = $1", [f.sessionId]);
        await blocker.query("COMMIT");
        const result = await outcome;
        if (change === "reset") {
          expect(result).toMatchObject({value: {status: "delivered", threadId: replacement}});
          expect(await threads.hasPendingWake(f.threadId)).toBe(false);
        } else {
          expect("error" in result && result.error).toBeInstanceOf(GatewayDeliveryTargetUnavailableError);
          expect(await inputCount(f.event.id)).toBe(0);
        }
      } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    });
  }

  liveIt("rejects revoked source authority at commit", async () => {
    const f = await fixture();
    await pool.query("UPDATE runtime.gateway_sources SET status = 'suspended' WHERE source_id = $1", [f.source.sourceId]);
    await expect(store.commitEventDelivery(f.input)).rejects.toBeInstanceOf(GatewayDeliveryTargetUnavailableError);
    expect(await inputCount(f.event.id)).toBe(0);
  });

  liveIt("never reclaims or scrubs an unresolved legacy delivering event", async () => {
    const f = await fixture();
    await pool.query("UPDATE runtime.gateway_events SET status = 'delivering', input_id = NULL, claimed_at = NOW() - INTERVAL '1 day' WHERE id = $1", [f.event.id]);
    expect((await store.claimPendingEvents(100)).map((event) => event.id)).not.toContain(f.event.id);
    expect(await store.commitEventDelivery(f.input)).toBeNull();
    expect(await store.getEvent(f.event.id)).toMatchObject({status: "delivering", text: "Guarded event", inputId: undefined});
    expect(await store.getAttachment(f.attachmentId)).toMatchObject({status: "bound"});
  });
  liveIt("rejects expired or scrubbed attachments before admitting any input", async () => {
    for (const state of ["expired", "scrubbed"]) {
      const f = await fixture();
      if (state === "expired") await pool.query("UPDATE runtime.gateway_attachments SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [f.attachmentId]);
      else await pool.query("UPDATE runtime.gateway_attachments SET status = 'scrubbed' WHERE id = $1", [f.attachmentId]);
      await expect(store.commitEventDelivery(f.input)).rejects.toThrow("attachment expired or became unavailable");
      expect(await inputCount(f.event.id)).toBe(0);
      expect(await store.getEvent(f.event.id)).toMatchObject({status: "processing", text: "Guarded event"});
      await pool.query("UPDATE runtime.gateway_attachments SET expires_at = NOW() + INTERVAL '1 day' WHERE id = $1", [f.attachmentId]);
    }
  });

  async function expiredFile() {
    const f = await fixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "panda-gateway-retention-"));
    const directory = path.join(root, "agents", "panda", "media", "gateway", f.source.sourceId);
    await mkdir(directory, {recursive: true});
    const file = path.join(directory, "expired.txt");
    await writeFile(file, "keep");
    await pool.query("UPDATE runtime.gateway_attachments SET local_path = $2, expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [f.attachmentId, file]);
    return {...f, root, file};
  }

  liveIt("rechecks retention after waiting for an attachment cleanup lock", async () => {
    const f = await expiredFile();
    const blocker = await pool.connect();
    const reachedLock = gate();
    const sweep = intercepted((sql) => { if (sql.includes("WHERE a.id = $1 FOR UPDATE")) reachedLock.release(); });
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM runtime.gateway_attachments WHERE id = $1 FOR UPDATE", [f.attachmentId]);
      const cleanup = sweep.scrubExpiredAttachments({env: {DATA_DIR: f.root}});
      await reachedLock.promise;
      await blocker.query("UPDATE runtime.gateway_attachments SET status = 'delivered', expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1", [f.attachmentId]);
      await blocker.query("COMMIT");
      expect(await cleanup).toEqual({scrubbed: 0});
      expect(await readFile(f.file, "utf8")).toBe("keep");
      expect(await store.getAttachment(f.attachmentId)).toMatchObject({status: "delivered"});
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await rm(f.root, {recursive: true, force: true}); }
  });

  liveIt("cannot admit unlinked expired media after a cleanup receipt failure", async () => {
    const f = await expiredFile();
    const sweep = intercepted((sql) => { if (sql.includes("SET status = 'scrubbed'")) throw new Error("cleanup receipt failed"); });
    try {
      await expect(sweep.scrubExpiredAttachments({env: {DATA_DIR: f.root}})).rejects.toThrow("cleanup receipt failed");
      await expect(readFile(f.file)).rejects.toMatchObject({code: "ENOENT"});
      await expect(store.commitEventDelivery(f.input)).rejects.toThrow("attachment expired or became unavailable");
      expect(await inputCount(f.event.id)).toBe(0);
      expect(await store.scrubExpiredAttachments({env: {DATA_DIR: f.root}})).toEqual({scrubbed: 1});
    } finally { await rm(f.root, {recursive: true, force: true}); }
  });

  liveIt("refuses to unlink an attachment outside its agent media root", async () => {
    const f = await expiredFile();
    const outside = path.join(f.root, "outside.txt");
    await writeFile(outside, "keep outside");
    await pool.query("UPDATE runtime.gateway_attachments SET local_path = $2 WHERE id = $1", [f.attachmentId, outside]);
    try {
      await expect(store.scrubExpiredAttachments({env: {DATA_DIR: f.root}})).rejects.toThrow("outside media root");
      expect(await readFile(outside, "utf8")).toBe("keep outside");
      expect(await store.getAttachment(f.attachmentId)).toMatchObject({status: "bound", localPath: outside});
    } finally { await rm(f.root, {recursive: true, force: true}); }
  });

});
