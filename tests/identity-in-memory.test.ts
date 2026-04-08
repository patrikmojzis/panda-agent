import { describe, expect, it } from "vitest";

import { DEFAULT_IDENTITY_ID, InMemoryIdentityStore } from "../src/index.js";

describe("InMemoryIdentityStore", () => {
  it("only exposes the built-in local identity", async () => {
    const store = new InMemoryIdentityStore();

    await expect(store.getIdentity(DEFAULT_IDENTITY_ID)).resolves.toMatchObject({
      handle: "local",
      displayName: "Local",
      status: "active",
    });

    await expect(store.listIdentities()).resolves.toEqual([
      expect.objectContaining({
        id: "local",
        handle: "local",
      }),
    ]);
  });

  it("rejects non-local identity writes without Postgres", async () => {
    const store = new InMemoryIdentityStore();

    await expect(store.createIdentity({
      id: "alice",
      handle: "alice",
      displayName: "Alice",
    })).rejects.toThrow("Persisted identities require Postgres");
    await expect(store.getIdentityByHandle("alice")).rejects.toThrow("Persisted identities require Postgres");
  });
});
