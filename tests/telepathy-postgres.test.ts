import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresTelepathyDeviceStore} from "../src/domain/telepathy/postgres.js";

describe("PostgresTelepathyDeviceStore", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
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
    const identityStore = new PostgresIdentityStore({pool});
    const telepathyStore = new PostgresTelepathyDeviceStore({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await telepathyStore.ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });

    return {telepathyStore};
  }

  it("registers a device and tracks connection state through the store interface", async () => {
    const {telepathyStore} = await createHarness();

    await telepathyStore.registerDevice({
      agentKey: "panda",
      deviceId: " home-mac ",
      label: " Home Mac ",
      tokenHash: "token-hash",
    });
    await telepathyStore.markConnected("panda", "home-mac", "MacBook");

    await expect(telepathyStore.getDevice("panda", "home-mac")).resolves.toMatchObject({
      agentKey: "panda",
      deviceId: "home-mac",
      label: "MacBook",
      tokenHash: "token-hash",
      enabled: true,
      connected: true,
    });
  });

  it("disabling a device clears its connected state", async () => {
    const {telepathyStore} = await createHarness();

    await telepathyStore.registerDevice({
      agentKey: "panda",
      deviceId: "home-mac",
      tokenHash: "token-hash",
    });
    await telepathyStore.markConnected("panda", "home-mac");
    await telepathyStore.setDeviceEnabled("panda", "home-mac", false);

    await expect(telepathyStore.listDevices("panda")).resolves.toMatchObject([
      {
        deviceId: "home-mac",
        enabled: false,
        connected: false,
      },
    ]);
  });

  it("rejects malformed persisted connection state", async () => {
    const query = async () => ({
      rows: [{
        agent_key: "panda",
        device_id: "home-mac",
        label: "Home Mac",
        token_hash: "token-hash",
        connected: "yes",
        created_at: new Date(1),
        updated_at: new Date(1),
        connected_at: null,
        last_seen_at: null,
        last_disconnected_at: null,
        disabled_at: null,
      }],
    });
    const telepathyStore = new PostgresTelepathyDeviceStore({
      pool: {query},
    });

    await expect(telepathyStore.getDevice("panda", "home-mac"))
      .rejects.toThrow("Telepathy device connected state must be a boolean.");
  });

  it("rejects malformed persisted device identity fields", async () => {
    const query = async () => ({
      rows: [{
        agent_key: "",
        device_id: "home-mac",
        label: "Home Mac",
        token_hash: "token-hash",
        connected: false,
        created_at: new Date(1),
        updated_at: new Date(1),
        connected_at: null,
        last_seen_at: null,
        last_disconnected_at: null,
        disabled_at: null,
      }],
    });
    const telepathyStore = new PostgresTelepathyDeviceStore({
      pool: {query},
    });

    await expect(telepathyStore.getDevice("panda", "home-mac"))
      .rejects.toThrow("Telepathy device agent key must not be empty.");
  });

  it("rejects malformed persisted device timestamps", async () => {
    const query = async () => ({
      rows: [{
        agent_key: "panda",
        device_id: "home-mac",
        label: "Home Mac",
        token_hash: "token-hash",
        connected: false,
        created_at: "eventually",
        updated_at: new Date(1),
        connected_at: null,
        last_seen_at: null,
        last_disconnected_at: null,
        disabled_at: null,
      }],
    });
    const telepathyStore = new PostgresTelepathyDeviceStore({
      pool: {query},
    });

    await expect(telepathyStore.getDevice("panda", "home-mac"))
      .rejects.toThrow("Telepathy device created_at must be a finite timestamp.");
  });

  it("rejects stringified persisted device timestamps", async () => {
    const query = async () => ({
      rows: [{
        agent_key: "panda",
        device_id: "home-mac",
        label: "Home Mac",
        token_hash: "token-hash",
        connected: false,
        created_at: "2026-05-01T12:00:00.000Z",
        updated_at: new Date(1),
        connected_at: null,
        last_seen_at: null,
        last_disconnected_at: null,
        disabled_at: null,
      }],
    });
    const telepathyStore = new PostgresTelepathyDeviceStore({
      pool: {query},
    });

    await expect(telepathyStore.getDevice("panda", "home-mac"))
      .rejects.toThrow("Telepathy device created_at must be a finite timestamp.");
  });
});
