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

  it("claims and reschedules due heartbeats", async () => {
    const pool = createPool();
    pools.push(pool);

    const store = new PostgresHomeThreadStore({pool});
    await store.ensureSchema();

    await store.bindHomeThread({
      identityId: "identity-1",
      threadId: "thread-a",
    });
    await pool.query(
      `UPDATE "thread_runtime_home_threads" SET heartbeat_next_fire_at = $2 WHERE identity_id = $1`,
      ["identity-1", new Date(Date.now() - 1_000)],
    );

    const due = await store.listDueHeartbeats({
      asOf: Date.now(),
    });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      identityId: "identity-1",
      threadId: "thread-a",
    });

    const claimed = await store.claimHeartbeat({
      identityId: "identity-1",
      claimedBy: "runner-1",
      claimExpiresAt: Date.now() + 60_000,
    });
    expect(claimed?.heartbeat.claimedBy).toBe("runner-1");
    await expect(store.claimHeartbeat({
      identityId: "identity-1",
      claimedBy: "runner-2",
      claimExpiresAt: Date.now() + 60_000,
    })).resolves.toBeNull();

    const recorded = await store.recordHeartbeatResult({
      identityId: "identity-1",
      claimedBy: "runner-1",
      nextFireAt: Date.now() + 30 * 60_000,
      lastFireAt: Date.now(),
      lastSkipReason: null,
    });
    expect(recorded.heartbeat.claimedBy).toBeUndefined();
    expect(recorded.heartbeat.claimedAt).toBeUndefined();
    expect(recorded.heartbeat.lastFireAt).toBeDefined();
    expect(recorded.heartbeat.lastSkipReason).toBeUndefined();
    expect(recorded.heartbeat.nextFireAt).toBeGreaterThan(Date.now());
  });

  it("updates heartbeat config and reschedules from now", async () => {
    const pool = createPool();
    pools.push(pool);

    const store = new PostgresHomeThreadStore({pool});
    await store.ensureSchema();

    await store.bindHomeThread({
      identityId: "identity-1",
      threadId: "thread-a",
    });

    const disabled = await store.updateHeartbeatConfig({
      identityId: "identity-1",
      enabled: false,
      asOf: Date.UTC(2026, 3, 10, 12, 0, 0),
    });
    expect(disabled.heartbeat.enabled).toBe(false);
    expect(disabled.heartbeat.everyMinutes).toBe(30);
    expect(disabled.heartbeat.nextFireAt).toBe(Date.UTC(2026, 3, 10, 12, 30, 0));

    const updated = await store.updateHeartbeatConfig({
      identityId: "identity-1",
      enabled: true,
      everyMinutes: 45,
      asOf: Date.UTC(2026, 3, 10, 13, 0, 0),
    });
    expect(updated.heartbeat.enabled).toBe(true);
    expect(updated.heartbeat.everyMinutes).toBe(45);
    expect(updated.heartbeat.nextFireAt).toBe(Date.UTC(2026, 3, 10, 13, 45, 0));
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
    await expect(store.updateHeartbeatConfig({
      identityId: "identity-1",
      everyMinutes: 0,
    })).rejects.toThrow("Home thread heartbeat interval must be a positive integer.");
  });
});
