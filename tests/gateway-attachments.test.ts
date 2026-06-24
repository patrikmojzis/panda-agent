import {createHash, randomUUID} from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {
  GatewayAttachmentConflictError,
  GatewayAttachmentReferenceError,
  GatewayEventConflictError,
  PostgresGatewayStore,
} from "../src/domain/gateway/postgres.js";
import {buildGatewayTableNames} from "../src/domain/gateway/postgres-shared.js";
import type {GatewayAttachmentRecord} from "../src/domain/gateway/types.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";
import {ensureSchemas} from "../src/app/runtime/postgres-bootstrap.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("gateway attachments store", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (pool) {
        await pool.end();
      }
    }
  });

  async function createHarness() {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const agentStore = new PostgresAgentStore({pool});
    const gatewayStore = new PostgresGatewayStore({pool});
    const identityStore = new PostgresIdentityStore({pool});
    const sessionStore = new PostgresSessionStore({pool});
    const threadStore = new PostgresThreadRuntimeStore({pool});
    await ensureSchemas([identityStore, agentStore, sessionStore, threadStore, gatewayStore]);
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
    });
    const identity = await identityStore.createIdentity({
      id: "identity-1",
      handle: "patrik",
      displayName: "Patrik",
    });
    await agentStore.ensurePairing("panda", identity.id);
    await gatewayStore.createSource({
      sourceId: "work-prod",
      agentKey: "panda",
      identityId: identity.id,
    });
    await gatewayStore.createSource({
      sourceId: "other-prod",
      agentKey: "panda",
      identityId: identity.id,
    });
    return {gatewayStore, pool};
  }

  async function uploadAttachment(input: {
    expiresAt?: number;
    filename?: string;
    idempotencyKey: string;
    mimeType?: string;
    sourceId?: string;
    text?: string;
  }, gatewayStore: PostgresGatewayStore): Promise<GatewayAttachmentRecord> {
    const text = input.text ?? "attachment body";
    const id = randomUUID();
    const result = await gatewayStore.storeAttachmentUpload({
      sourceId: input.sourceId ?? "work-prod",
      idempotencyKey: input.idempotencyKey,
      descriptor: {
        id,
        source: "gateway",
        connectorKey: input.sourceId ?? "work-prod",
        mimeType: input.mimeType ?? "text/plain",
        sizeBytes: Buffer.byteLength(text, "utf8"),
        localPath: `/tmp/${id}.txt`,
        originalFilename: input.filename ?? "note.txt",
        metadata: {schemaVersion: 1},
        createdAt: Date.now(),
      },
      sha256: sha256Hex(text),
      mimeType: input.mimeType ?? "text/plain",
      filename: input.filename ?? "note.txt",
      expiresAt: input.expiresAt ?? Date.now() + 60_000,
    });
    return result.attachment;
  }

  it("creates attachment tables and keeps upload idempotency stable", async () => {
    const {gatewayStore, pool} = await createHarness();
    const tables = buildGatewayTableNames();
    const tableCheck = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${tables.attachments}`);
    expect(Number((tableCheck.rows[0] as {count: unknown}).count)).toBe(0);

    const first = await uploadAttachment({idempotencyKey: "same-upload", text: "same"}, gatewayStore);
    const replay = await gatewayStore.storeAttachmentUpload({
      sourceId: "work-prod",
      idempotencyKey: "same-upload",
      descriptor: {
        id: randomUUID(),
        source: "gateway",
        connectorKey: "work-prod",
        mimeType: "text/plain",
        sizeBytes: Buffer.byteLength("same", "utf8"),
        localPath: "/tmp/replay.txt",
        originalFilename: "note.txt",
        metadata: {schemaVersion: 1},
        createdAt: Date.now(),
      },
      sha256: sha256Hex("same"),
      mimeType: "text/plain",
      filename: "note.txt",
      expiresAt: Date.now() + 60_000,
    });
    expect(replay.inserted).toBe(false);
    expect(replay.attachment.id).toBe(first.id);
    await expect(uploadAttachment({idempotencyKey: "same-upload", text: "changed"}, gatewayStore))
      .rejects.toBeInstanceOf(GatewayAttachmentConflictError);

    const pending = await gatewayStore.countPendingAttachmentsForSource("work-prod");
    expect(pending).toBe(1);
    const attachmentRows = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${tables.attachments}`);
    expect(Number((attachmentRows.rows[0] as {count: unknown}).count)).toBe(1);
  });

  it("binds attachments atomically and includes ordered refs in event idempotency", async () => {
    const {gatewayStore} = await createHarness();
    const first = await uploadAttachment({idempotencyKey: "upload-1", text: "one"}, gatewayStore);
    const second = await uploadAttachment({idempotencyKey: "upload-2", text: "two"}, gatewayStore);

    const stored = await gatewayStore.storeEventWithAttachments({
      sourceId: "work-prod",
      type: "meeting.transcript",
      deliveryRequested: "wake",
      deliveryEffective: "wake",
      idempotencyKey: "event-1",
      text: "event text",
      textBytes: Buffer.byteLength("event text", "utf8"),
      textSha256: sha256Hex("event text"),
      attachments: [{id: first.id}, {id: second.id, sha256: second.sha256}],
      maxAttachmentBytes: 100,
    });
    expect(stored.inserted).toBe(true);
    await expect(gatewayStore.listEventAttachments(stored.event.id)).resolves.toMatchObject([
      {id: first.id, position: 0, status: "bound"},
      {id: second.id, position: 1, status: "bound"},
    ]);

    const replay = await gatewayStore.storeEventWithAttachments({
      sourceId: "work-prod",
      type: "meeting.transcript",
      deliveryRequested: "wake",
      deliveryEffective: "wake",
      idempotencyKey: "event-1",
      text: "event text",
      textBytes: Buffer.byteLength("event text", "utf8"),
      textSha256: sha256Hex("event text"),
      attachments: [{id: first.id}, {id: second.id, sha256: second.sha256}],
      maxAttachmentBytes: 100,
    });
    expect(replay.inserted).toBe(false);
    await expect(gatewayStore.storeEventWithAttachments({
      sourceId: "work-prod",
      type: "meeting.transcript",
      deliveryRequested: "wake",
      deliveryEffective: "wake",
      idempotencyKey: "event-1",
      text: "event text",
      textBytes: Buffer.byteLength("event text", "utf8"),
      textSha256: sha256Hex("event text"),
      attachments: [{id: second.id}, {id: first.id}],
      maxAttachmentBytes: 100,
    })).rejects.toBeInstanceOf(GatewayEventConflictError);
  });

  it("rejects invalid refs before binding", async () => {
    const {gatewayStore} = await createHarness();
    const first = await uploadAttachment({idempotencyKey: "upload-1", text: "one"}, gatewayStore);
    const wrongSource = await uploadAttachment({
      idempotencyKey: "upload-other",
      sourceId: "other-prod",
      text: "other",
    }, gatewayStore);
    const expired = await uploadAttachment({
      expiresAt: Date.now() - 1000,
      idempotencyKey: "upload-expired",
      text: "expired",
    }, gatewayStore);

    const base = {
      sourceId: "work-prod",
      type: "meeting.transcript",
      deliveryRequested: "wake" as const,
      deliveryEffective: "wake" as const,
      text: "event text",
      textBytes: Buffer.byteLength("event text", "utf8"),
      textSha256: sha256Hex("event text"),
      maxAttachmentBytes: 100,
    };

    await expect(gatewayStore.storeEventWithAttachments({
      ...base,
      idempotencyKey: "dup-ref",
      attachments: [{id: first.id}, {id: first.id}],
    })).rejects.toBeInstanceOf(GatewayAttachmentReferenceError);
    await expect(gatewayStore.storeEventWithAttachments({
      ...base,
      idempotencyKey: "wrong-source",
      attachments: [{id: wrongSource.id}],
    })).rejects.toThrow("source");
    await expect(gatewayStore.storeEventWithAttachments({
      ...base,
      idempotencyKey: "expired-ref",
      attachments: [{id: expired.id}],
    })).rejects.toThrow("expired");
    await expect(gatewayStore.storeEventWithAttachments({
      ...base,
      idempotencyKey: "digest-mismatch",
      attachments: [{id: first.id, sha256: "b".repeat(64)}],
    })).rejects.toThrow("sha256");
    await expect(gatewayStore.storeEventWithAttachments({
      ...base,
      idempotencyKey: "too-large",
      attachments: [{id: first.id}],
      maxAttachmentBytes: 1,
    })).rejects.toMatchObject({statusCode: 413});
  });

  it("refuses to scrub expired attachment paths outside the agent media root", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-gateway-scrub-"));
    const maliciousPath = path.join(dataDir, "outside.txt");
    try {
      await fs.mkdir(path.join(dataDir, "agents", "panda", "media"), {recursive: true});
      await fs.writeFile(maliciousPath, "do not delete", "utf8");
      const {gatewayStore, pool} = await createHarness();
      const attachment = await uploadAttachment({
        expiresAt: Date.now() - 1_000,
        idempotencyKey: "malicious-path",
        text: "malicious",
      }, gatewayStore);
      const tables = buildGatewayTableNames();
      await pool.query(`
        UPDATE ${tables.attachments}
        SET local_path = $2
        WHERE id = $1
      `, [attachment.id, maliciousPath]);

      await expect(gatewayStore.scrubExpiredAttachments({
        env: {DATA_DIR: dataDir},
        now: Date.now(),
      })).rejects.toThrow("outside media root");
      await expect(fs.readFile(maliciousPath, "utf8")).resolves.toBe("do not delete");
      await expect(gatewayStore.getAttachment(attachment.id)).resolves.toMatchObject({
        status: "uploaded",
        localPath: maliciousPath,
      });
    } finally {
      await fs.rm(dataDir, {recursive: true, force: true});
    }
  });

  it("updates delivered and quarantined attachment retention status", async () => {
    const {gatewayStore} = await createHarness();
    const deliveredAttachment = await uploadAttachment({idempotencyKey: "upload-delivered"}, gatewayStore);
    const stored = await gatewayStore.storeEventWithAttachments({
      sourceId: "work-prod",
      type: "meeting.transcript",
      deliveryRequested: "wake",
      deliveryEffective: "wake",
      idempotencyKey: "event-delivered",
      text: "event text",
      textBytes: Buffer.byteLength("event text", "utf8"),
      textSha256: sha256Hex("event text"),
      attachments: [{id: deliveredAttachment.id}],
      maxAttachmentBytes: 100,
    });
    const [claimed] = await gatewayStore.claimPendingEvents(1);
    if (!claimed?.claimId) {
      throw new Error("Expected claimed event.");
    }
    await gatewayStore.reserveEventDelivery({eventId: stored.event.id, claimId: claimed.claimId, riskScore: 0.01});
    await gatewayStore.markEventDelivered({
      eventId: stored.event.id,
      claimId: claimed.claimId,
      threadId: "thread-1",
      riskScore: 0.01,
      metadata: {gateway: {}},
      attachmentRetentionMs: 1_000,
    });
    await expect(gatewayStore.getAttachment(deliveredAttachment.id)).resolves.toMatchObject({status: "delivered"});

    const quarantinedAttachment = await uploadAttachment({idempotencyKey: "upload-quarantined"}, gatewayStore);
    const quarantined = await gatewayStore.storeEventWithAttachments({
      sourceId: "work-prod",
      type: "meeting.transcript",
      deliveryRequested: "wake",
      deliveryEffective: "wake",
      idempotencyKey: "event-quarantined",
      text: "event text",
      textBytes: Buffer.byteLength("event text", "utf8"),
      textSha256: sha256Hex("event text"),
      attachments: [{id: quarantinedAttachment.id}],
      maxAttachmentBytes: 100,
    });
    await gatewayStore.markEventQuarantined({
      eventId: quarantined.event.id,
      riskScore: 1,
      reason: "test quarantine",
      metadata: {gateway: {}},
      attachmentQuarantineTtlMs: 1_000,
    });
    await expect(gatewayStore.getAttachment(quarantinedAttachment.id)).resolves.toMatchObject({status: "quarantined"});
  });
});
