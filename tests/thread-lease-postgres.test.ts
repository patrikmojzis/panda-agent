import {describe, expect, it, vi} from "vitest";

import {PostgresThreadLeaseManager} from "../src/domain/threads/runtime/index.js";

describe("PostgresThreadLeaseManager", () => {
  it("returns null and releases the client when the advisory lock is held", async () => {
    const client = {
      query: vi.fn(async () => ({rows: [{acquired: false}]})),
      release: vi.fn(),
    };
    const manager = new PostgresThreadLeaseManager({
      connect: vi.fn(async () => client),
    });

    await expect(manager.tryAcquire("thread-held")).resolves.toBeNull();

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed advisory-lock rows before treating them as acquired", async () => {
    const client = {
      query: vi.fn(async () => ({rows: [{acquired: "false"}]})),
      release: vi.fn(),
    };
    const manager = new PostgresThreadLeaseManager({
      connect: vi.fn(async () => client),
    });

    await expect(manager.tryAcquire("thread-bad-row")).rejects.toThrow(
      "Thread lease acquisition result must be a boolean.",
    );

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("unlocks once when an acquired lease is released repeatedly", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          return {rows: [{acquired: true}]};
        }

        return {rows: []};
      }),
      release: vi.fn(),
    };
    const manager = new PostgresThreadLeaseManager({
      connect: vi.fn(async () => client),
    });

    const lease = await manager.tryAcquire("thread-owned");
    expect(lease).not.toBeNull();
    await lease?.release();
    await lease?.release();

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
