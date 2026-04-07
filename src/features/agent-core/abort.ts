export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal) {
    return;
  }

  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }

  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted.");
  }
}
