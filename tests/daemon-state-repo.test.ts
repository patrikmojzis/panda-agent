import {afterEach, describe, expect, it, vi} from "vitest";
import {newDb} from "pg-mem";

import {DaemonStateRepo} from "../src/app/runtime/state/repo.js";

describe("DaemonStateRepo", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  it("persists daemon heartbeat state by non-empty daemon key", async () => {
    const adapter = newDb().adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const repo = new DaemonStateRepo({pool});
    await repo.ensureSchema();

    const heartbeat = await repo.heartbeat(" daemon-main ");

    expect(heartbeat.daemonKey).toBe("daemon-main");
    await expect(repo.readState("daemon-main")).resolves.toMatchObject({
      daemonKey: "daemon-main",
      startedAt: heartbeat.startedAt,
    });
    await expect(repo.heartbeat("   ")).rejects.toThrow("Daemon key must not be empty.");
  });

  it("rejects corrupted daemon timestamps before returning state", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        daemon_key: "daemon-main",
        heartbeat_at: "not-a-date",
        started_at: new Date(),
        updated_at: new Date(),
      }],
    }));
    const repo = new DaemonStateRepo({
      pool: {query},
    });

    await expect(repo.readState("daemon-main")).rejects.toThrow(
      "Daemon state heartbeat_at must be a valid timestamp.",
    );
  });

  it("rejects stringified daemon timestamps before returning state", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        daemon_key: "daemon-main",
        heartbeat_at: "2026-05-01T12:00:00.000Z",
        started_at: new Date(),
        updated_at: new Date(),
      }],
    }));
    const repo = new DaemonStateRepo({
      pool: {query},
    });

    await expect(repo.readState("daemon-main")).rejects.toThrow(
      "Daemon state heartbeat_at must be a valid timestamp.",
    );
  });
});
