import {describe, expect, it, vi} from "vitest";

import {listenThreadRuntimeNotifications} from "../src/app/runtime/store-notifications.js";
import {parseThreadRuntimeNotification} from "../src/domain/threads/runtime/postgres-notifications.js";
import {waitFor} from "./helpers/wait-for.js";

type NotificationPool = Parameters<typeof listenThreadRuntimeNotifications>[0]["pool"];
type NotificationClient = Awaited<ReturnType<NotificationPool["connect"]>>;

describe("listenThreadRuntimeNotifications", () => {
  it("accepts only typed thread-change, runnable, and run-abort notifications", () => {
    expect(parseThreadRuntimeNotification(JSON.stringify({
      kind: "thread_changed",
      threadId: "thread-1",
    }))).toEqual({
      kind: "thread_changed",
      threadId: "thread-1",
    });
    expect(parseThreadRuntimeNotification(JSON.stringify({
      kind: "run_abort_requested",
      threadId: "thread-1",
      runId: "9dcb03d2-b59b-42f4-9988-a92a2d5f50f0",
    }))).toEqual({
      kind: "run_abort_requested",
      threadId: "thread-1",
      runId: "9dcb03d2-b59b-42f4-9988-a92a2d5f50f0",
    });
    expect(parseThreadRuntimeNotification(JSON.stringify({
      kind: "thread_runnable",
      threadId: "thread-1",
    }))).toEqual({
      kind: "thread_runnable",
      threadId: "thread-1",
    });

    expect(parseThreadRuntimeNotification(JSON.stringify({threadId: "legacy"}))).toBeNull();
    expect(parseThreadRuntimeNotification(JSON.stringify({
      kind: "thread_changed",
      threadId: "  ",
    }))).toBeNull();
    expect(parseThreadRuntimeNotification(JSON.stringify({
      kind: "run_abort_requested",
      threadId: "thread-1",
      runId: "not-a-uuid",
    }))).toBeNull();
  });

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

    expect(client.off).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("forwards listener health for coordinator reconciliation", async () => {
    const client: NotificationClient = {
      off: vi.fn(() => client),
      on: vi.fn(() => client),
      query: vi.fn(async () => ({rows: []})),
      release: vi.fn(),
    };
    const pool: NotificationPool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({rows: []})),
    };
    const onStateChange = vi.fn();

    const close = await listenThreadRuntimeNotifications({
      pool,
      listener: () => {},
      onStateChange,
    });

    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({
        status: "listening",
        listening: true,
      }));
    });
    await close();
    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({
        status: "closed",
        listening: false,
      }));
    });
  });
});
