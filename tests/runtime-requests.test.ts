import {describe, expect, it, vi} from "vitest";

import {RuntimeRequestRepo} from "../src/domain/threads/requests/repo.js";

function createFakeNotificationClient() {
  return {
    off: vi.fn(),
    on: vi.fn(),
    query: vi.fn(async () => ({rows: []})),
    release: vi.fn(),
  };
}

describe("RuntimeRequestRepo", () => {
  it("uses the notification pool for LISTEN clients", async () => {
    const queryPool = {
      connect: vi.fn(async () => {
        throw new Error("query pool should not be used for LISTEN");
      }),
      query: vi.fn(async () => ({rows: []})),
    };
    const client = createFakeNotificationClient();
    const notificationPool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({rows: []})),
    };
    const repo = new RuntimeRequestRepo({
      pool: queryPool,
      notificationPool,
    });

    const unsubscribe = await repo.listenPendingRequests(() => {});
    await unsubscribe();

    expect(queryPool.connect).not.toHaveBeenCalled();
    expect(notificationPool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "LISTEN runtime_request_events");
    expect(client.query).toHaveBeenNthCalledWith(2, "UNLISTEN runtime_request_events");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("releases the notification client when LISTEN setup fails", async () => {
    const queryPool = {
      connect: vi.fn(async () => {
        throw new Error("query pool should not be used for LISTEN");
      }),
      query: vi.fn(async () => ({rows: []})),
    };
    const client = createFakeNotificationClient();
    client.query.mockRejectedValueOnce(new Error("listen blew up"));
    const repo = new RuntimeRequestRepo({
      pool: queryPool,
      notificationPool: {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => ({rows: []})),
      },
    });

    await expect(repo.listenPendingRequests(() => {})).rejects.toThrow("listen blew up");

    expect(client.off).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("allows stale running requests to be reclaimed", async () => {
    const claimedAt = new Date(Date.now() - 10 * 60_000);
    const row = {
      id: "7a0b9429-d5bf-41dc-9224-088cff4d2137",
      kind: "telegram_message",
      status: "running",
      payload: {connectorKey: "bot-1"},
      result: null,
      error: null,
      claimed_at: claimedAt,
      finished_at: null,
      created_at: claimedAt,
      updated_at: claimedAt,
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return {rows: []};
        }
        return {rows: [row]};
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({rows: []})),
    };
    const repo = new RuntimeRequestRepo({
      pool,
      staleRunningRequestMs: 123_456,
    });

    const claimed = await repo.claimNextPendingRequest();

    expect(claimed).toMatchObject({
      id: row.id,
      status: "running",
      payload: row.payload,
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status = 'running'"), [
      123_456,
    ]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("claimed_at < NOW() - ($1 * INTERVAL '1 millisecond')"), [
      123_456,
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
