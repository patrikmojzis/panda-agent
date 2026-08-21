import type {ConnectorAccountRecord} from "../../../domain/connectors/types.js";

export interface WhatsAppRunService {
  run(): Promise<void>;
  stop(): Promise<void>;
}

export interface WhatsAppAccountSupervisorOptions {
  listEnabledAccounts(): Promise<readonly ConnectorAccountRecord[]>;
  createService(account: ConnectorAccountRecord): WhatsAppRunService;
  log(event: string, payload: Record<string, unknown>): void;
  reconcileIntervalMs?: number;
}

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;

export class WhatsAppAccountSupervisor {
  private readonly options: WhatsAppAccountSupervisorOptions;
  private readonly running = new Map<string, {account: ConnectorAccountRecord; service: WhatsAppRunService}>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private stopping = false;

  constructor(options: WhatsAppAccountSupervisorOptions) {
    this.options = options;
  }

  snapshot(): {accountKeys: string[]; connectorCount: number; stopping: boolean} {
    return {
      accountKeys: [...this.running.values()].map(({account}) => account.accountKey).sort(),
      connectorCount: this.running.size,
      stopping: this.stopping,
    };
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopping = false;
    await this.reconcile();
    this.timer = setInterval(() => {
      void this.reconcile().catch((error) => this.options.log("worker_reconcile_failed", {
        message: error instanceof Error ? error.message : String(error),
      }));
    }, this.options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS);
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
      await current.service.stop();
      this.options.log("worker_stopped_disabled_account", {accountKey: current.account.accountKey});
    }

    for (const account of enabled) {
      if (this.stopping || this.running.has(account.id)) continue;
      let service: WhatsAppRunService;
      try {
        service = this.options.createService(account);
      } catch (error) {
        this.options.log("worker_start_failed", {
          accountKey: account.accountKey,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      this.running.set(account.id, {account, service});
      this.options.log("worker_started_reconciled_account", {accountKey: account.accountKey});
      void service.run().catch((error) => {
        if (!this.stopping) this.options.log("worker_run_failed", {
          accountKey: account.accountKey,
          message: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        if (this.running.get(account.id)?.service === service) this.running.delete(account.id);
      });
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.reconcilePromise?.catch(() => undefined);
    const running = [...this.running.values()];
    this.running.clear();
    await Promise.allSettled(running.map(({service}) => service.stop()));
  }
}
