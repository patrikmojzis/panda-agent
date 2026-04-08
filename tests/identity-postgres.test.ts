import { afterEach, describe, expect, it } from "vitest";
import { DataType, newDb } from "pg-mem";

import { DEFAULT_IDENTITY_ID, PostgresIdentityStore } from "../src/index.js";

describe("PostgresIdentityStore", () => {
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

  it("persists identities and seeds the local identity", async () => {
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

    const store = new PostgresIdentityStore({ pool });
    await store.ensureSchema();

    await expect(store.getIdentity(DEFAULT_IDENTITY_ID)).resolves.toMatchObject({
      handle: "local",
      displayName: "Local",
      status: "active",
    });

    const created = await store.createIdentity({
      id: "alice",
      handle: "alice",
      displayName: "Alice",
    });

    expect(created.handle).toBe("alice");
    await expect(store.getIdentityByHandle("alice")).resolves.toMatchObject({
      id: "alice",
      displayName: "Alice",
    });
    await expect(store.listIdentities()).resolves.toHaveLength(2);
  });
});
