/**
 * Resolves after `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
