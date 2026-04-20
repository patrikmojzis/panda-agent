import {afterEach, describe, expect, it, vi} from "vitest";
import {newDb} from "pg-mem";

import {acquireManagedConnectorLease, PostgresConnectorLeaseRepo,} from "../src/domain/connector-leases/index.js";

describe("PostgresConnectorLeaseRepo", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  it("acquires, renews, releases, and re-acquires leases", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const repo = new PostgresConnectorLeaseRepo({pool});
    await repo.ensureSchema();

    const acquired = await repo.tryAcquire({
      source: "telegram",
      connectorKey: "bot-1",
      holderId: "holder-a",
      leasedUntil: Date.now() + 10_000,
    });

    expect(acquired).toMatchObject({
      source: "telegram",
      connectorKey: "bot-1",
      holderId: "holder-a",
    });

    await expect(repo.tryAcquire({
      source: "telegram",
      connectorKey: "bot-1",
      holderId: "holder-b",
      leasedUntil: Date.now() + 10_000,
    })).resolves.toBeNull();

    const renewed = await repo.renew({
      source: "telegram",
      connectorKey: "bot-1",
      holderId: "holder-a",
      leasedUntil: Date.now() + 20_000,
    });
    expect(renewed?.leasedUntil).toBeGreaterThan(acquired?.leasedUntil ?? 0);

    await expect(repo.release({
      source: "telegram",
      connectorKey: "bot-1",
      holderId: "holder-a",
    })).resolves.toBe(true);

    const reacquired = await repo.tryAcquire({
      source: "telegram",
      connectorKey: "bot-1",
      holderId: "holder-b",
      leasedUntil: Date.now() + 10_000,
    });
    expect(reacquired).toMatchObject({
      holderId: "holder-b",
    });
  });

  it("allows a new holder to take over an expired lease", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const repo = new PostgresConnectorLeaseRepo({pool});
    await repo.ensureSchema();

    await repo.tryAcquire({
      source: "whatsapp",
      connectorKey: "main",
      holderId: "holder-a",
      leasedUntil: Date.now() - 1_000,
    });

    const replacement = await repo.tryAcquire({
      source: "whatsapp",
      connectorKey: "main",
      holderId: "holder-b",
      leasedUntil: Date.now() + 10_000,
    });

    expect(replacement).toMatchObject({
      holderId: "holder-b",
    });
  });

  it("marks a managed lease as lost when renewals stop matching", async () => {
    vi.useFakeTimers();
    const repo = {
      tryAcquire: vi.fn(async () => ({
        source: "telegram",
        connectorKey: "bot-1",
        holderId: "holder-a",
        leasedUntil: Date.now() + 50,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
      renew: vi.fn(async () => null),
      release: vi.fn(async () => true),
    };
    const onLeaseLost = vi.fn(async () => {});

    const lease = await acquireManagedConnectorLease({
      repo: repo as any,
      source: "telegram",
      connectorKey: "bot-1",
      alreadyHeldMessage: "busy",
      holderId: "holder-a",
      ttlMs: 50,
      renewIntervalMs: 10,
      onLeaseLost,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    expect(repo.release).not.toHaveBeenCalled();
    await lease.release();
    expect(repo.release).toHaveBeenCalledTimes(1);
  });
});
