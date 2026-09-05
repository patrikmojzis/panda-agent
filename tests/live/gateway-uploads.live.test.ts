import {spawn} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import * as fs from "node:fs/promises";
import type {IncomingMessage} from "node:http";
import os from "node:os";
import path from "node:path";
import {Readable} from "node:stream";
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresGatewayStore} from "../../src/domain/gateway/postgres.js";
import {PostgresIdentityStore} from "../../src/domain/identity/postgres.js";
import {startGatewayServer} from "../../src/integrations/gateway/http.js";
import {acceptGatewayAttachmentUploadRequest} from "../../src/integrations/gateway/attachment-acceptance.js";
import {cleanGatewayUploadDirectory, createGatewayUploadDirectory, createGatewayUploadJanitor} from "../../src/integrations/gateway/attachment-storage.js";
import type {PgPoolLike} from "../../src/lib/postgres-query.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {...actual, open: vi.fn(actual.open)};
});

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

describe.sequential("bounded Gateway uploads with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let store: PostgresGatewayStore;
  let dataDir: string;
  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({connectionString: target.connectionString, applicationName: "panda/gateway-upload-live", max: 5});
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    await new PostgresAgentStore({pool}).bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await new PostgresIdentityStore({pool}).createIdentity({id: "upload-actor", handle: "upload-test", displayName: "Upload test"});
    store = new PostgresGatewayStore({pool});
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-gateway-upload-"));
  });
  afterEach(async () => {
    if (pool) await pool.query("DELETE FROM runtime.gateway_upload_reservations");
    vi.restoreAllMocks();
    vi.mocked(fs.open).mockReset();
  });
  afterAll(async () => { await pool?.end(); if (dataDir) await fs.rm(dataDir, {recursive: true, force: true}); });

  async function fixture() {
    const sourceId = `upload-${randomUUID()}`;
    await store.createSource({sourceId, agentKey: "panda", identityId: "upload-actor"});
    const access = await store.createAccessToken({sourceId, expiresInMs: 60_000});
    const options = {allowedMimeTypes: ["text/plain", "application/json"], attachmentBytesPerHour: 1000,
      attachmentUploadTtlMs: 60_000, attachmentRequestTimeoutMs: 1000, maxConcurrentAttachmentUploads: 8,
      env: {DATA_DIR: dataDir}, maxBytes: 16, maxPendingAttachmentsPerSource: 100, store};
    const request = (body = "hello", key = randomUUID(), extra: IncomingMessage["headers"] = {}) => Object.assign(Readable.from([body]), {
      headers: {authorization: `Bearer ${access.token}`, "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)),
        "idempotency-key": key, ...extra},
    }) as IncomingMessage;
    const reservation = (key = randomUUID(), overrides = {}) => ({id: randomUUID(), sourceId, idempotencyKey: key,
      directory: path.join(dataDir, randomUUID()), reservedBytes: 5, maxConcurrent: 8, maxPending: 100,
      byteLimit: 1000, expiresAt: Date.now() + 60_000, ...overrides});
    return {sourceId, options, request, reservation};
  }

  async function used(sourceId: string) {
    const row = await pool.query("SELECT used FROM runtime.gateway_rate_limits WHERE bucket_key = $1", [`gateway:source:${sourceId}:attachment_bytes`]);
    return Number((row.rows[0] as {used: string} | undefined)?.used ?? 0);
  }

  liveIt("serializes the global cap across competing admissions without holding body connections", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({length: 12}, () => store.reserveAttachmentUpload(f.reservation())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(4);
    expect(await used(f.sourceId)).toBe(40);
    // All five connections remain available while eight durable receiving slots exist.
    const clients = await Promise.all(Array.from({length: 5}, () => pool.connect()));
    clients.forEach((client) => client.release());
  });

  liveIt("counts active new uploads atomically against pending capacity", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([store.reserveAttachmentUpload(f.reservation(undefined, {maxPending: 1})),
      store.reserveAttachmentUpload(f.reservation(undefined, {maxPending: 1}))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await used(f.sourceId)).toBe(5);
  });

  liveIt("keeps identical retries valid at full pending capacity and byte quota while checking their body", async () => {
    const f = await fixture();
    const options = {...f.options, maxPendingAttachmentsPerSource: 1, attachmentBytesPerHour: 5};
    const accepted = await acceptGatewayAttachmentUploadRequest({...options, request: f.request("hello", "same")});
    expect(accepted.status).toBe(201);
    expect(accepted.body.filename).toBe(`${accepted.body.attachmentId}.txt`);
    const retry = await acceptGatewayAttachmentUploadRequest({...options, request: f.request("hello", "same")});
    expect(retry).toEqual({...accepted, status: 200});
    await expect(acceptGatewayAttachmentUploadRequest({...options, request: f.request("world", "same")}))
      .rejects.toThrow("different attachment upload");
    expect(await used(f.sourceId)).toBe(5);
    expect(await fs.readFile((await store.getAttachment(accepted.body.attachmentId)).localPath, "utf8")).toBe("hello");
  });

  liveIt("charges rejected new bodies conservatively and rejects exhausted admission before body reads", async () => {
    const f = await fixture();
    const options = {...f.options, attachmentBytesPerHour: 5};
    await expect(acceptGatewayAttachmentUploadRequest({...options, request: f.request("hello", "invalid", {"x-content-sha256": "0".repeat(64)})}))
      .rejects.toMatchObject({statusCode: 400});
    expect(await used(f.sourceId)).toBe(5);
    let reads = 0;
    const request = f.request();
    request._read = () => { reads += 1; };
    await expect(acceptGatewayAttachmentUploadRequest({...options, request})).rejects.toThrow("byte budget");
    expect(reads).toBe(0);
  });

  liveIt("refunds unused chunked capacity only after successful verification", async () => {
    const f = await fixture();
    const request = f.request();
    delete request.headers["content-length"];
    await acceptGatewayAttachmentUploadRequest({...f.options, request});
    expect(await used(f.sourceId)).toBe(5);
  });

  liveIt("does not refund an old reservation into a replacement hourly bucket", async () => {
    const f = await fixture();
    const directory = await createGatewayUploadDirectory({sourceId: f.sourceId, agentKey: "panda", connectorKey: f.sourceId,
      expiresAt: Date.now() + 1000, env: f.options.env});
    await store.reserveAttachmentUpload(f.reservation("old-window", {...directory, reservedBytes: 16}));
    await pool.query("UPDATE runtime.gateway_rate_limits SET window_start = NOW() + INTERVAL '1 second', used = 100 WHERE bucket_key = $1", [`gateway:source:${f.sourceId}:attachment_bytes`]);
    await fs.writeFile(directory.localPath, "hello");
    await store.completeAttachmentUpload(directory.id, {sourceId: f.sourceId, idempotencyKey: "old-window", mimeType: "text/plain", sha256: digest("hello"),
      expiresAt: Date.now() + 60_000, descriptor: {id: directory.id, localPath: directory.localPath, source: "gateway", connectorKey: f.sourceId,
        mimeType: "text/plain", sizeBytes: 5, createdAt: Date.now()}});
    expect(await used(f.sourceId)).toBe(100);
  });

  liveIt("aborts stalled streams at their deadline and keeps the reserved charge", async () => {
    const f = await fixture();
    const request = f.request();
    request._read = () => {};
    await expect(acceptGatewayAttachmentUploadRequest({...f.options, attachmentRequestTimeoutMs: 25, request}))
      .rejects.toMatchObject({statusCode: 408});
    expect(await used(f.sourceId)).toBe(5);
    expect(request.destroyed).toBe(true);
    const rows = await pool.query("SELECT id FROM runtime.gateway_upload_reservations WHERE source_id = $1", [f.sourceId]);
    expect(rows.rows).toHaveLength(0);
  });

  liveIt("retains committed bytes after a lost transaction acknowledgement", async () => {
    const f = await fixture();
    let committedAttachment = false;
    let failOnce = true;
    const wrapped: PgPoolLike = {query: (sql, params) => pool.query(sql, params), connect: async () => {
      const client = await pool.connect();
      return {release: () => client.release(), query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (sql.includes('INSERT INTO "runtime"."gateway_attachments"')) committedAttachment = true;
        if (sql === "COMMIT" && committedAttachment && failOnce) { failOnce = false; throw new Error("lost metadata acknowledgement"); }
        return result;
      }};
    }};
    const accepted = await acceptGatewayAttachmentUploadRequest({...f.options, store: new PostgresGatewayStore({pool: wrapped}), request: f.request()});
    expect(accepted.status).toBe(201);
    expect(await fs.readFile((await store.getAttachment(accepted.body.attachmentId)).localPath, "utf8")).toBe("hello");
    expect(await used(f.sourceId)).toBe(5);
  });

  liveIt("leaves uncertain receipts for startup reconciliation without deleting delivered media", async () => {
    const f = await fixture();
    const uncertain = new PostgresGatewayStore({pool});
    const original = uncertain.completeAttachmentUpload.bind(uncertain);
    vi.spyOn(uncertain, "completeAttachmentUpload").mockImplementation(async (...args) => { await original(...args); throw new Error("receipt lost"); });
    vi.spyOn(uncertain, "getAttachmentByIdempotencyKey").mockRejectedValue(new Error("database unavailable"));
    vi.spyOn(uncertain, "discardAttachmentUpload").mockRejectedValue(new Error("database unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(acceptGatewayAttachmentUploadRequest({...f.options, attachmentRequestTimeoutMs: 500,
      store: uncertain, request: f.request("hello", "uncertain")})).rejects.toThrow("receipt lost");
    const attachment = await store.getAttachmentByIdempotencyKey(f.sourceId, "uncertain");
    expect(attachment).toBeTruthy();
    await pool.query("UPDATE runtime.gateway_attachments SET status = 'delivered', expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [attachment!.id]);
    const marker = path.join(path.dirname(attachment!.localPath), "upload.json");
    const manifest = JSON.parse(await fs.readFile(marker, "utf8"));
    await fs.writeFile(marker, JSON.stringify({...manifest, expiresAt: 0}));
    const janitor = createGatewayUploadJanitor({store, env: f.options.env});
    janitor.start();
    try { await vi.waitFor(async () => { await expect(fs.stat(marker)).rejects.toMatchObject({code: "ENOENT"}); }); }
    finally { await janitor.stop(); }
    expect(await fs.readFile(attachment!.localPath, "utf8")).toBe("hello");
  });

  liveIt("reconciles explicit pre-admission orphans and expired receiving files, skipping legacy files", async () => {
    const f = await fixture();
    const orphan = await createGatewayUploadDirectory({sourceId: f.sourceId, agentKey: "panda", connectorKey: f.sourceId,
      expiresAt: 0, env: f.options.env});
    const expired = await createGatewayUploadDirectory({sourceId: f.sourceId, agentKey: "panda", connectorKey: `${f.sourceId}__phone`,
      expiresAt: 0, env: f.options.env});
    await store.reserveAttachmentUpload(f.reservation("expired", {...expired, expiresAt: Date.now() + 1000}));
    await pool.query("UPDATE runtime.gateway_upload_reservations SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [expired.id]);
    await fs.writeFile(expired.localPath, "partial");
    const legacy = path.join(path.dirname(path.dirname(orphan.directory)), "legacy.txt");
    await fs.writeFile(legacy, "keep legacy");
    const janitor = createGatewayUploadJanitor({store, env: f.options.env});
    janitor.start();
    try { await vi.waitFor(async () => {
      await expect(fs.stat(orphan.directory)).rejects.toMatchObject({code: "ENOENT"});
      await expect(fs.stat(expired.directory)).rejects.toMatchObject({code: "ENOENT"});
    }); } finally { await janitor.stop(); }
    expect(await fs.readFile(legacy, "utf8")).toBe("keep legacy");
  });

  liveIt("rejects metadata acceptance after expiry cleanup wins the reservation lock", async () => {
    const f = await fixture();
    const directory = await createGatewayUploadDirectory({sourceId: f.sourceId, agentKey: "panda", connectorKey: f.sourceId,
      expiresAt: 0, env: f.options.env});
    await store.reserveAttachmentUpload(f.reservation("revoked", {...directory, expiresAt: Date.now() + 1000}));
    await fs.writeFile(directory.localPath, "hello");
    await cleanGatewayUploadDirectory({upload: directory, store});
    await expect(store.completeAttachmentUpload(directory.id, {sourceId: f.sourceId, idempotencyKey: "revoked", mimeType: "text/plain", sha256: digest("hello"),
      expiresAt: Date.now() + 1000, descriptor: {id: directory.id, localPath: directory.localPath, source: "gateway", connectorKey: f.sourceId,
        mimeType: "text/plain", sizeBytes: 5, createdAt: Date.now()}})).rejects.toThrow("reservation is unavailable");
    expect(await store.getAttachmentByIdempotencyKey(f.sourceId, "revoked")).toBeNull();
  });
  liveIt("checks current database time after waiting for the admission lock", async () => {
    const f = await fixture();
    const reservation = f.reservation("waited", {expiresAt: Date.now() + 200});
    const reserved = await store.reserveAttachmentUpload(reservation);
    expect(Math.abs(reserved.expiresAt - reservation.expiresAt)).toBeLessThan(1);
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT * FROM runtime.gateway_rate_limits WHERE bucket_key = 'gateway:attachment:admission' FOR UPDATE");
    const completing = store.completeAttachmentUpload(reservation.id, {sourceId: f.sourceId, idempotencyKey: "waited", mimeType: "text/plain",
      sha256: digest("hello"), expiresAt: Date.now() + 1000, descriptor: {id: reservation.id, localPath: path.join(reservation.directory, "payload"),
        source: "gateway", connectorKey: f.sourceId, mimeType: "text/plain", sizeBytes: 5, createdAt: Date.now()}});
    const assertion = expect(completing).rejects.toThrow("expired or was revoked");
    try { await pool.query("SELECT pg_sleep(0.25)"); }
    finally { await blocker.query("COMMIT"); blocker.release(); }
    await assertion;
    expect(await store.getAttachmentByIdempotencyKey(f.sourceId, "waited")).toBeNull();
  });

  liveIt("does not admit a delayed writer after an orphan absence proof", async () => {
    const f = await fixture();
    const directory = await createGatewayUploadDirectory({sourceId: f.sourceId, agentKey: "panda", connectorKey: f.sourceId,
      expiresAt: 0, env: f.options.env});
    expect(await store.discardAttachmentUpload({...directory, expiredOnly: true})).toBe("discard");
    // This is the exact proof-to-filesystem-cleanup gap. The original deadline cannot be renewed.
    await expect(store.reserveAttachmentUpload(f.reservation("late", directory))).rejects.toThrow("deadline exceeded");
    await cleanGatewayUploadDirectory({upload: directory, store, expiredOnly: true});
    await expect(fs.stat(directory.directory)).rejects.toMatchObject({code: "ENOENT"});
  });

  liveIt("keeps a local upload slot while an expired request still has a file write in flight", async () => {
    const f = await fixture();
    let release!: () => void;
    let writing!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { writing = resolve; });
    const originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    let blockOnce = true;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith("/payload") && blockOnce) {
        blockOnce = false;
        const originalWrite = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs) => { writing(); await blocked; return originalWrite(...writeArgs); };
      }
      return handle;
    });
    const server = await startGatewayServer({...f.options, maxConcurrentAttachmentUploads: 1, attachmentRequestTimeoutMs: 60_000,
      host: "127.0.0.1", port: 0, deviceCommandWaiter: {claimOrWait: async () => ({claimed: false})}});
    const url = `http://127.0.0.1:${server.port}/v2/attachments`;
    const headers = f.request().headers as Record<string, string>;
    const firstController = new AbortController();
    let first: Promise<unknown> | undefined;
    try {
      first = fetch(url, {method: "POST", headers, body: "hello", signal: firstController.signal}).catch(() => null);
      await entered;
      // The fixture controls expiry after the write has started; healthy uploads need no 100ms latency target.
      await pool.query("UPDATE runtime.gateway_upload_reservations SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE source_id = $1", [f.sourceId]);
      firstController.abort();
      await first;
      const denied = await fetch(url, {method: "POST", headers: {...headers, "idempotency-key": "second"}, body: "hello"});
      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({error: "Concurrent attachment validation limit exceeded."});
      release();
      await vi.waitFor(async () => {
        const rows = await pool.query("SELECT id FROM runtime.gateway_upload_reservations WHERE source_id = $1", [f.sourceId]);
        expect(rows.rows).toHaveLength(0);
      });
      expect(await store.getAttachmentByIdempotencyKey(f.sourceId, String(headers["idempotency-key"]))).toBeNull();
      const accepted = await fetch(url, {method: "POST", headers: {...headers, "idempotency-key": "third"}, body: "hello"});
      expect(accepted.status).toBe(201);
      expect(await used(f.sourceId)).toBe(10);
    } finally { firstController.abort(); release(); await first; await server.close(); }
  });

  liveIt("streams eight 10 MiB HTTP uploads with separately generated client bodies", async () => {
    const f = await fixture();
    const server = await startGatewayServer({...f.options, attachmentBytesPerHour: 100 * 1024 * 1024,
      maxAttachmentBytes: 10 * 1024 * 1024, attachmentRequestTimeoutMs: 60_000,
      host: "127.0.0.1", port: 0, deviceCommandWaiter: {claimOrWait: async () => ({claimed: false})}});
    const baseline = process.memoryUsage();
    const peak = {...baseline};
    const sample = () => { const usage = process.memoryUsage(); for (const key of ["rss", "heapUsed", "external", "arrayBuffers"] as const) peak[key] = Math.max(peak[key], usage[key]); };
    const timer = setInterval(sample, 5);
    try {
      const script = `
        const http = require('node:http');
        const {once} = require('node:events');
        const chunk = Buffer.alloc(64 * 1024, 97);
        Promise.all(Array.from({length: 8}, (_, i) => new Promise(async (resolve, reject) => {
          const request = http.request(process.env.UPLOAD_URL, {method:'POST', headers:{
            authorization:process.env.UPLOAD_AUTH, 'content-type':'text/plain',
            'content-length':String(10*1024*1024), 'idempotency-key':'memory-'+i
          }}, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
          request.on('error', reject);
          try { for(let i=0;i<160;i++) if(!request.write(chunk)) await once(request,'drain'); request.end(); }
          catch(error) { reject(error); }
        }))).then(statuses => process.stdout.write(JSON.stringify(statuses))).catch(error => {console.error(error.message);process.exitCode=1;});
      `;
      const child = spawn(process.execPath, ["-e", script], {env: {...process.env,
        UPLOAD_URL: `http://127.0.0.1:${server.port}/v2/attachments`, UPLOAD_AUTH: String(f.request().headers.authorization)}, stdio: ["ignore", "pipe", "pipe"]});
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const status = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
      expect(status, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual(Array(8).fill(201));
      sample();
      console.log("Gateway server upload memory probe", JSON.stringify({concurrentUploads: 8, bytesPerUpload: 10 * 1024 * 1024,
        bodyClient: "separate process, reused 64 KiB chunk", baseline, peak,
        delta: {rss: peak.rss - baseline.rss, heapUsed: peak.heapUsed - baseline.heapUsed,
          external: peak.external - baseline.external, arrayBuffers: peak.arrayBuffers - baseline.arrayBuffers}}));
    } finally { clearInterval(timer); await server.close(); }
  });

  liveIt("starts its timeout and local slot before a blocked HTTP rate-limit query", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    let admissionFinished = false;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const original = store.useRateLimit.bind(store);
    const rateLimit = vi.spyOn(store, "useRateLimit").mockImplementation(async (input) => {
      if (input.key.startsWith("gateway:ip:")) { entered(); await blocked; }
      const result = await original(input);
      admissionFinished = true;
      return result;
    });
    const server = await startGatewayServer({...f.options, maxConcurrentAttachmentUploads: 1, attachmentRequestTimeoutMs: 100,
      host: "127.0.0.1", port: 0, deviceCommandWaiter: {claimOrWait: async () => ({claimed: false})}});
    const url = `http://127.0.0.1:${server.port}/v2/attachments`;
    const headers = f.request().headers as Record<string, string>;
    let closed = false;
    const first = fetch(url, {method: "POST", headers, body: "hello"}).catch(() => { closed = true; });
    try {
      await waiting;
      const rejected = await fetch(url, {method: "POST", headers, body: "hello"});
      expect(rejected.status).toBe(429);
      expect(rateLimit).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(closed).toBe(true));
      release();
      await first;
      await vi.waitFor(() => expect(admissionFinished).toBe(true));
      expect(await used(f.sourceId)).toBe(0);
    } finally { release(); await first; await server.close(); }
  });

  liveIt("waits for an in-flight metadata commit before proving file cleanup", async () => {
    const f = await fixture();
    const directory = await createGatewayUploadDirectory({sourceId: f.sourceId, agentKey: "panda", connectorKey: f.sourceId,
      expiresAt: Date.now() + 60_000, env: f.options.env});
    await store.reserveAttachmentUpload(f.reservation("commit-race", directory));
    await fs.writeFile(directory.localPath, "hello");
    let release!: () => void;
    let inserted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { inserted = resolve; });
    const wrapped: PgPoolLike = {query: (sql, params) => pool.query(sql, params), connect: async () => {
      const client = await pool.connect();
      return {release: () => client.release(), query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (sql.includes('INSERT INTO "runtime"."gateway_attachments"')) { inserted(); await blocked; }
        return result;
      }};
    }};
    const committing = new PostgresGatewayStore({pool: wrapped}).completeAttachmentUpload(directory.id,
      {sourceId: f.sourceId, idempotencyKey: "commit-race", mimeType: "text/plain", sha256: digest("hello"), expiresAt: Date.now() + 60_000,
        descriptor: {id: directory.id, localPath: directory.localPath, source: "gateway", connectorKey: f.sourceId,
          mimeType: "text/plain", sizeBytes: 5, createdAt: Date.now()}});
    await writing;
    const cleaning = cleanGatewayUploadDirectory({upload: directory, store});
    try {
      await vi.waitFor(async () => {
        const result = await pool.query("SELECT COUNT(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
        expect(Number((result.rows[0] as {count: string}).count)).toBeGreaterThan(0);
      });
    } finally { release(); }
    await committing;
    await cleaning;
    expect(await fs.readFile(directory.localPath, "utf8")).toBe("hello");
    expect(await store.getAttachment(directory.id)).toMatchObject({status: "uploaded"});
  });

});
