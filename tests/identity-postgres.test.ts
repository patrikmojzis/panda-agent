import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_IDENTITY_ID, PostgresIdentityStore,} from "../src/domain/identity/index.js";

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
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });

    expect(created.handle).toBe("alice");
    expect(created.id).toBe("alice-id");
    await expect(store.getIdentityByHandle("alice")).resolves.toMatchObject({
      id: "alice-id",
      displayName: "Alice",
    });
    await expect(store.listIdentities()).resolves.toHaveLength(2);
    await expect(store.createIdentity({
      id: "bad-empty",
      handle: "   ",
      displayName: "Bad Empty",
    })).rejects.toThrow("Identity handle must not be empty.");
    await expect(store.createIdentity({
      id: "bad-symbols",
      handle: "Alice!",
      displayName: "Bad Symbols",
    })).rejects.toThrow("Identity handle must use lowercase letters, numbers, hyphens, or underscores.");
    await expect(store.getIdentityByHandle("   ")).rejects.toThrow("Identity handle must not be empty.");
  });

  it("manages actor-scoped identity bindings", async () => {
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

    const alice = await store.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    const bob = await store.createIdentity({
      id: "bob-id",
      handle: "bob",
      displayName: "Bob",
    });

    await expect(store.resolveIdentityBinding({
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "123",
    })).resolves.toBeNull();
    await expect(store.listIdentityBindings(DEFAULT_IDENTITY_ID)).resolves.toEqual([]);
    await expect(store.createIdentityBinding({
      id: "00000000-0000-0000-0000-000000000010",
      identityId: "missing",
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "999",
    })).rejects.toThrow("Unknown identity missing");

    const binding = await store.ensureIdentityBinding({
      source: " telegram ",
      connectorKey: " bot-main ",
      externalActorId: "123",
      identityId: alice.id,
      metadata: {
        approvedBy: "tests",
      },
    });

    expect(binding).toMatchObject({
      identityId: alice.id,
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "123",
      metadata: {
        approvedBy: "tests",
      },
    });
    await expect(store.resolveIdentityBinding({
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "123",
    })).resolves.toMatchObject({
      id: binding.id,
      identityId: alice.id,
    });
    expect(binding.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const ensuredAgain = await store.ensureIdentityBinding({
      identityId: alice.id,
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "123",
    });
    expect(ensuredAgain.id).toBe(binding.id);

    await expect(store.ensureIdentityBinding({
      id: "00000000-0000-0000-0000-000000000013",
      identityId: bob.id,
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "123",
    })).rejects.toThrow(`already belongs to identity ${alice.id}`);

    const otherConnector = await store.ensureIdentityBinding({
      id: "00000000-0000-0000-0000-000000000014",
      identityId: bob.id,
      source: "telegram",
      connectorKey: "bot-sidecar",
      externalActorId: "123",
    });
    expect(otherConnector.identityId).toBe(bob.id);

    await expect(store.listIdentityBindings(alice.id)).resolves.toEqual([
      expect.objectContaining({
        id: binding.id,
        connectorKey: "bot-main",
      }),
    ]);
    await expect(store.listIdentityBindings(bob.id)).resolves.toEqual([
      expect.objectContaining({
        id: otherConnector.id,
        connectorKey: "bot-sidecar",
      }),
    ]);

    await expect(store.deleteIdentityBinding({
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "123",
    })).resolves.toBe(true);
    await expect(store.resolveIdentityBinding({
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "123",
    })).resolves.toBeNull();
    await expect(store.deleteIdentityBinding({
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "123",
    })).resolves.toBe(false);

    const rebound = await store.ensureIdentityBinding({
      id: "00000000-0000-0000-0000-000000000015",
      identityId: bob.id,
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "123",
    });
    expect(rebound).toMatchObject({
      id: "00000000-0000-0000-0000-000000000015",
      identityId: bob.id,
    });

    await expect(store.ensureIdentityBinding({
      identityId: alice.id,
      source: "   ",
      connectorKey: "bot-main",
      externalActorId: "123",
    })).rejects.toThrow("Identity binding source must not be empty.");
    await expect(store.resolveIdentityBinding({
      source: "telegram",
      connectorKey: "   ",
      externalActorId: "123",
    })).rejects.toThrow("Identity binding connector key must not be empty.");
    await expect(store.createIdentityBinding({
      id: "00000000-0000-0000-0000-000000000016",
      identityId: alice.id,
      source: "telegram",
      connectorKey: "bot-main",
      externalActorId: "   ",
    })).rejects.toThrow("Identity binding external actor id must not be empty.");
  });
});
