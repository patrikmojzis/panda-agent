import type {JsonObject} from "../kernel/agent/types.js";

/**
 * Converts a millisecond timestamp into a `Date`, while preserving `undefined`
 * as `null` for SQL parameter helpers.
 */
export function toDateOrNull(value: number | undefined): Date | null {
  return value === undefined ? null : new Date(value);
}

/**
 * Returns the Monday-start local week boundary for agenda-style date ranges.
 */
export function startOfLocalWeek(date = new Date()): Date {
  const start = new Date(date);
  const day = start.getDay();
  const daysSinceMonday = (day + 6) % 7;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
}

/**
 * Adds calendar days in local time, preserving wall-clock boundaries across DST.
 */
export function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
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
export function resolveLocalDateTimeInfo(date = new Date()): LocalDateTimeInfo {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const locale = resolved.locale;
  const timeZone = resolved.timeZone ?? "UTC";

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
