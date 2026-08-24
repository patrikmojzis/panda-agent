export interface ConnectorAccountSupervisorAccount {
  accountKey: string;
  id: string;
}

export interface ConnectorAccountSupervisorWorker {
  run(): Promise<void>;
  stop(): Promise<void>;
}

interface RunningAccount<TAccount, TWorker> {
  account: TAccount;
  startedAt: number;
  worker: TWorker;
}

interface RetryState {
  failures: number;
  notBefore: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ConnectorAccountSupervisorOptions<
  TAccount extends ConnectorAccountSupervisorAccount,
  TWorker extends ConnectorAccountSupervisorWorker,
> {
  createWorker(account: TAccount): Promise<TWorker> | TWorker;
  listEnabledAccounts(): Promise<readonly TAccount[]>;
  log(event: string, payload: Record<string, unknown>): void;
  now?: () => number;
  reconcileIntervalMs?: number;
  restartBackoffMs?: readonly number[];
  stableRuntimeMs?: number;
}

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_RESTART_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;
const DEFAULT_STABLE_RUNTIME_MS = 5 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reconciles enabled connector accounts without owning channel-specific resources. */
export class ConnectorAccountSupervisor<
  TAccount extends ConnectorAccountSupervisorAccount,
  TWorker extends ConnectorAccountSupervisorWorker,
> {
  private readonly options: ConnectorAccountSupervisorOptions<TAccount, TWorker>;
  private readonly running = new Map<string, RunningAccount<TAccount, TWorker>>();
  private readonly retries = new Map<string, RetryState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(options: ConnectorAccountSupervisorOptions<TAccount, TWorker>) {
    this.options = options;
  }

  snapshot(): {accountKeys: string[]; connectorCount: number; stopping: boolean} {
    return {
      accountKeys: [...this.running.values()].map(({account}) => account.accountKey).sort(),
      connectorCount: this.running.size,
      stopping: this.stopping,
    };
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.timer || this.stopping) return this.stopPromise ?? Promise.resolve();

    this.startPromise = (async () => {
      try {
        await this.reconcile();
        if (this.stopping || this.timer) return;
        this.timer = setInterval(() => {
          void this.reconcile().catch((error) => this.options.log("worker_reconcile_failed", {
            message: errorMessage(error),
          }));
        }, this.options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS);
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  async reconcile(): Promise<void> {
    if (this.stopping) return;
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileNow().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  private async reconcileNow(): Promise<void> {
    const enabled = await this.options.listEnabledAccounts();
    if (this.stopping) return;
    const enabledById = new Map(enabled.map((account) => [account.id, account]));

    for (const [accountId, current] of [...this.running]) {
      if (enabledById.has(accountId)) continue;
      this.running.delete(accountId);
      this.clearRetry(accountId);
      if (await this.stopWorker(current.account, current.worker)) {
        this.options.log("worker_stopped_disabled_account", {accountKey: current.account.accountKey});
      }
    }

    for (const accountId of [...this.retries.keys()]) {
      if (!enabledById.has(accountId)) this.clearRetry(accountId);
    }

    const now = this.now();
    for (const account of enabled) {
      if (this.stopping || this.running.has(account.id)) continue;
      const retry = this.retries.get(account.id);
      if (retry && retry.notBefore > now) continue;
      if (retry?.timer) {
        clearTimeout(retry.timer);
        retry.timer = null;
      }
      await this.startAccount(account);
    }
  }

  private async startAccount(account: TAccount): Promise<void> {
    let worker: TWorker;
    try {
      worker = await this.options.createWorker(account);
    } catch (error) {
      this.options.log("worker_start_failed", {
        accountKey: account.accountKey,
        message: errorMessage(error),
      });
      this.scheduleRetry(account);
      return;
    }

    if (this.stopping) {
      await this.stopWorker(account, worker);
      return;
    }

    const current: RunningAccount<TAccount, TWorker> = {
      account,
      worker,
      startedAt: this.now(),
    };
    this.running.set(account.id, current);
    this.options.log("worker_started_reconciled_account", {accountKey: account.accountKey});
    void Promise.resolve().then(() => worker.run()).catch((error) => {
      if (!this.stopping) this.options.log("worker_run_failed", {
        accountKey: account.accountKey,
        message: errorMessage(error),
      });
    }).finally(() => {
      if (this.running.get(account.id) !== current) return;
      this.running.delete(account.id);
      if (!this.stopping) this.scheduleRetry(account, this.now() - current.startedAt);
    });
  }

  private scheduleRetry(account: TAccount, runtimeMs = 0): void {
    if (this.stopping) return;
    const backoff = this.options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    if (backoff.length === 0) return;
    const stableRuntimeMs = this.options.stableRuntimeMs ?? DEFAULT_STABLE_RUNTIME_MS;
    const previousFailures = runtimeMs >= stableRuntimeMs ? 0 : (this.retries.get(account.id)?.failures ?? 0);
    const failures = previousFailures + 1;
    const delayMs = backoff[Math.min(failures - 1, backoff.length - 1)]!;
    this.clearRetryTimer(account.id);
    const retry: RetryState = {
      failures,
      notBefore: this.now() + delayMs,
      timer: null,
    };
    retry.timer = setTimeout(() => {
      retry.timer = null;
      void this.reconcile().catch((error) => this.options.log("worker_reconcile_failed", {
        message: errorMessage(error),
      }));
    }, delayMs);
    this.retries.set(account.id, retry);
    this.options.log("worker_restart_scheduled", {
      accountKey: account.accountKey,
      delayMs,
      failures,
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async stopWorker(account: TAccount, worker: TWorker): Promise<boolean> {
    try {
      await worker.stop();
      return true;
    } catch (error) {
      this.options.log("worker_stop_failed", {
        accountKey: account.accountKey,
        message: errorMessage(error),
      });
      return false;
    }
  }

  private clearRetryTimer(accountId: string): void {
    const retry = this.retries.get(accountId);
    if (retry?.timer) clearTimeout(retry.timer);
  }

  private clearRetry(accountId: string): void {
    this.clearRetryTimer(accountId);
    this.retries.delete(accountId);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    this.stopping = true;
    this.stopPromise = (async () => {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      for (const accountId of [...this.retries.keys()]) this.clearRetry(accountId);
      const pendingReconcile = this.reconcilePromise;
      const running = [...this.running.values()];
      this.running.clear();
      await Promise.all(running.map(({account, worker}) => this.stopWorker(account, worker)));
      await pendingReconcile?.catch(() => undefined);
    })();
    return this.stopPromise;
  }
}
