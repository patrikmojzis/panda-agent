import {describe, expect, it, vi} from "vitest";

import {listenThreadRuntimeNotifications} from "../src/app/runtime/store-notifications.js";

describe("listenThreadRuntimeNotifications", () => {
  it("releases the notification client when LISTEN setup fails", async () => {
    const client = {
      off: vi.fn(),
      on: vi.fn(),
      query: vi.fn(async () => ({rows: []})),
      release: vi.fn(),
    };
    client.query.mockRejectedValueOnce(new Error("listen blew up"));

    await expect(listenThreadRuntimeNotifications({
      pool: {
        connect: vi.fn(async () => client as never),
      },
      listener: () => {},
    })).rejects.toThrow("listen blew up");

    expect(client.off).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
