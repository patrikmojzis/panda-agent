import {afterEach, describe, expect, it, vi} from "vitest";

import {
  ConnectorAccountSupervisor,
  type ConnectorAccountSupervisorWorker,
} from "../src/integrations/channels/account-supervisor.js";

interface Account {
  accountKey: string;
  id: string;
}

function account(accountKey: string): Account {
  return {id: accountKey, accountKey};
}

function worker(): ConnectorAccountSupervisorWorker & {finish(): void; fail(error?: Error): void} {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const running = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return {
    run: vi.fn(() => running),
    stop: vi.fn(async () => finish()),
    finish,
    fail: (error = new Error("worker failed")) => fail(error),
  };
}

describe("ConnectorAccountSupervisor", () => {
  afterEach(() => vi.useRealTimers());

  it("stays alive with zero accounts and reconciles enable and disable changes", async () => {
    vi.useFakeTimers();
    let enabled: Account[] = [];
    const workers = new Map<string, ReturnType<typeof worker>>();
    const supervisor = new ConnectorAccountSupervisor({
      listEnabledAccounts: vi.fn(async () => enabled),
      createWorker: (target) => {
        const created = worker();
        workers.set(target.id, created);
        return created;
      },
      log: vi.fn(),
    });

    await supervisor.start();
    expect(supervisor.snapshot()).toEqual({accountKeys: [], connectorCount: 0, stopping: false});

    enabled = [account("one"), account("two")];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(supervisor.snapshot().accountKeys).toEqual(["one", "two"]);

    enabled = [account("two")];
    await supervisor.reconcile();
    expect(workers.get("one")?.stop).toHaveBeenCalledOnce();
    expect(supervisor.snapshot().accountKeys).toEqual(["two"]);

    await supervisor.stop();
    expect(workers.get("two")?.stop).toHaveBeenCalledOnce();
  });

  it("removes a finished worker and restarts it with bounded backoff", async () => {
    vi.useFakeTimers();
    const created: ReturnType<typeof worker>[] = [];
    const log = vi.fn();
    const supervisor = new ConnectorAccountSupervisor({
      listEnabledAccounts: vi.fn(async () => [account("one")]),
      createWorker: () => {
        const next = worker();
        created.push(next);
        return next;
      },
      log,
    });

    await supervisor.start();
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      created.at(-1)!.fail();
      await vi.advanceTimersByTimeAsync(0);
      expect(supervisor.snapshot().connectorCount).toBe(0);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(created).toHaveLength(log.mock.calls.filter(([event]) => event === "worker_started_reconciled_account").length);
      await vi.advanceTimersByTimeAsync(1);
      expect(supervisor.snapshot().connectorCount).toBe(1);
    }

    expect(log.mock.calls.filter(([event]) => event === "worker_restart_scheduled").map(([, payload]) => payload.delayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
    await supervisor.stop();
  });

  it("resets restart backoff after five minutes of stable runtime", async () => {
    vi.useFakeTimers();
    const created: ReturnType<typeof worker>[] = [];
    const log = vi.fn();
    const supervisor = new ConnectorAccountSupervisor({
      listEnabledAccounts: vi.fn(async () => [account("one")]),
      createWorker: () => {
        const next = worker();
        created.push(next);
        return next;
      },
      log,
    });

    await supervisor.start();
    created[0]!.fail();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    created[1]!.fail();
    await vi.runAllTicks();

    const schedules = log.mock.calls.filter(([event]) => event === "worker_restart_scheduled");
    expect(schedules.at(-1)?.[1]).toMatchObject({delayMs: 30_000, failures: 1});
    await supervisor.stop();
  });

  it("isolates failures, clears disabled retry state, and coalesces reconciliation", async () => {
    vi.useFakeTimers();
    let enabled = [account("one"), account("two")];
    const workers = new Map<string, ReturnType<typeof worker>>();
    let releaseList: (() => void) | null = null;
    const listEnabledAccounts = vi.fn(async () => {
      if (releaseList) await new Promise<void>((resolve) => { releaseList = resolve; });
      return enabled;
    });
    const supervisor = new ConnectorAccountSupervisor({
      listEnabledAccounts,
      createWorker: (target) => {
        const created = worker();
        workers.set(target.id, created);
        return created;
      },
      log: vi.fn(),
    });

    await supervisor.start();
    workers.get("one")!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.snapshot().accountKeys).toEqual(["two"]);

    enabled = [account("two")];
    await supervisor.reconcile();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(supervisor.snapshot().accountKeys).toEqual(["two"]);

    releaseList = () => undefined;
    const callsBefore = listEnabledAccounts.mock.calls.length;
    const first = supervisor.reconcile();
    const second = supervisor.reconcile();
    expect(listEnabledAccounts).toHaveBeenCalledTimes(callsBefore + 1);
    releaseList();
    await Promise.all([first, second]);
    await supervisor.stop();
  });

  it("continues reconciliation when one disabled worker fails to stop", async () => {
    const enabled = [account("broken"), account("healthy")];
    const log = vi.fn();
    const workers = new Map<string, ReturnType<typeof worker>>();
    const supervisor = new ConnectorAccountSupervisor({
      listEnabledAccounts: vi.fn(async () => enabled.splice(0)),
      createWorker: (target) => {
        const created = worker();
        if (target.id === "broken") {
          created.stop = vi.fn(async () => {
            created.finish();
            throw new Error("stop failed");
          });
        }
        workers.set(target.id, created);
        return created;
      },
      log,
    });

    await supervisor.start();
    expect(supervisor.snapshot().connectorCount).toBe(2);
    await supervisor.reconcile();

    expect(workers.get("broken")?.stop).toHaveBeenCalledOnce();
    expect(workers.get("healthy")?.stop).toHaveBeenCalledOnce();
    expect(supervisor.snapshot().connectorCount).toBe(0);
    expect(log).toHaveBeenCalledWith("worker_stop_failed", {
      accountKey: "broken",
      message: "stop failed",
    });
    await supervisor.stop();
  });

  it("coalesces concurrent startup into one reconciliation interval", async () => {
    vi.useFakeTimers();
    let releaseList!: () => void;
    const listEnabledAccounts = vi.fn(() => {
      if (listEnabledAccounts.mock.calls.length > 1) return Promise.resolve([]);
      return new Promise<readonly Account[]>((resolve) => {
        releaseList = () => resolve([]);
      });
    });
    const supervisor = new ConnectorAccountSupervisor({
      listEnabledAccounts,
      createWorker: () => worker(),
      log: vi.fn(),
    });

    const first = supervisor.start();
    const second = supervisor.start();
    expect(listEnabledAccounts).toHaveBeenCalledOnce();
    releaseList();
    await Promise.all([first, second]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(listEnabledAccounts).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("makes concurrent shutdown await the same in-flight startup cleanup", async () => {
    let releaseCreate!: () => void;
    const created = worker();
    const createWorker = vi.fn(() => new Promise<ReturnType<typeof worker>>((resolve) => {
      releaseCreate = () => resolve(created);
    }));
    const supervisor = new ConnectorAccountSupervisor({
      listEnabledAccounts: vi.fn(async () => [account("one")]),
      createWorker,
      log: vi.fn(),
    });

    const starting = supervisor.start();
    while (!createWorker.mock.calls.length) await Promise.resolve();
    let firstStopped = false;
    let secondStopped = false;
    const firstStop = supervisor.stop().then(() => { firstStopped = true; });
    const secondStop = supervisor.stop().then(() => { secondStopped = true; });
    await Promise.resolve();
    expect(firstStopped).toBe(false);
    expect(secondStopped).toBe(false);

    releaseCreate();
    await Promise.all([starting, firstStop, secondStop]);
    expect(created.stop).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toEqual({accountKeys: [], connectorCount: 0, stopping: true});
  });
});
