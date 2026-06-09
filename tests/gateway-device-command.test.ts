import {createHash, randomUUID} from "node:crypto";

import {Command} from "commander";
import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore} from "../src/domain/agents/index.js";
import {
  GatewayDeviceCommandError,
  PostgresGatewayStore,
} from "../src/domain/gateway/postgres.js";
import {buildGatewayTableNames} from "../src/domain/gateway/postgres-shared.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";
import {disallowGatewayEventTypeWithStore, registerGatewayManagementCommands} from "../src/domain/gateway/cli.js";
import {ensureSchemas} from "../src/app/runtime/postgres-bootstrap.js";
import {hashOpaqueToken} from "../src/lib/opaque-tokens.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireClaimId(value: string | undefined): string {
  if (!value) {
    throw new Error("Expected command claim id.");
  }
  return value;
}

describe("gateway device command CLI", () => {
  it("registers the local command mailbox admin command tree", () => {
    const gateway = new Command("gateway");
    registerGatewayManagementCommands(gateway);
    const device = gateway.commands.find((command) => command.name() === "device");
    const commandGroup = device?.commands.find((command) => command.name() === "command");
    expect(commandGroup?.commands.map((command) => command.name()).sort()).toEqual([
      "cancel",
      "enqueue",
      "list",
      "timeout-sweep",
    ]);
  });

  it("registers source disallow-type and reports deleted versus already absent event types", async () => {
    const gateway = new Command("gateway");
    registerGatewayManagementCommands(gateway);
    const source = gateway.commands.find((command) => command.name() === "source");
    expect(source?.commands.map((command) => command.name())).toContain("disallow-type");

    const deleteEventType = vi.fn(async () => true);
    await expect(disallowGatewayEventTypeWithStore({deleteEventType}, "work-prod", "meeting.transcript"))
      .resolves.toBe("Disallowed meeting.transcript for work-prod.");
    expect(deleteEventType).toHaveBeenCalledWith("work-prod", "meeting.transcript");

    deleteEventType.mockResolvedValueOnce(false);
    await expect(disallowGatewayEventTypeWithStore({deleteEventType}, "work-prod", "meeting.transcript"))
      .resolves.toBe("Event type meeting.transcript was already absent for work-prod.");
  });
});

describe("gateway device command mailbox store", () => {
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
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    const identity = await identityStore.createIdentity({
      id: "identity-1",
      handle: "patrik",
      displayName: "Patrik",
    });
    await agentStore.ensurePairing("panda", identity.id);
    await gatewayStore.createSource({sourceId: "work-prod", agentKey: "panda", identityId: identity.id});
    await gatewayStore.createSource({sourceId: "other-prod", agentKey: "panda", identityId: identity.id});
    await gatewayStore.registerDevice({
      sourceId: "work-prod",
      deviceId: "device-1",
      tokenHash: hashOpaqueToken("pgd_device_1"),
      capabilities: ["claim_commands", "screenshot.capture", "upload_attachments"],
    });
    await gatewayStore.registerDevice({
      sourceId: "work-prod",
      deviceId: "device-2",
      tokenHash: hashOpaqueToken("pgd_device_2"),
      capabilities: ["claim_commands", "screenshot.capture", "upload_attachments"],
    });
    await gatewayStore.registerDevice({
      sourceId: "other-prod",
      deviceId: "device-1",
      tokenHash: hashOpaqueToken("pgd_other_device"),
      capabilities: ["claim_commands", "screenshot.capture", "upload_attachments"],
    });
    return {gatewayStore, pool};
  }

  async function uploadCommandAttachment(input: {
    connectorKey?: string;
    expiresAt?: number;
    idempotencyKey: string;
    sourceId?: string;
    text?: string;
  }, gatewayStore: PostgresGatewayStore) {
    const text = input.text ?? "screenshot bytes";
    const id = randomUUID();
    const result = await gatewayStore.storeAttachmentUpload({
      sourceId: input.sourceId ?? "work-prod",
      idempotencyKey: input.idempotencyKey,
      descriptor: {
        id,
        source: "gateway",
        connectorKey: input.connectorKey ?? "work-prod__device-1",
        mimeType: "text/plain",
        sizeBytes: Buffer.byteLength(text, "utf8"),
        localPath: `/tmp/${id}.txt`,
        originalFilename: "result.txt",
        metadata: {schemaVersion: 1, gateway: {sourceId: input.sourceId ?? "work-prod", deviceId: "device-1"}},
        createdAt: Date.now(),
      },
      sha256: sha256Hex(text),
      mimeType: "text/plain",
      filename: "result.txt",
      expiresAt: input.expiresAt ?? Date.now() + 60_000,
    });
    return result.attachment;
  }

  it("creates the command table and rejects devices that cannot claim the command kind", async () => {
    const {gatewayStore, pool} = await createHarness();
    const tables = buildGatewayTableNames();
    await expect(pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${tables.commands}`)).resolves.toMatchObject({
      rows: [{count: 0}],
    });

    await gatewayStore.registerDevice({
      sourceId: "work-prod",
      deviceId: "no-commands",
      tokenHash: hashOpaqueToken("pgd_no_commands"),
      capabilities: ["screenshot.capture"],
    });
    await expect(gatewayStore.enqueueDeviceCommand({
      sourceId: "work-prod",
      deviceId: "no-commands",
      kind: "screenshot.capture",
    })).rejects.toMatchObject({reason: "forbidden"});

    await gatewayStore.registerDevice({
      sourceId: "work-prod",
      deviceId: "no-screenshot",
      tokenHash: hashOpaqueToken("pgd_no_screenshot"),
      capabilities: ["claim_commands"],
    });
    await expect(gatewayStore.enqueueDeviceCommand({
      sourceId: "work-prod",
      deviceId: "no-screenshot",
      kind: "screenshot.capture",
    })).rejects.toBeInstanceOf(GatewayDeviceCommandError);
  });

  it("enqueues, lists, and claims the oldest queued matching command once", async () => {
    const {gatewayStore, pool} = await createHarness();
    const tables = buildGatewayTableNames();
    const first = await gatewayStore.enqueueDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      kind: "screenshot.capture",
      payload: {window: "frontmost"},
    });
    const second = await gatewayStore.enqueueDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      kind: "screenshot.capture",
      payload: {window: "all"},
    });
    await pool.query(`UPDATE ${tables.commands} SET created_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [first.id]);

    await expect(gatewayStore.listDeviceCommands({sourceId: "work-prod", status: "queued"}))
      .resolves.toHaveLength(2);
    const claimedFirst = await gatewayStore.claimNextDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      allowedKinds: ["screenshot.capture"],
    });
    expect(claimedFirst).toMatchObject({claimed: true});
    if (!claimedFirst.claimed) {
      throw new Error("Expected first command to be claimed.");
    }
    expect(claimedFirst.command.id).toBe(first.id);
    expect(claimedFirst.command.claimId).toBeTypeOf("string");

    const claimedSecond = await gatewayStore.claimNextDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      allowedKinds: ["screenshot.capture"],
    });
    expect(claimedSecond).toMatchObject({claimed: true});
    if (!claimedSecond.claimed) {
      throw new Error("Expected second command to be claimed.");
    }
    expect(claimedSecond.command.id).toBe(second.id);

    await expect(gatewayStore.claimNextDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      allowedKinds: ["screenshot.capture"],
    })).resolves.toEqual({claimed: false});
  });

  it("heartbeats, completes, fails, cancels, and sweeps lifecycle states", async () => {
    const {gatewayStore, pool} = await createHarness();
    const tables = buildGatewayTableNames();
    const toCancel = await gatewayStore.enqueueDeviceCommand({sourceId: "work-prod", deviceId: "device-1", kind: "screenshot.capture"});
    await expect(gatewayStore.cancelQueuedDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      commandId: toCancel.id,
      reason: "not needed",
    })).resolves.toMatchObject({status: "cancelled", error: "not needed"});

    const toComplete = await gatewayStore.enqueueDeviceCommand({sourceId: "work-prod", deviceId: "device-1", kind: "screenshot.capture"});
    const claimedComplete = await gatewayStore.claimNextDeviceCommand({sourceId: "work-prod", deviceId: "device-1", allowedKinds: ["screenshot.capture"]});
    if (!claimedComplete.claimed) {
      throw new Error("Expected command claim.");
    }
    expect(claimedComplete.command.id).toBe(toComplete.id);
    const heartbeat = await gatewayStore.heartbeatDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      commandId: toComplete.id,
      claimId: requireClaimId(claimedComplete.command.claimId),
      allowedKinds: ["screenshot.capture"],
    });
    expect(heartbeat.status).toBe("claimed");
    const completed = await gatewayStore.completeDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      commandId: toComplete.id,
      claimId: requireClaimId(claimedComplete.command.claimId),
      allowedKinds: ["screenshot.capture"],
      result: {ok: true},
    });
    expect(completed).toMatchObject({status: "completed", result: {ok: true}});

    await gatewayStore.enqueueDeviceCommand({sourceId: "work-prod", deviceId: "device-1", kind: "screenshot.capture"});
    const claimedFail = await gatewayStore.claimNextDeviceCommand({sourceId: "work-prod", deviceId: "device-1", allowedKinds: ["screenshot.capture"]});
    if (!claimedFail.claimed) {
      throw new Error("Expected failure command claim.");
    }
    const failCommandId = claimedFail.command.id;
    await expect(gatewayStore.failDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      commandId: failCommandId,
      claimId: "wrong-claim",
      allowedKinds: ["screenshot.capture"],
      status: "rejected",
      error: "user denied",
    })).rejects.toMatchObject({reason: "conflict"});
    await expect(gatewayStore.failDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      commandId: failCommandId,
      claimId: requireClaimId(claimedFail.command.claimId),
      allowedKinds: ["screenshot.capture"],
      status: "rejected",
      error: "user denied",
    })).resolves.toMatchObject({status: "rejected", error: "user denied"});

    await gatewayStore.enqueueDeviceCommand({sourceId: "work-prod", deviceId: "device-1", kind: "screenshot.capture"});
    const claimedTimeout = await gatewayStore.claimNextDeviceCommand({sourceId: "work-prod", deviceId: "device-1", allowedKinds: ["screenshot.capture"]});
    if (!claimedTimeout.claimed) {
      throw new Error("Expected timeout command claim.");
    }
    const timeoutCommandId = claimedTimeout.command.id;
    await pool.query(`UPDATE ${tables.commands} SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [timeoutCommandId]);
    await expect(gatewayStore.markStaleClaimedDeviceCommandsTimedOut({sourceId: "work-prod", staleMs: 60_000, limit: 10}))
      .resolves.toMatchObject([{id: timeoutCommandId, status: "timed_out"}]);
  });

  it("delivers only same-source same-device uploaded result attachments", async () => {
    const {gatewayStore} = await createHarness();
    const command = await gatewayStore.enqueueDeviceCommand({sourceId: "work-prod", deviceId: "device-1", kind: "screenshot.capture"});
    const claimed = await gatewayStore.claimNextDeviceCommand({sourceId: "work-prod", deviceId: "device-1", allowedKinds: ["screenshot.capture"]});
    if (!claimed.claimed) {
      throw new Error("Expected command claim.");
    }
    expect(claimed.command.id).toBe(command.id);

    const wrongDevice = await uploadCommandAttachment({
      idempotencyKey: "wrong-device",
      connectorKey: "work-prod__device-2",
    }, gatewayStore);
    await expect(gatewayStore.completeDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      commandId: command.id,
      claimId: requireClaimId(claimed.command.claimId),
      allowedKinds: ["screenshot.capture"],
      resultAttachmentId: wrongDevice.id,
    })).rejects.toMatchObject({reason: "conflict"});

    const attachment = await uploadCommandAttachment({idempotencyKey: "same-device"}, gatewayStore);
    const completed = await gatewayStore.completeDeviceCommand({
      sourceId: "work-prod",
      deviceId: "device-1",
      commandId: command.id,
      claimId: requireClaimId(claimed.command.claimId),
      allowedKinds: ["screenshot.capture"],
      result: {attachment: true},
      resultAttachmentId: attachment.id,
      attachmentRetentionMs: 10_000,
    });
    expect(completed).toMatchObject({status: "completed", resultAttachmentId: attachment.id});
    await expect(gatewayStore.getAttachment(attachment.id)).resolves.toMatchObject({status: "delivered"});
  });
});
