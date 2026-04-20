/**
 * Returns a trimmed string when `value` is a non-empty string, otherwise
 * returns `null`.
 */
export function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Returns a trimmed string when `value` is a non-empty string, otherwise
 * returns `undefined`.
 */
export function trimToUndefined(value: unknown): string | undefined {
  return trimToNull(value) ?? undefined;
}

/**
 * Returns the first non-empty trimmed string from `values`.
 */
export function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const trimmed = trimToUndefined(value);
    if (trimmed !== undefined) {
      return trimmed;
    }
  }

  return undefined;
}

/**
 * Ensures that `value` is a non-empty trimmed string.
 *
 * Pass the fully rendered error message so callers can keep domain-specific
 * wording without cloning the trimming logic.
 */
export function requireNonEmptyString(value: unknown, errorMessage: string): string {
  const trimmed = trimToUndefined(value);
  if (trimmed === undefined) {
    throw new Error(errorMessage);
  }

  return trimmed;
}

/**
 * Collapses every run of whitespace to a single space and trims the result.
 */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Removes invisible Unicode control characters that commonly leak from copied
 * web and rich-text content.
 */
export function stripInvisibleUnicode(value: string): string {
  return value.replace(
    /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu,
    "",
  );
}

/**
 * Normalizes mixed whitespace in multi-line text while keeping paragraph
 * breaks intact.
 */
export function normalizeTextBlockWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Returns `value` unchanged when it already fits within `maxChars`.
 * Longer values are trimmed, kept within the requested budget, and suffixed
 * with an ellipsis.
 */
export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

/**
 * Returns the original string plus a flag that tells callers whether it had to
 * be shortened to fit within `maxChars`.
 */
export function truncateTextWithStatus(
  value: string,
  maxChars: number,
): {text: string; truncated: boolean} {
  if (value.length <= maxChars) {
    return {text: value, truncated: false};
  }

  return {
    text: value.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}
