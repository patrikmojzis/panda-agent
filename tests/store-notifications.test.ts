import {describe, expect, it, vi} from "vitest";

import {listenThreadRuntimeNotifications} from "../src/app/runtime/store-notifications.js";

type NotificationPool = Parameters<typeof listenThreadRuntimeNotifications>[0]["pool"];
type NotificationClient = Awaited<ReturnType<NotificationPool["connect"]>>;

describe("listenThreadRuntimeNotifications", () => {
  it("releases the notification client when LISTEN setup fails", async () => {
    const client: NotificationClient = {
      off: vi.fn(() => client),
      on: vi.fn(() => client),
      query: vi.fn(async () => ({rows: []})),
      release: vi.fn(),
    };
    client.query.mockRejectedValueOnce(new Error("listen blew up"));
    const pool: NotificationPool = {
      connect: vi.fn(async () => client),
    };

    await expect(listenThreadRuntimeNotifications({
      pool,
      listener: () => {},
    })).rejects.toThrow("listen blew up");

    expect(client.off).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
