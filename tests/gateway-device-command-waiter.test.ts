import {EventEmitter} from "node:events";

import {describe, expect, it, vi} from "vitest";

import {
  buildGatewayDeviceCommandNotificationChannel,
  parseGatewayDeviceCommandNotification,
} from "../src/domain/gateway/device-command-notifications.js";
import type {PostgresGatewayStore} from "../src/domain/gateway/postgres.js";
import type {
  GatewayDeviceCommandClaimResult,
  GatewayDeviceCommandRecord,
} from "../src/domain/gateway/types.js";
import {
  createGatewayDeviceCommandWaiter,
  GatewayDeviceCommandWaitError,
  startGatewayDeviceCommandWaiter,
} from "../src/integrations/gateway/device-command-waiter.js";
import type {PgListenClient, PgPoolLike} from "../src/lib/postgres-query.js";
import {waitFor} from "./helpers/wait-for.js";

type ClaimStore = Pick<PostgresGatewayStore, "claimNextDeviceCommand">;

function commandRecord(id = "command-1"): GatewayDeviceCommandRecord {
  return {
    id,
    sourceId: "work-prod",
    deviceId: "device-1",
    kind: "screenshot.capture",
    status: "claimed",
    claimId: "claim-1",
    claimedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function claimInput(overrides: {deviceId?: string; waitMs?: number; signal?: AbortSignal} = {}) {
  return {
    sourceId: "work-prod",
    deviceId: overrides.deviceId ?? "device-1",
    allowedKinds: ["screenshot.capture"] as const,
    waitMs: overrides.waitMs ?? 100,
    ...(overrides.signal ? {signal: overrides.signal} : {}),
  };
}

describe("Gateway device command waiter", () => {
  it("claims a command after a matching notification", async () => {
    let queued: GatewayDeviceCommandRecord | undefined;
    const store: ClaimStore = {
      claimNextDeviceCommand: vi.fn(async (): Promise<GatewayDeviceCommandClaimResult> => {
        const command = queued;
        queued = undefined;
        return command ? {claimed: true, command} : {claimed: false};
      }),
    };
    const waiter = createGatewayDeviceCommandWaiter({store});

    const pending = waiter.claimOrWait(claimInput());
    await waitFor(() => {
      expect(store.claimNextDeviceCommand).toHaveBeenCalledTimes(1);
    });
    queued = commandRecord();
    waiter.notify({sourceId: "work-prod", deviceId: "device-1"});

    await expect(pending).resolves.toMatchObject({claimed: true, command: {id: "command-1"}});
    await waiter.close();
  });

  it("does not lose a notification arriving during the initial claim", async () => {
    let waiter: ReturnType<typeof createGatewayDeviceCommandWaiter>;
    let attempts = 0;
    const store: ClaimStore = {
      claimNextDeviceCommand: vi.fn(async (): Promise<GatewayDeviceCommandClaimResult> => {
        attempts += 1;
        if (attempts === 1) {
          waiter.notify({sourceId: "work-prod", deviceId: "device-1"});
          return {claimed: false};
        }
        return {claimed: true, command: commandRecord()};
      }),
    };
    waiter = createGatewayDeviceCommandWaiter({store});

    await expect(waiter.claimOrWait(claimInput())).resolves.toMatchObject({
      claimed: true,
      command: {id: "command-1"},
    });
    await waiter.close();
  });

  it("performs one final claim at timeout instead of polling", async () => {
    const store: ClaimStore = {
      claimNextDeviceCommand: vi.fn(async () => ({claimed: false as const})),
    };
    const waiter = createGatewayDeviceCommandWaiter({store});

    await expect(waiter.claimOrWait(claimInput({waitMs: 10}))).resolves.toEqual({claimed: false});
    expect(store.claimNextDeviceCommand).toHaveBeenCalledTimes(2);
    await waiter.close();
  });

  it("rejects duplicate device waits and releases the slot after abort", async () => {
    const store: ClaimStore = {
      claimNextDeviceCommand: vi.fn(async () => ({claimed: false as const})),
    };
    const waiter = createGatewayDeviceCommandWaiter({store});
    const controller = new AbortController();
    const pending = waiter.claimOrWait(claimInput({signal: controller.signal}));
    await waitFor(() => {
      expect(store.claimNextDeviceCommand).toHaveBeenCalledTimes(1);
    });

    await expect(waiter.claimOrWait(claimInput())).rejects.toMatchObject({
      reason: "duplicate",
    } satisfies Partial<GatewayDeviceCommandWaitError>);
    controller.abort();
    await expect(pending).resolves.toEqual({claimed: false});
    await expect(waiter.claimOrWait(claimInput({waitMs: 0}))).resolves.toEqual({claimed: false});
    await waiter.close();
  });

  it("bounds waits across devices", async () => {
    const store: ClaimStore = {
      claimNextDeviceCommand: vi.fn(async () => ({claimed: false as const})),
    };
    const waiter = createGatewayDeviceCommandWaiter({maxWaiters: 1, store});
    const controller = new AbortController();
    const pending = waiter.claimOrWait(claimInput({signal: controller.signal}));
    await waitFor(() => {
      expect(store.claimNextDeviceCommand).toHaveBeenCalledTimes(1);
    });

    await expect(waiter.claimOrWait(claimInput({deviceId: "device-2"}))).rejects.toMatchObject({
      reason: "overloaded",
    } satisfies Partial<GatewayDeviceCommandWaitError>);
    controller.abort();
    await pending;
    await waiter.close();
  });

  it("routes Postgres notifications through one shared listener", async () => {
    class FakeListenClient extends EventEmitter {
      readonly query = vi.fn(async () => ({rows: []}));
      readonly release = vi.fn();
    }
    const client = new FakeListenClient();
    const connect = vi.fn(async () => client as unknown as PgListenClient);
    const pool: PgPoolLike<PgListenClient> = {
      connect,
      query: vi.fn(async () => ({rows: []})),
    };
    let queued: GatewayDeviceCommandRecord | undefined;
    const store: ClaimStore = {
      claimNextDeviceCommand: vi.fn(async (): Promise<GatewayDeviceCommandClaimResult> => {
        const command = queued;
        queued = undefined;
        return command ? {claimed: true, command} : {claimed: false};
      }),
    };
    const waiter = await startGatewayDeviceCommandWaiter({pool, store});
    const pending = waiter.claimOrWait(claimInput());
    await waitFor(() => {
      expect(store.claimNextDeviceCommand).toHaveBeenCalledTimes(1);
    });
    queued = commandRecord();
    client.emit("notification", {
      channel: buildGatewayDeviceCommandNotificationChannel(),
      payload: JSON.stringify({sourceId: "work-prod", deviceId: "device-1"}),
    });

    await expect(pending).resolves.toMatchObject({claimed: true, command: {id: "command-1"}});
    await waiter.close();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "LISTEN runtime_gateway_device_command_events");
    expect(client.query).toHaveBeenNthCalledWith(2, "UNLISTEN runtime_gateway_device_command_events");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed notification payloads", () => {
    expect(parseGatewayDeviceCommandNotification("not-json")).toBeNull();
    expect(parseGatewayDeviceCommandNotification(JSON.stringify({sourceId: "work-prod"}))).toBeNull();
    expect(parseGatewayDeviceCommandNotification(JSON.stringify({
      sourceId: "work-prod",
      deviceId: "device-1",
    }))).toEqual({sourceId: "work-prod", deviceId: "device-1"});
  });
});
