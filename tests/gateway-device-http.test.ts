import {createHash} from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresGatewayStore} from "../src/domain/gateway/postgres.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";
import {startGatewayServer} from "../src/integrations/gateway/http.js";
import {ensureSchemas} from "../src/app/runtime/postgres-bootstrap.js";
import {hashOpaqueToken} from "../src/lib/opaque-tokens.js";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("gateway device command HTTP endpoints", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (pool) {
        await pool.end();
      }
    }
  });

  async function createHarness(env?: NodeJS.ProcessEnv) {
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
    const source = await gatewayStore.createSource({sourceId: "work-prod", agentKey: "panda", identityId: identity.id});
    await gatewayStore.upsertEventType({sourceId: "work-prod", type: "meeting.transcript", delivery: "wake"});
    const server = await startGatewayServer({
      env,
      host: "127.0.0.1",
      port: 0,
      deviceCommandMaxWaitMs: 500,
      store: gatewayStore,
    });
    return {
      baseUrl: `http://127.0.0.1:${String(server.port)}`,
      clientId: source.source.clientId,
      clientSecret: source.clientSecret,
      gatewayStore,
      pool,
      server,
    };
  }

  async function closeHarness(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
    await harness.server.close();
  }

  async function getSourceToken(harness: Awaited<ReturnType<typeof createHarness>>): Promise<string> {
    const response = await fetch(`${harness.baseUrl}/oauth/token`, {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: harness.clientId,
        client_secret: harness.clientSecret,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {access_token?: string};
    if (!body.access_token) {
      throw new Error("Missing source access token.");
    }
    return body.access_token;
  }

  async function postJson(url: string, token: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: {authorization: `Bearer ${token}`, "content-type": "application/json"},
      body: JSON.stringify(body),
    });
  }

  it("requires device tokens and records device heartbeat", async () => {
    const harness = await createHarness();
    try {
      const sourceToken = await getSourceToken(harness);
      const sourceHeartbeat = await postJson(`${harness.baseUrl}/v1/device/heartbeat`, sourceToken, {});
      expect(sourceHeartbeat.status).toBe(401);

      const deviceToken = "pgd_device_heartbeat";
      await harness.gatewayStore.registerDevice({
        sourceId: "work-prod",
        deviceId: "device-heartbeat",
        tokenHash: hashOpaqueToken(deviceToken),
        capabilities: [],
      });
      const heartbeat = await postJson(`${harness.baseUrl}/v1/device/heartbeat`, deviceToken, {});
      expect(heartbeat.status).toBe(200);
      await expect(heartbeat.json()).resolves.toMatchObject({
        ok: true,
        sourceId: "work-prod",
        deviceId: "device-heartbeat",
      });
      const devices = await harness.gatewayStore.listDevices({sourceId: "work-prod"});
      expect(devices.find((device) => device.deviceId === "device-heartbeat")?.lastSeenAt).toBeTypeOf("number");

      const v1Event = await postJson(`${harness.baseUrl}/v1/events`, deviceToken, {
        type: "meeting.transcript",
        delivery: "wake",
        occurredAt: "2026-04-28T10:00:00Z",
        text: "device tokens stay rejected on v1 events",
      });
      expect(v1Event.status).toBe(401);
    } finally {
      await closeHarness(harness);
    }
  });

  it("claims commands with capability checks and bounded long-polling", async () => {
    const harness = await createHarness();
    try {
      const noCommandsToken = "pgd_no_commands_http";
      await harness.gatewayStore.registerDevice({
        sourceId: "work-prod",
        deviceId: "no-commands",
        tokenHash: hashOpaqueToken(noCommandsToken),
        capabilities: ["screenshot.capture"],
      });
      const forbidden = await postJson(`${harness.baseUrl}/v1/device/commands/claim`, noCommandsToken, {waitMs: 0});
      expect(forbidden.status).toBe(403);

      const deviceToken = "pgd_claim_http";
      await harness.gatewayStore.registerDevice({
        sourceId: "work-prod",
        deviceId: "device-1",
        tokenHash: hashOpaqueToken(deviceToken),
        capabilities: ["claim_commands", "screenshot.capture", "upload_attachments"],
      });
      const empty = await postJson(`${harness.baseUrl}/v1/device/commands/claim`, deviceToken, {waitMs: 0});
      expect(empty.status).toBe(200);
      await expect(empty.json()).resolves.toEqual({ok: true, claimed: false});

      const unknownKind = await postJson(`${harness.baseUrl}/v1/device/commands/claim`, deviceToken, {
        waitMs: 0,
        kinds: ["bad.kind"],
      });
      expect(unknownKind.status).toBe(400);

      const longPoll = postJson(`${harness.baseUrl}/v1/device/commands/claim`, deviceToken, {waitMs: 500});
      await new Promise((resolve) => setTimeout(resolve, 50));
      const command = await harness.gatewayStore.enqueueDeviceCommand({
        sourceId: "work-prod",
        deviceId: "device-1",
        kind: "screenshot.capture",
        payload: {reason: "http-test"},
      });
      const response = await longPoll;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        claimed: true,
        command: {
          id: command.id,
          kind: "screenshot.capture",
          payload: {reason: "http-test"},
        },
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("requires claim ids for heartbeat/fail/complete and preserves command kind capability", async () => {
    const harness = await createHarness();
    try {
      const deviceToken = "pgd_lifecycle_http";
      await harness.gatewayStore.registerDevice({
        sourceId: "work-prod",
        deviceId: "device-1",
        tokenHash: hashOpaqueToken(deviceToken),
        capabilities: ["claim_commands", "screenshot.capture"],
      });
      const command = await harness.gatewayStore.enqueueDeviceCommand({sourceId: "work-prod", deviceId: "device-1", kind: "screenshot.capture"});
      const claim = await postJson(`${harness.baseUrl}/v1/device/commands/claim`, deviceToken, {waitMs: 0});
      const claimBody = await claim.json() as {command?: {claimId?: string; id?: string}};
      const claimId = claimBody.command?.claimId;
      if (!claimId) {
        throw new Error("Expected claimId.");
      }
      expect(claimBody.command?.id).toBe(command.id);

      const wrongHeartbeat = await postJson(`${harness.baseUrl}/v1/device/commands/${command.id}/heartbeat`, deviceToken, {claimId: "wrong"});
      expect(wrongHeartbeat.status).toBe(409);
      const heartbeat = await postJson(`${harness.baseUrl}/v1/device/commands/${command.id}/heartbeat`, deviceToken, {claimId});
      expect(heartbeat.status).toBe(200);
      await expect(heartbeat.json()).resolves.toMatchObject({status: "claimed"});

      await harness.gatewayStore.registerDevice({
        sourceId: "work-prod",
        deviceId: "device-1",
        tokenHash: hashOpaqueToken(deviceToken),
        capabilities: ["claim_commands"],
      });
      const lostCapability = await postJson(`${harness.baseUrl}/v1/device/commands/${command.id}/fail`, deviceToken, {
        claimId,
        status: "rejected",
        error: "user denied",
      });
      expect(lostCapability.status).toBe(403);

      await harness.gatewayStore.registerDevice({
        sourceId: "work-prod",
        deviceId: "device-1",
        tokenHash: hashOpaqueToken(deviceToken),
        capabilities: ["claim_commands", "screenshot.capture"],
      });
      const failed = await postJson(`${harness.baseUrl}/v1/device/commands/${command.id}/fail`, deviceToken, {
        claimId,
        status: "rejected",
        error: "user denied",
      });
      expect(failed.status).toBe(200);
      await expect(failed.json()).resolves.toMatchObject({status: "rejected"});
    } finally {
      await closeHarness(harness);
    }
  });

  it("completes commands with same-device uploaded attachments", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-gateway-command-http-"));
    const harness = await createHarness({DATA_DIR: dataDir});
    try {
      const deviceToken = "pgd_complete_http";
      await harness.gatewayStore.registerDevice({
        sourceId: "work-prod",
        deviceId: "device-1",
        tokenHash: hashOpaqueToken(deviceToken),
        capabilities: ["claim_commands", "screenshot.capture", "upload_attachments"],
      });
      const command = await harness.gatewayStore.enqueueDeviceCommand({sourceId: "work-prod", deviceId: "device-1", kind: "screenshot.capture"});
      const claim = await postJson(`${harness.baseUrl}/v1/device/commands/claim`, deviceToken, {waitMs: 0});
      const claimBody = await claim.json() as {command?: {claimId?: string}};
      const claimId = claimBody.command?.claimId;
      if (!claimId) {
        throw new Error("Expected claimId.");
      }

      const bytes = Buffer.from("device screenshot result", "utf8");
      const upload = await fetch(`${harness.baseUrl}/v2/attachments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deviceToken}`,
          "content-type": "text/plain",
          "idempotency-key": "command-result-upload",
          "x-content-sha256": sha256Hex(bytes),
          "x-filename": "result.txt",
        },
        body: bytes,
      });
      expect(upload.status).toBe(201);
      const uploadBody = await upload.json() as {attachmentId: string};
      await expect(harness.gatewayStore.getAttachment(uploadBody.attachmentId)).resolves.toMatchObject({
        connectorKey: "work-prod__device-1",
        mediaMetadata: {
          gateway: {
            deviceId: "device-1",
            trust: "external_untrusted",
          },
        },
      });

      const completed = await postJson(`${harness.baseUrl}/v1/device/commands/${command.id}/complete`, deviceToken, {
        claimId,
        result: {ok: true},
        resultAttachmentId: uploadBody.attachmentId,
      });
      expect(completed.status).toBe(200);
      await expect(completed.json()).resolves.toMatchObject({status: "completed"});
      await expect(harness.gatewayStore.getAttachment(uploadBody.attachmentId)).resolves.toMatchObject({status: "delivered"});
    } finally {
      await closeHarness(harness);
      await fs.rm(dataDir, {recursive: true, force: true});
    }
  });
});
