import { afterEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { initAuthCreds, proto } from "baileys";

import { PostgresWhatsAppAuthStore } from "../src/features/whatsapp/auth-store.js";

describe("PostgresWhatsAppAuthStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("loads default creds and persists updates", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresWhatsAppAuthStore({ pool });
    await store.ensureSchema();

    const initialCreds = await store.loadCreds(" wa-main ");
    expect(initialCreds.registered).toBe(false);

    const nextCreds = initAuthCreds();
    nextCreds.registered = true;
    nextCreds.pairingCode = "123-456";
    nextCreds.lastPropHash = "prop-hash";

    const saved = await store.saveCreds("wa-main", nextCreds);
    expect(saved.connectorKey).toBe("wa-main");
    expect(saved.creds.registered).toBe(true);
    expect(saved.creds.pairingCode).toBe("123-456");

    await expect(store.loadCreds("wa-main")).resolves.toMatchObject({
      registered: true,
      pairingCode: "123-456",
      lastPropHash: "prop-hash",
    });
  });

  it("round-trips signal keys and deletes nulled entries", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresWhatsAppAuthStore({ pool });
    await store.ensureSchema();

    const syncKey = proto.Message.AppStateSyncKeyData.fromObject({
      keyData: Buffer.from("abc"),
      fingerprint: {
        rawId: 7,
        currentIndex: 3,
        deviceIndexes: [1, 2],
      },
      timestamp: 123,
    });

    await store.saveSignalKeys("wa-main", {
      session: {
        "session-1": Buffer.from("hello"),
      },
      "app-state-sync-key": {
        "sync-1": syncKey,
      },
    });

    const sessions = await store.loadSignalKeys("wa-main", "session", ["session-1"]);
    expect(Buffer.from(sessions["session-1"] ?? []).toString()).toBe("hello");

    const appStateKeys = await store.loadSignalKeys("wa-main", "app-state-sync-key", ["sync-1"]);
    expect(appStateKeys["sync-1"]).toBeDefined();
    expect(Buffer.from(appStateKeys["sync-1"]?.keyData ?? []).toString()).toBe("abc");

    await store.saveSignalKeys("wa-main", {
      session: {
        "session-1": null,
      },
    });

    const afterDelete = await store.loadSignalKeys("wa-main", "session", ["session-1"]);
    expect(afterDelete["session-1"]).toBeUndefined();
  });

  it("creates a Baileys auth state handle backed by Postgres", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresWhatsAppAuthStore({ pool });
    await store.ensureSchema();

    const handle = await store.createAuthState("wa-main");
    handle.state.creds.registered = true;
    handle.state.creds.pairingCode = "654-321";
    await handle.state.keys.set({
      session: {
        "session-2": Buffer.from("pong"),
      },
    });
    await handle.saveCreds();

    await expect(store.loadCreds("wa-main")).resolves.toMatchObject({
      registered: true,
      pairingCode: "654-321",
    });

    const sessions = await store.loadSignalKeys("wa-main", "session", ["session-2"]);
    expect(Buffer.from(sessions["session-2"] ?? []).toString()).toBe("pong");
  });
});
