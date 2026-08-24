import {EventEmitter} from "node:events";

import {afterEach, describe, expect, it, vi} from "vitest";

import {startConnectorDaemonRuntime} from "../src/integrations/channels/worker-runtime.js";
import {waitFor} from "./helpers/wait-for.js";

class FakeClient extends EventEmitter {
  readonly query = vi.fn(async () => ({rows: []}));
  readonly release = vi.fn();
}

function target() {
  return {triggerDrain: vi.fn(async () => {})};
}

describe("connector daemon runtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("owns one pool and listener while routing all account notifications and reconnect drains", async () => {
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    let connection = 0;
    const cleanupOrder: string[] = [];
    const connect = vi.fn(async () => connection++ === 0 ? firstClient : secondClient);
    const end = vi.fn(async () => { cleanupOrder.push("pool"); });
    const pool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      connect,
      query: vi.fn(async () => ({rows: []})),
      on: vi.fn(function (this: unknown) { return this; }),
      off: vi.fn(function (this: unknown) {
        cleanupOrder.push("observer");
        return this;
      }),
      end,
    };
    const createPool = vi.fn(() => pool);
    const initialize = vi.fn(async () => {});
    const runtime = await startConnectorDaemonRuntime({
      source: "discord",
      dbUrl: "postgres://connector-test",
      poolMaxEnvKey: "PANDA_DISCORD_DB_POOL_MAX",
      reconnectDelayMs: 1,
      initialize,
      log: vi.fn(),
      additionalNotifications: [{
        key: "voice",
        channel: "runtime_discord_voice_events",
        label: "voice",
        parse: (payload) => payload ? JSON.parse(payload) as unknown : null,
        connectorKey: (notification) => {
          const value = (notification as {connectorKey?: unknown}).connectorKey;
          return typeof value === "string" ? value : null;
        },
      }],
      dependencies: {createPool: createPool as never},
    });

    expect(initialize).toHaveBeenCalledOnce();
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      applicationName: "panda/discord",
      max: 2,
    }));
    expect(connect).toHaveBeenCalledOnce();

    const one = {actionWorker: target(), outboundWorker: target(), voice: target()};
    const two = {actionWorker: target(), outboundWorker: target(), voice: target()};
    const oneRegistration = runtime.notifications.register({
      connectorKey: "one",
      actionWorker: one.actionWorker,
      outboundWorker: one.outboundWorker,
      additionalTargets: {voice: one.voice},
    });
    runtime.notifications.register({
      connectorKey: "two",
      actionWorker: two.actionWorker,
      outboundWorker: two.outboundWorker,
      additionalTargets: {voice: two.voice},
    });
    expect(() => runtime.notifications.register({
      connectorKey: "two",
      actionWorker: target(),
      outboundWorker: target(),
    })).toThrow("already registered");

    firstClient.emit("notification", {
      channel: "runtime_channel_action_events",
      payload: JSON.stringify({channel: "discord", connectorKey: "one"}),
    });
    firstClient.emit("notification", {
      channel: "runtime_outbound_delivery_events",
      payload: JSON.stringify({channel: "telegram", connectorKey: "two"}),
    });
    firstClient.emit("notification", {
      channel: "runtime_outbound_delivery_events",
      payload: JSON.stringify({channel: "discord", connectorKey: "two"}),
    });
    firstClient.emit("notification", {
      channel: "runtime_discord_voice_events",
      payload: JSON.stringify({connectorKey: "two"}),
    });
    await waitFor(() => {
      expect(one.actionWorker.triggerDrain).toHaveBeenCalledTimes(2);
      expect(two.outboundWorker.triggerDrain).toHaveBeenCalledTimes(2);
      expect(two.voice.triggerDrain).toHaveBeenCalledTimes(2);
    });

    oneRegistration.unregister();
    const replacement = {actionWorker: target(), outboundWorker: target()};
    runtime.notifications.register({connectorKey: "one", ...replacement});
    oneRegistration.unregister();
    firstClient.emit("notification", {
      channel: "runtime_channel_action_events",
      payload: JSON.stringify({channel: "discord", connectorKey: "one"}),
    });
    await waitFor(() => expect(replacement.actionWorker.triggerDrain).toHaveBeenCalledTimes(2));

    firstClient.emit("error", new Error("listener lost"));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(replacement.actionWorker.triggerDrain).toHaveBeenCalledTimes(3);
      expect(two.actionWorker.triggerDrain).toHaveBeenCalledTimes(2);
    });

    await runtime.close();
    await runtime.close();
    expect(end).toHaveBeenCalledOnce();
    expect(secondClient.release).toHaveBeenCalledOnce();
    expect(cleanupOrder.at(-1)).toBe("pool");
  });

  it("fails fast when a daemon pool cannot reserve a query connection beside LISTEN", async () => {
    for (const value of ["-1", "0", "1"]) {
      vi.stubEnv("PANDA_TELEGRAM_DB_POOL_MAX", value);
      await expect(startConnectorDaemonRuntime({
        source: "telegram",
        dbUrl: "postgres://connector-test",
        poolMaxEnvKey: "PANDA_TELEGRAM_DB_POOL_MAX",
        initialize: vi.fn(),
        log: vi.fn(),
      })).rejects.toThrow("must be at least 2");
    }
  });

  it("honors the per-daemon pool override", async () => {
    vi.stubEnv("PANDA_WHATSAPP_DB_POOL_MAX", "7");
    const end = vi.fn(async () => {});
    const pool = {end};
    const createPool = vi.fn(() => pool);
    const closeListener = vi.fn(async () => {});
    const runtime = await startConnectorDaemonRuntime({
      source: "whatsapp",
      dbUrl: "postgres://connector-test",
      poolMaxEnvKey: "PANDA_WHATSAPP_DB_POOL_MAX",
      initialize: vi.fn(async () => {}),
      log: vi.fn(),
      dependencies: {
        createPool: createPool as never,
        observePool: () => ({stop: vi.fn()}),
        startNotificationListener: vi.fn(async () => ({
          close: closeListener,
          getSnapshot: () => ({status: "listening", listening: true}),
        })) as never,
      },
    });

    expect(runtime.poolConfig.max).toBe(7);
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({max: 7}));
    await runtime.close();
    expect(closeListener).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("closes the observer and pool when listener startup fails", async () => {
    const stopObserver = vi.fn();
    const end = vi.fn(async () => {});

    await expect(startConnectorDaemonRuntime({
      source: "telegram",
      dbUrl: "postgres://connector-test",
      poolMaxEnvKey: "PANDA_TELEGRAM_DB_POOL_MAX",
      initialize: vi.fn(async () => {}),
      log: vi.fn(),
      dependencies: {
        createPool: vi.fn(() => ({end})) as never,
        observePool: () => ({stop: stopObserver}),
        startNotificationListener: vi.fn(async () => {
          throw new Error("listen startup failed");
        }) as never,
      },
    })).rejects.toThrow("listen startup failed");

    expect(stopObserver).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("closes the pool when observation setup fails", async () => {
    const end = vi.fn(async () => {});

    await expect(startConnectorDaemonRuntime({
      source: "discord",
      dbUrl: "postgres://connector-test",
      poolMaxEnvKey: "PANDA_DISCORD_DB_POOL_MAX",
      initialize: vi.fn(async () => {}),
      log: vi.fn(),
      dependencies: {
        createPool: vi.fn(() => ({end})) as never,
        observePool: () => {
          throw new Error("observer startup failed");
        },
      },
    })).rejects.toThrow("observer startup failed");

    expect(end).toHaveBeenCalledOnce();
  });
});
