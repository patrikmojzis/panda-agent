import {afterEach, describe, expect, it, vi} from "vitest";
import {newDb} from "pg-mem";

import {
  acquireManagedConnectorLease,
  type ConnectorLeaseRepository,
  PostgresConnectorLeaseRepo,
} from "../src/domain/connector-leases/repo.js";
import {ensurePostgresConnectorLeaseSchema} from "../src/domain/connector-leases/postgres-schema.js";

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
    await ensurePostgresConnectorLeaseSchema(pool);

    const acquired = await repo.tryAcquire({
      source: "telegram",
      connectorKey: "bot-1",
      holderId: "holder-a",
      ttlMs: 10_000,
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
      ttlMs: 10_000,
    })).resolves.toBeNull();

    const renewed = await repo.renew({
      source: "telegram",
      connectorKey: "bot-1",
      holderId: "holder-a",
      ttlMs: 20_000,
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
      ttlMs: 10_000,
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
    await ensurePostgresConnectorLeaseSchema(pool);

    await repo.tryAcquire({
      source: "whatsapp",
      connectorKey: "main",
      holderId: "holder-a",
      ttlMs: 10_000,
    });
    await pool.query(`
      UPDATE "runtime"."connector_leases"
      SET leased_until = NOW() - INTERVAL '1 second'
      WHERE source = 'whatsapp'
        AND connector_key = 'main'
    `);

    const replacement = await repo.tryAcquire({
      source: "whatsapp",
      connectorKey: "main",
      holderId: "holder-b",
      ttlMs: 10_000,
    });

    expect(replacement).toMatchObject({
      holderId: "holder-b",
    });
  });

  it("does not let an application clock jump steal a database lease", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const repo = new PostgresConnectorLeaseRepo({pool});
    await ensurePostgresConnectorLeaseSchema(pool);
    await repo.tryAcquire({
      source: "discord",
      connectorKey: "main",
      holderId: "holder-a",
      ttlMs: 10_000,
    });

    const localClock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60_000);
    try {
      await expect(repo.tryAcquire({
        source: "discord",
        connectorKey: "main",
        holderId: "holder-b",
        ttlMs: 10_000,
      })).resolves.toBeNull();
    } finally {
      localClock.mockRestore();
    }
  });

  it("rejects corrupted persisted lease timestamps before returning records", async () => {
    const repo = new PostgresConnectorLeaseRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            source: "telegram",
            connector_key: "bot-1",
            holder_id: "holder-a",
            leased_until: "not-a-date",
            created_at: new Date(),
            updated_at: new Date(),
          }],
        })),
      },
    });

    await expect(repo.tryAcquire({
      source: "telegram",
      connectorKey: "bot-1",
      holderId: "holder-a",
      ttlMs: 10_000,
    })).rejects.toThrow("Connector lease leasedUntil must be a valid timestamp.");
  });

  it("rejects stringified persisted lease timestamps before returning records", async () => {
    const repo = new PostgresConnectorLeaseRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            source: "telegram",
            connector_key: "bot-1",
            holder_id: "holder-a",
            leased_until: "2026-05-01T12:00:00.000Z",
            created_at: new Date(),
            updated_at: new Date(),
          }],
        })),
      },
    });

    await expect(repo.tryAcquire({
      source: "telegram",
      connectorKey: "bot-1",
      holderId: "holder-a",
      ttlMs: 10_000,
    })).rejects.toThrow("Connector lease leasedUntil must be a valid timestamp.");
  });

  it("marks a managed lease as lost when renewals stop matching", async () => {
    vi.useFakeTimers();
    const repo: ConnectorLeaseRepository = {
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
      repo,
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
