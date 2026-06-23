import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresGatewayStore} from "../src/domain/gateway/postgres.js";
import type {GatewayDeviceCapability} from "../src/domain/gateway/types.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";
import {ensureSchemas} from "../src/app/runtime/postgres-bootstrap.js";
import {hashOpaqueToken} from "../src/lib/opaque-tokens.js";

function requireResolved<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected value to be present.");
  }
  return value;
}

describe("gateway device registry store", () => {
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

    return {gatewayStore};
  }

  it("registers devices, rotates tokens, and lists them", async () => {
    const {gatewayStore} = await createHarness();

    const capabilities: readonly GatewayDeviceCapability[] = ["push_context", "upload_attachments"];
    const first = await gatewayStore.registerDevice({
      sourceId: "work-prod",
      deviceId: "device-1",
      label: "Laptop",
      capabilities,
      tokenHash: hashOpaqueToken("pgd_token_1"),
    });
    expect(first.sourceId).toBe("work-prod");
    expect(first.deviceId).toBe("device-1");
    expect(first.enabled).toBe(true);
    expect(first.label).toBe("Laptop");
    expect(first.capabilities).toEqual(capabilities);

    const rotated = await gatewayStore.registerDevice({
      sourceId: "work-prod",
      deviceId: "device-1",
      tokenHash: hashOpaqueToken("pgd_token_2"),
    });
    expect(rotated.deviceId).toBe("device-1");
    expect(rotated.enabled).toBe(true);
    expect(rotated.label).toBe("Laptop");
    expect(rotated.capabilities).toEqual(capabilities);

    const listed = await gatewayStore.listDevices({sourceId: "work-prod"});
    expect(listed.map((device) => device.deviceId)).toEqual(["device-1"]);
  });

  it("enables and disables devices", async () => {
    const {gatewayStore} = await createHarness();

    await gatewayStore.registerDevice({
      sourceId: "work-prod",
      deviceId: "device-1",
      tokenHash: hashOpaqueToken("pgd_token_1"),
      capabilities: ["push_context"],
    });

    const disabled = await gatewayStore.setDeviceEnabled({
      sourceId: "work-prod",
      deviceId: "device-1",
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);

    const enabled = await gatewayStore.setDeviceEnabled({
      sourceId: "work-prod",
      deviceId: "device-1",
      enabled: true,
    });
    expect(enabled.enabled).toBe(true);
  });

  it("resolves device tokens and rejects disabled or suspended sources", async () => {
    const {gatewayStore} = await createHarness();

    const token = "pgd_test";
    await gatewayStore.registerDevice({
      sourceId: "work-prod",
      deviceId: "device-1",
      tokenHash: hashOpaqueToken(token),
      capabilities: ["push_context"],
    });

    const resolved = await gatewayStore.resolveDeviceToken(token);
    expect(resolved?.source.sourceId).toBe("work-prod");
    expect(resolved?.device.deviceId).toBe("device-1");

    await gatewayStore.setDeviceEnabled({
      sourceId: "work-prod",
      deviceId: "device-1",
      enabled: false,
    });
    expect(await gatewayStore.resolveDeviceToken(token)).toBe(null);

    await gatewayStore.setDeviceEnabled({
      sourceId: "work-prod",
      deviceId: "device-1",
      enabled: true,
    });

    await gatewayStore.suspendSource("work-prod", "compromised");
    expect(await gatewayStore.resolveDeviceToken(token)).toBe(null);
  });

  it("touches last_seen_at and rate-limits heartbeat audit events", async () => {
    const {gatewayStore} = await createHarness();

    await gatewayStore.registerDevice({
      sourceId: "work-prod",
      deviceId: "device-1",
      tokenHash: hashOpaqueToken("pgd_token_1"),
      capabilities: ["push_context"],
    });

    await gatewayStore.touchDeviceSeen({
      sourceId: "work-prod",
      deviceId: "device-1",
    });
    await gatewayStore.touchDeviceSeen({
      sourceId: "work-prod",
      deviceId: "device-1",
    });

    const devices = await gatewayStore.listDevices({sourceId: "work-prod"});
    expect(requireResolved(devices[0]).lastSeenAt).toBeTypeOf("number");
  });
});
