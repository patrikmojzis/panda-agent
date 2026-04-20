import {describe, expect, it, vi} from "vitest";

import {buildActionNotificationChannel} from "../src/domain/channels/actions/index.js";
import {buildDeliveryNotificationChannel} from "../src/domain/channels/deliveries/index.js";
import {startPostgresNotificationListener} from "../src/integrations/channels/postgres-notification-listener.js";

describe("startPostgresNotificationListener", () => {
  it("uses one client for both LISTEN channels and routes parsed notifications", async () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const client = {
      on: vi.fn((event: string, handler: (value: unknown) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event);
      }),
      query: vi.fn(async () => ({rows: []})),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    };
    const onActionNotification = vi.fn();
    const onDeliveryNotification = vi.fn();
    const onError = vi.fn();

    const handle = await startPostgresNotificationListener({
      pool: pool as any,
      onActionNotification,
      onDeliveryNotification,
      onError,
    });

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, `LISTEN ${buildActionNotificationChannel()}`);
    expect(client.query).toHaveBeenNthCalledWith(2, `LISTEN ${buildDeliveryNotificationChannel()}`);

    handlers.get("notification")?.({
      channel: buildActionNotificationChannel(),
      payload: JSON.stringify({
        channel: "telegram",
        connectorKey: "bot-1",
      }),
    });
    handlers.get("notification")?.({
      channel: buildDeliveryNotificationChannel(),
      payload: JSON.stringify({
        channel: "telegram",
        connectorKey: "bot-1",
      }),
    });
    handlers.get("notification")?.({
      channel: buildActionNotificationChannel(),
      payload: "{\"nope\":true}",
    });
    handlers.get("error")?.(new Error("listen died"));

    await Promise.resolve();

    expect(onActionNotification).toHaveBeenCalledWith({
      channel: "telegram",
      connectorKey: "bot-1",
    });
    expect(onDeliveryNotification).toHaveBeenCalledWith({
      channel: "telegram",
      connectorKey: "bot-1",
    });
    expect(onError).toHaveBeenCalledTimes(1);

    await handle.close();

    expect(client.query).toHaveBeenNthCalledWith(3, `UNLISTEN ${buildDeliveryNotificationChannel()}`);
    expect(client.query).toHaveBeenNthCalledWith(4, `UNLISTEN ${buildActionNotificationChannel()}`);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
