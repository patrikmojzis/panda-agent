const DEFAULT_RUNTIME_REQUEST_RETRY_AFTER_MS = 1_000;

const RETRYABLE_SYSTEM_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EBUSY",
  "EIO",
  "EMFILE",
  "ENFILE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ENOSPC",
  "EPIPE",
  "ETIMEDOUT",
]);

function retryableErrorCode(code: unknown): boolean {
  if (typeof code !== "string") return false;
  const normalized = code.toUpperCase();
  return RETRYABLE_SYSTEM_ERROR_CODES.has(normalized)
    // PostgreSQL connection, transaction rollback, resource exhaustion, lock
    // unavailable, and operator-shutdown classes are transient by contract.
    || normalized.startsWith("08")
    || normalized.startsWith("40")
    || normalized.startsWith("53")
    || normalized === "55P03"
    || normalized === "57P01"
    || normalized === "57P02"
    || normalized === "57P03";
}

/** Distinguishes infrastructure loss from deterministic request rejection. */
export function isRetryableRuntimeInfrastructureError(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === "object") {
      const candidate = current as {code?: unknown; cause?: unknown; message?: unknown};
      if (retryableErrorCode(candidate.code)) return true;
      if (
        typeof candidate.message === "string"
        && /(?:connection (?:closed|terminated)|client has already been closed|socket hang up|read ECONNRESET)/i
          .test(candidate.message)
      ) {
        return true;
      }
      current = candidate.cause;
      continue;
    }
    break;
  }
  return false;
}

/** Signals that an idempotent request effect is ambiguous and must be replayed. */
export class RetryableRuntimeRequestError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, options: {cause?: unknown; retryAfterMs?: number} = {}) {
    super(message, {cause: options.cause});
    this.name = "RetryableRuntimeRequestError";
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RUNTIME_REQUEST_RETRY_AFTER_MS;
    if (!Number.isSafeInteger(this.retryAfterMs) || this.retryAfterMs <= 0) {
      throw new Error("Runtime request retry delay must be a positive integer.");
    }
  }
}
