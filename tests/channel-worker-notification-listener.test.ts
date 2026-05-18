import {describe, expect, it, vi} from "vitest";

import {buildActionNotificationChannel} from "../src/domain/channels/actions/index.js";
import {buildDeliveryNotificationChannel} from "../src/domain/channels/deliveries/index.js";
import {
  startChannelWorkerNotificationListener,
  startPostgresNotificationListener,
} from "../src/integrations/channels/postgres-notification-listener.js";

type NotificationPool = Parameters<typeof startPostgresNotificationListener>[0]["pool"];
type NotificationClient = Awaited<ReturnType<NotificationPool["connect"]>>;

class FakeNotificationClient implements NotificationClient {
  readonly query: NotificationClient["query"];
  readonly release = vi.fn();

  constructor(
    private readonly handlers = new Map<string, (value: unknown) => void>(),
    query: NotificationClient["query"] = async () => ({rows: []}),
  ) {
    this.query = vi.fn(query);
  }

  on(event: "error" | "notification", handler: (value: unknown) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  off(event: "error" | "notification", _handler: (value: unknown) => void): this {
    this.handlers.delete(event);
    return this;
  }
}

describe("startPostgresNotificationListener", () => {
  it("uses one client for both LISTEN channels and routes parsed notifications", async () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const client = new FakeNotificationClient(handlers);
    const pool: NotificationPool = {
      connect: vi.fn(async () => client),
    };
    const onActionNotification = vi.fn();
    const onDeliveryNotification = vi.fn();
    const onError = vi.fn();

    const handle = await startPostgresNotificationListener({
      pool,
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

  it("still releases the LISTEN client when UNLISTEN fails during shutdown", async () => {
    const client = new FakeNotificationClient(new Map(), async (sql: string) => {
      if (sql.startsWith("UNLISTEN")) {
        throw new Error("socket already dead");
      }

      return {rows: []};
    });
    const pool: NotificationPool = {
      connect: vi.fn(async () => client),
    };
    const onError = vi.fn();

    const handle = await startPostgresNotificationListener({
      pool,
      onError,
    });

    await handle.close();

    expect(onError).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("triggers only the matching connector workers", async () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const client = new FakeNotificationClient(handlers);
    const pool: NotificationPool = {
      connect: vi.fn(async () => client),
    };
    const actionWorker = {triggerDrain: vi.fn(async () => {})};
    const outboundWorker = {triggerDrain: vi.fn(async () => {})};

    const handle = await startChannelWorkerNotificationListener({
      pool,
      source: "telegram",
      connectorKey: "bot-1",
      actionWorker,
      outboundWorker,
    });

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
        channel: "whatsapp",
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

    await Promise.resolve();

    expect(actionWorker.triggerDrain).toHaveBeenCalledTimes(1);
    expect(outboundWorker.triggerDrain).toHaveBeenCalledTimes(1);

    await handle.close();
  });
});
