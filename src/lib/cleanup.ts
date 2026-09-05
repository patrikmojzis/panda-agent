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
  let failure: {kind: "cleanup" | "reporter"; error: unknown} | undefined;

  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failure ??= {kind: "cleanup", error};
      try {
        await onError?.(step, error);
      } catch (reporterError) {
        if (failure.kind !== "reporter") {
          failure = {kind: "reporter", error: reporterError};
        }
      }
    }
  }

  if (failure && (failure.kind === "reporter" || options.rethrow)) {
    throw failure.error;
  }
}
