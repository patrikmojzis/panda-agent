import {afterEach, describe, expect, it, vi} from "vitest";

import type {ConnectorAccountRecord} from "../src/domain/connectors/types.js";
import {
  WhatsAppAccountSupervisor,
  type WhatsAppRunService,
} from "../src/integrations/channels/whatsapp/supervisor.js";

function account(accountKey: string): ConnectorAccountRecord {
  return {
    id: `00000000-0000-4000-8000-${accountKey === "one" ? "000000000001" : "000000000002"}`,
    source: "whatsapp",
    accountKey,
    connectorKey: `00000000-0000-4000-8000-${accountKey === "one" ? "000000000001" : "000000000002"}`,
    status: "enabled",
    ownerKind: "agent",
    ownerAgentKey: "panda",
    ownerIdentityId: null,
    config: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

function service(): WhatsAppRunService & {finish(): void} {
  let finish!: () => void;
  const running = new Promise<void>((resolve) => { finish = resolve; });
  return {
    run: vi.fn(() => running),
    stop: vi.fn(async () => finish()),
    finish,
  };
}

describe("WhatsAppAccountSupervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays started with zero accounts and reconciles newly enabled accounts", async () => {
    vi.useFakeTimers();
    let enabled: ConnectorAccountRecord[] = [];
    const services = new Map<string, ReturnType<typeof service>>();
    const supervisor = new WhatsAppAccountSupervisor({
      listEnabledAccounts: vi.fn(async () => enabled),
      createService: (target) => {
        const created = service();
        services.set(target.accountKey, created);
        return created;
      },
      log: vi.fn(),
      reconcileIntervalMs: 30_000,
    });

    await supervisor.start();
    expect(supervisor.snapshot()).toEqual({accountKeys: [], connectorCount: 0, stopping: false});

    enabled = [account("one"), account("two")];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(supervisor.snapshot()).toEqual({accountKeys: ["one", "two"], connectorCount: 2, stopping: false});
    expect(services.get("one")?.run).toHaveBeenCalledOnce();
    expect(services.get("two")?.run).toHaveBeenCalledOnce();

    enabled = [account("two")];
    await supervisor.reconcile();
    expect(services.get("one")?.stop).toHaveBeenCalledOnce();
    expect(supervisor.snapshot().accountKeys).toEqual(["two"]);

    await supervisor.stop();
    expect(services.get("two")?.stop).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toEqual({accountKeys: [], connectorCount: 0, stopping: true});
  });

  it("does not overlap concurrent reconciliation passes", async () => {
    let release!: () => void;
    const listEnabledAccounts = vi.fn(() => new Promise<ConnectorAccountRecord[]>((resolve) => {
      release = () => resolve([]);
    }));
    const supervisor = new WhatsAppAccountSupervisor({
      listEnabledAccounts,
      createService: () => service(),
      log: vi.fn(),
    });

    const first = supervisor.reconcile();
    const second = supervisor.reconcile();
    expect(listEnabledAccounts).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    await supervisor.stop();
  });
});
