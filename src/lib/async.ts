/**
 * Resolves after `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves after `ms`, or rejects immediately when the caller aborts. */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Operation aborted."));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Operation aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, {once: true});
  });
}

/**
 * Resolves `promise`, or returns `fallback` when `timeoutMs` elapses first.
 */
export function withFallbackTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: () => T,
): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.resolve(fallback());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(fallback());
    }, timeoutMs);
    timer.unref?.();

    promise.then((value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

export interface BackgroundTaskOptions {
  label: string;
  onError?: (error: unknown) => Promise<void> | void;
}

/**
 * Starts fire-and-forget work without letting rejected promises go dark.
 */
export function runInBackground(task: () => Promise<void>, options: BackgroundTaskOptions): void {
  void task().catch((error) => {
    void reportBackgroundError(error, options);
  });
}

async function reportBackgroundError(error: unknown, options: BackgroundTaskOptions): Promise<void> {
  try {
    if (options.onError) {
      await options.onError(error);
      return;
    }
  } catch (handlerError) {
    console.error(`${options.label} error handler failed`, {
      error: handlerError instanceof Error ? handlerError.message : String(handlerError),
      originalError: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  console.error(`${options.label} failed`, {
    error: error instanceof Error ? error.message : String(error),
  });
}
