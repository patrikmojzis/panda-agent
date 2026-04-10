import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresHomeThreadStore} from "../src/index.js";

function createPool() {
  const db = newDb();
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });

  const adapter = db.adapters.createPg();
  return new adapter.Pool();
}

describe("PostgresHomeThreadStore", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("binds and rebinds the home thread pointer for an identity", async () => {
    const pool = createPool();
    pools.push(pool);

    const store = new PostgresHomeThreadStore({pool});
    await store.ensureSchema();

    await expect(store.resolveHomeThread({
      identityId: "identity-1",
    })).resolves.toBeNull();

    const firstBind = await store.bindHomeThread({
      identityId: " identity-1 ",
      threadId: "thread-a",
      metadata: {
        homeDir: "/tmp/panda",
      },
    });

    expect(firstBind.previousThreadId).toBeUndefined();
    expect(firstBind.binding).toMatchObject({
      identityId: "identity-1",
      threadId: "thread-a",
      metadata: {
        homeDir: "/tmp/panda",
      },
    });

    const rebound = await store.bindHomeThread({
      identityId: "identity-1",
      threadId: "thread-b",
    });

    expect(rebound.previousThreadId).toBe("thread-a");
    expect(rebound.binding).toMatchObject({
      identityId: "identity-1",
      threadId: "thread-b",
      metadata: {
        homeDir: "/tmp/panda",
      },
    });
    await expect(store.resolveHomeThread({
      identityId: "identity-1",
    })).resolves.toMatchObject({
      identityId: "identity-1",
      threadId: "thread-b",
      metadata: {
        homeDir: "/tmp/panda",
      },
    });
  });

  it("keeps home thread bindings isolated by identity", async () => {
    const pool = createPool();
    pools.push(pool);

    const store = new PostgresHomeThreadStore({pool});
    await store.ensureSchema();

    await store.bindHomeThread({
      identityId: "identity-1",
      threadId: "thread-a",
    });
    await store.bindHomeThread({
      identityId: "identity-2",
      threadId: "thread-b",
    });

    await expect(store.resolveHomeThread({
      identityId: "identity-1",
    })).resolves.toMatchObject({threadId: "thread-a"});
    await expect(store.resolveHomeThread({
      identityId: "identity-2",
    })).resolves.toMatchObject({threadId: "thread-b"});
  });

  it("validates required fields", async () => {
    const pool = createPool();
    pools.push(pool);

    const store = new PostgresHomeThreadStore({pool});
    await store.ensureSchema();

    await expect(store.bindHomeThread({
      identityId: "   ",
      threadId: "thread-a",
    })).rejects.toThrow("Home thread identity id must not be empty.");
    await expect(store.bindHomeThread({
      identityId: "identity-1",
      threadId: "   ",
    })).rejects.toThrow("Home thread thread id must not be empty.");
    await expect(store.resolveHomeThread({
      identityId: "   ",
    })).rejects.toThrow("Home thread identity id must not be empty.");
  });
});
