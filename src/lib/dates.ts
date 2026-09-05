import type {JsonObject} from "./json.js";

/**
 * Converts a millisecond timestamp into a `Date`, while preserving `undefined`
 * as `null` for SQL parameter helpers.
 */
export function toDateOrNull(value: number | undefined): Date | null {
  return value === undefined ? null : new Date(value);
}

/** Converts a Date, timestamp number or date string to ISO with caller-owned validation errors. */
export function requireIsoTimestamp(value: unknown, errorMessage: string): string {
  const millis = value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(millis)) throw new Error(errorMessage);
  return new Date(millis).toISOString();
}

/** Converts a present timestamp to ISO and preserves nullish input as null. */
export function nullableIsoTimestamp(value: unknown, errorMessage: string): string | null {
  if (value === null || value === undefined) return null;
  return requireIsoTimestamp(value, errorMessage);
}

export interface LocalDateTimeInfo extends JsonObject {
  isoTimestamp: string;
  formattedDateTime: string;
  formattedDateTimeWithZone: string;
  timeZone: string;
  locale: string;
  weekday: string;
  month: string;
  unixMs: number;
}

/**
 * Resolves the host's current locale/timezone view for a specific moment.
 */
export function resolveLocalDateTimeInfo(
  date = new Date(),
  options: {timeZone?: string} = {},
): LocalDateTimeInfo {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const locale = resolved.locale;
  const timeZone = options.timeZone ?? resolved.timeZone ?? "UTC";

  return {
    isoTimestamp: date.toISOString(),
    formattedDateTime: new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "short",
      timeZone,
    }).format(date),
    formattedDateTimeWithZone: new Intl.DateTimeFormat(locale, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(date),
    timeZone,
    locale,
    weekday: new Intl.DateTimeFormat(locale, {
      weekday: "long",
      timeZone,
    }).format(date),
    month: new Intl.DateTimeFormat(locale, {
      month: "long",
      timeZone,
    }).format(date),
    unixMs: date.getTime(),
  };
}
