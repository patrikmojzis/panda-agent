export interface CleanupStep {
  label: string;
  run(): Promise<void> | void;
}

export interface RunCleanupStepsOptions {
  rethrow?: boolean;
}

// Shutdown should keep moving even when one cleanup step fails.
export async function runCleanupSteps(
  steps: readonly CleanupStep[],
  onError?: (step: CleanupStep, error: unknown) => Promise<void> | void,
  options: RunCleanupStepsOptions = {},
): Promise<void> {
  let firstError: unknown = null;

  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      firstError ??= error;
      await onError?.(step, error);
    }
  }

  if (firstError && options.rethrow) {
    throw firstError;
  }
}
