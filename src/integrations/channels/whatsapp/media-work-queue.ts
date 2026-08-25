export type WhatsAppMediaPolicyReason =
  | "media_aborted"
  | "media_invalid"
  | "media_queue_full"
  | "media_timeout"
  | "media_too_large";

export class WhatsAppMediaPolicyError extends Error {
  readonly reason: WhatsAppMediaPolicyReason;

  constructor(reason: WhatsAppMediaPolicyReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WhatsAppMediaPolicyError";
    this.reason = reason;
  }
}

interface QueuedMediaWork<T> {
  task(signal: AbortSignal): Promise<T>;
  signal?: AbortSignal;
  resolve(value: T): void;
  reject(error: unknown): void;
  onAbort?: () => void;
}

/** One bounded FIFO shared by every WhatsApp account in a daemon. */
export class WhatsAppMediaWorkQueue {
  private readonly concurrency: number;
  private readonly queueMax: number;
  private readonly closeController = new AbortController();
  private readonly queued: Array<QueuedMediaWork<unknown>> = [];
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly singleFlight = new Map<string, Promise<unknown>>();
  private active = 0;
  private rejected = 0;
  private closed = false;

  constructor(options: {concurrency: number; queueMax: number}) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
      throw new Error("WhatsApp media concurrency must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(options.queueMax) || options.queueMax <= 0) {
      throw new Error("WhatsApp media queue max must be a positive safe integer.");
    }
    this.concurrency = options.concurrency;
    this.queueMax = options.queueMax;
  }

  snapshot(): {active: number; queued: number; rejected: number} {
    return {active: this.active, queued: this.queued.length, rejected: this.rejected};
  }

  run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options: {signal?: AbortSignal; singleFlightKey?: string} = {},
  ): Promise<T> {
    const singleFlightKey = options.singleFlightKey?.trim();
    const existing = singleFlightKey ? this.singleFlight.get(singleFlightKey) : undefined;
    if (existing) return existing as Promise<T>;
    if (this.closed || options.signal?.aborted) {
      return Promise.reject(new WhatsAppMediaPolicyError(
        "media_aborted",
        "WhatsApp media work was aborted before admission.",
      ));
    }
    if (this.active >= this.concurrency && this.queued.length >= this.queueMax) {
      this.rejected += 1;
      return Promise.reject(new WhatsAppMediaPolicyError(
        "media_queue_full",
        "WhatsApp media queue is full.",
      ));
    }

    const promise = new Promise<T>((resolve, reject) => {
      const work: QueuedMediaWork<T> = {task, signal: options.signal, resolve, reject};
      if (options.signal) {
        work.onAbort = () => {
          const index = this.queued.indexOf(work as QueuedMediaWork<unknown>);
          if (index < 0) return;
          this.queued.splice(index, 1);
          reject(new WhatsAppMediaPolicyError(
            "media_aborted",
            "WhatsApp media work was aborted while queued.",
          ));
        };
        options.signal.addEventListener("abort", work.onAbort, {once: true});
      }
      this.queued.push(work as QueuedMediaWork<unknown>);
      this.drain();
    });
    if (singleFlightKey) {
      this.singleFlight.set(singleFlightKey, promise);
      void promise.then(
        () => this.singleFlight.delete(singleFlightKey),
        () => this.singleFlight.delete(singleFlightKey),
      );
    }
    return promise;
  }

  private drain(): void {
    while (!this.closed && this.active < this.concurrency && this.queued.length > 0) {
      const work = this.queued.shift()!;
      if (work.onAbort && work.signal) work.signal.removeEventListener("abort", work.onAbort);
      this.active += 1;
      const signal = work.signal
        ? AbortSignal.any([work.signal, this.closeController.signal])
        : this.closeController.signal;
      const activeTask = (async () => {
        try {
          work.resolve(await work.task(signal));
        } catch (error) {
          work.reject(error);
        } finally {
          this.active -= 1;
        }
      })();
      this.activeTasks.add(activeTask);
      void activeTask.finally(() => {
        this.activeTasks.delete(activeTask);
        this.drain();
      });
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.closeController.abort(new WhatsAppMediaPolicyError(
        "media_aborted",
        "WhatsApp media queue closed.",
      ));
      for (const work of this.queued.splice(0)) {
        if (work.onAbort && work.signal) work.signal.removeEventListener("abort", work.onAbort);
        work.reject(new WhatsAppMediaPolicyError("media_aborted", "WhatsApp media queue closed."));
      }
    }
    await Promise.allSettled([...this.activeTasks]);
  }
}
