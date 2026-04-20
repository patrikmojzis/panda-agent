/**
 * Returns true when `error` looks like a PostgreSQL unique-constraint
 * violation (`23505`).
 */
export function isUniqueViolation(error: unknown): error is { code: string } {
  return !!error && typeof error === "object" && "code" in error && (error as {code?: unknown}).code === "23505";
}

/**
 * Returns true for duplicate-object errors like "constraint already exists"
 * that Postgres reports during idempotent schema bootstrap.
 */
export function isDuplicateObjectError(error: unknown): error is { code: string } {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? String((error as {code?: unknown}).code ?? "") : "";
  if (code === "42710" || code === "42P07") {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already exists");
}
