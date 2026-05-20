export const THREAD_RUNTIME_JSONB_NUL_PLACEHOLDER = "␀";

export interface ThreadRuntimeJsonbSerialization {
  json: string | null;
  nulCount: number;
}

export interface ThreadRuntimeJsonbDiagnosticField {
  name: string;
  nulCount: number;
}

export interface ThreadRuntimeJsonbPersistenceBoundary {
  operation: string;
  table: string;
  fields: readonly ThreadRuntimeJsonbDiagnosticField[];
}

interface SanitizedJsonbValue {
  value: unknown;
  nulCount: number;
}

function replaceNul(value: string): {
  value: string;
  nulCount: number;
} {
  if (!value.includes("\0")) {
    return {
      value,
      nulCount: 0,
    };
  }

  let nulCount = 0;
  const replaced = value.replaceAll("\0", () => {
    nulCount += 1;
    return THREAD_RUNTIME_JSONB_NUL_PLACEHOLDER;
  });

  return {
    value: replaced,
    nulCount,
  };
}

function sanitizeParsedJsonbValue(value: unknown): SanitizedJsonbValue {
  if (typeof value === "string") {
    return replaceNul(value);
  }

  if (Array.isArray(value)) {
    let nulCount = 0;
    const sanitized = value.map((entry) => {
      const result = sanitizeParsedJsonbValue(entry);
      nulCount += result.nulCount;
      return result.value;
    });

    return {
      value: sanitized,
      nulCount,
    };
  }

  if (typeof value === "object" && value !== null) {
    let nulCount = 0;
    const sanitized = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) {
      const sanitizedKey = replaceNul(key);
      const sanitizedEntry = sanitizeParsedJsonbValue(entry);
      nulCount += sanitizedKey.nulCount + sanitizedEntry.nulCount;
      Object.defineProperty(sanitized, sanitizedKey.value, {
        value: sanitizedEntry.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    return {
      value: sanitized,
      nulCount,
    };
  }

  return {
    value,
    nulCount: 0,
  };
}

/**
 * Serializes thread-runtime message JSONB fields while replacing actual JS NULs
 * with a visible placeholder. This is intentionally not the global Postgres
 * JSON serializer: it only protects runtime.inputs/messages payload fields.
 */
export function serializeThreadRuntimeJsonb(value: unknown): ThreadRuntimeJsonbSerialization {
  if (value === undefined) {
    return {
      json: null,
      nulCount: 0,
    };
  }

  const rawJson = JSON.stringify(value);
  if (rawJson === undefined) {
    return {
      json: null,
      nulCount: 0,
    };
  }

  const parsed = JSON.parse(rawJson) as unknown;
  const sanitized = sanitizeParsedJsonbValue(parsed);
  return {
    json: JSON.stringify(sanitized.value),
    nulCount: sanitized.nulCount,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPostgresUnsupportedUnicodeEscapeError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("unsupported unicode escape sequence");
}

export function createThreadRuntimeJsonbPersistenceError(
  error: unknown,
  boundary: ThreadRuntimeJsonbPersistenceBoundary,
): Error | null {
  if (!isPostgresUnsupportedUnicodeEscapeError(error)) {
    return null;
  }

  const fields = boundary.fields
    .map((field) => `${field.name}(nul=${field.nulCount})`)
    .join(",");
  return new Error(
    `Thread runtime JSONB persistence failed: operation=${boundary.operation}; table=${boundary.table}; fields=${fields}; cause=unsupported Unicode escape sequence; payload=redacted.`,
  );
}
