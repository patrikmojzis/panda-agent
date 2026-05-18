import {runInBackground} from "./async.js";

export interface DrainLoopOptions {
  label: string;
  drain(): Promise<void>;
  pollIntervalMs?: number;
  onError?: (error: unknown) => Promise<void> | void;
}

/**
 * Runs one drain at a time and coalesces concurrent wakeups into one follow-up pass.
 */
export class DrainLoop {
  private readonly label: string;
  private readonly drainFn: () => Promise<void>;
  private readonly pollIntervalMs?: number;
  private readonly onError?: (error: unknown) => Promise<void> | void;

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private drainPromise: Promise<void> | null = null;
  private pendingDrain = false;

  constructor(options: DrainLoopOptions) {
    this.label = options.label;
    this.drainFn = options.drain;
    this.pollIntervalMs = options.pollIntervalMs;
    this.onError = options.onError;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.pendingDrain = false;
    if (this.pollIntervalMs !== undefined) {
      this.timer = setInterval(() => {
        this.kick();
      }, this.pollIntervalMs);
    }
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pendingDrain = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.drainPromise) {
      await this.drainPromise;
    }
  }

  async trigger(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.drainPromise) {
      this.pendingDrain = true;
      await this.drainPromise;
      return;
    }

    this.drainPromise = this.runDrainCycle();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
    }
  }

  private async runDrainCycle(): Promise<void> {
    do {
      this.pendingDrain = false;
      await this.drainFn();
    } while (this.pendingDrain && !this.stopped);

    if (this.stopped) {
      this.pendingDrain = false;
    }
  }

  kick(): void {
    runInBackground(() => this.trigger(), {
      label: this.label,
      onError: this.onError,
    });
  }
}
