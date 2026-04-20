/**
 * Resolves a context clock input into a concrete `Date`.
 */
export function resolveNow(now?: Date | (() => Date)): Date {
  if (typeof now === "function") {
    return now();
  }

  return now ?? new Date();
}
