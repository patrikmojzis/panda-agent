import type {ScheduledTaskOnceSchedule, ScheduledTaskRecurringSchedule, ScheduledTaskSchedule} from "./types.js";

const ABSOLUTE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const MINUTE_MS = 60_000;
const CRON_SCAN_LIMIT_MINUTES = 366 * 24 * 60;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface ParsedCronField {
  wildcard: boolean;
  values: ReadonlySet<number>;
}

interface ParsedCronExpression {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function requireTrimmed(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Scheduled task ${field} must not be empty.`);
  }

  return trimmed;
}

function requireInteger(field: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Scheduled task ${field} must be an integer.`);
  }

  return Number(value);
}

function normalizeCronNumber(field: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Scheduled task ${field} must be between ${min} and ${max}.`);
  }

  return value;
}

function normalizeDayOfWeek(value: number): number {
  if (value === 7) {
    return 0;
  }

  return value;
}

function parseCronField(
  raw: string,
  field: string,
  min: number,
  max: number,
  normalize: (value: number) => number = (value) => value,
): ParsedCronField {
  const trimmed = requireTrimmed(`${field} cron field`, raw);
  const values = new Set<number>();

  if (trimmed === "*") {
    for (let value = min; value <= max; value += 1) {
      values.add(normalize(value));
    }

    return {
      wildcard: true,
      values,
    };
  }

  for (const token of trimmed.split(",")) {
    const normalizedToken = requireTrimmed(`${field} cron token`, token);
    const [rangePart, stepPart] = normalizedToken.split("/");
    const normalizedRangePart = requireTrimmed(`${field} cron range`, rangePart ?? "");
    const step = stepPart === undefined ? 1 : requireInteger(`${field} cron step`, stepPart);
    if (step <= 0) {
      throw new Error(`Scheduled task ${field} cron step must be greater than 0.`);
    }

    if (normalizedRangePart === "*") {
      for (let value = min; value <= max; value += step) {
        values.add(normalize(value));
      }
      continue;
    }

    const [startPart, endPart] = normalizedRangePart.split("-");
    const start = normalizeCronNumber(field, requireInteger(`${field} cron value`, startPart ?? ""), min, max);
    const end = endPart === undefined
      ? start
      : normalizeCronNumber(field, requireInteger(`${field} cron range end`, endPart), min, max);

    if (end < start) {
      throw new Error(`Scheduled task ${field} cron range must be ascending.`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(normalize(value));
    }
  }

  return {
    wildcard: false,
    values,
  };
}

function parseCronExpression(cron: string): ParsedCronExpression {
  const normalized = requireTrimmed("cron", cron).replace(/\s+/g, " ");
  const fields = normalized.split(" ");
  if (fields.length !== 5) {
    throw new Error("Scheduled task cron expression must have exactly 5 fields.");
  }

  return {
    minute: parseCronField(fields[0]!, "minute", 0, 59),
    hour: parseCronField(fields[1]!, "hour", 0, 23),
    dayOfMonth: parseCronField(fields[2]!, "day of month", 1, 31),
    month: parseCronField(fields[3]!, "month", 1, 12),
    dayOfWeek: parseCronField(fields[4]!, "day of week", 0, 7, normalizeDayOfWeek),
  };
}

function assertValidTimeZone(timeZone: string): string {
  const normalized = requireTrimmed("timezone", timeZone);

  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: normalized,
    }).format(new Date(0));
  } catch {
    throw new Error(`Scheduled task timezone ${normalized} is invalid.`);
  }

  return normalized;
}

function normalizeAbsoluteTimestamp(field: string, value: string): string {
  const normalized = requireTrimmed(field, value);
  if (!ABSOLUTE_TIMESTAMP_RE.test(normalized)) {
    throw new Error(`Scheduled task ${field} must be an absolute ISO timestamp with a timezone offset.`);
  }

  const millis = Date.parse(normalized);
  if (Number.isNaN(millis)) {
    throw new Error(`Scheduled task ${field} is invalid.`);
  }

  return new Date(millis).toISOString();
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function readZonedParts(epochMs: number, timeZone: string): ZonedDateTimeParts {
  const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const weekday = values.get("weekday");
  if (!weekday || !(weekday in WEEKDAY_INDEX)) {
    throw new Error(`Unable to resolve weekday in timezone ${timeZone}.`);
  }

  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
    dayOfWeek: WEEKDAY_INDEX[weekday]!,
  };
}

function matchesCron(cron: ParsedCronExpression, zoned: ZonedDateTimeParts): boolean {
  if (!cron.month.values.has(zoned.month)) {
    return false;
  }

  if (!cron.hour.values.has(zoned.hour)) {
    return false;
  }

  if (!cron.minute.values.has(zoned.minute)) {
    return false;
  }

  const dayOfMonthMatch = cron.dayOfMonth.values.has(zoned.day);
  const dayOfWeekMatch = cron.dayOfWeek.values.has(zoned.dayOfWeek);
  const dayMatches = cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard
    ? true
    : cron.dayOfMonth.wildcard
      ? dayOfWeekMatch
      : cron.dayOfWeek.wildcard
        ? dayOfMonthMatch
        : dayOfMonthMatch || dayOfWeekMatch;

  return dayMatches;
}

export function normalizeScheduledTaskSchedule(schedule: ScheduledTaskSchedule): ScheduledTaskSchedule {
  switch (schedule.kind) {
    case "once": {
      const runAt = normalizeAbsoluteTimestamp("runAt", schedule.runAt);
      const deliverAt = schedule.deliverAt === undefined
        ? undefined
        : normalizeAbsoluteTimestamp("deliverAt", schedule.deliverAt);

      if (deliverAt && Date.parse(deliverAt) <= Date.parse(runAt)) {
        throw new Error("Scheduled task deliverAt must be later than runAt.");
      }

      return {
        kind: "once",
        runAt,
        deliverAt,
      } satisfies ScheduledTaskOnceSchedule;
    }
    case "recurring":
      {
        const cron = requireTrimmed("cron", schedule.cron).replace(/\s+/g, " ");
        parseCronExpression(cron);
        return {
        kind: "recurring",
        cron,
        timezone: assertValidTimeZone(schedule.timezone),
        } satisfies ScheduledTaskRecurringSchedule;
      }
    default:
      throw new Error(`Unsupported scheduled task schedule kind ${(schedule as {kind?: string}).kind ?? "unknown"}.`);
  }
}

export function computeRecurringNextFireAt(schedule: ScheduledTaskRecurringSchedule, afterMs: number): number {
  const parsed = parseCronExpression(schedule.cron);
  let cursor = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

  for (let offset = 0; offset < CRON_SCAN_LIMIT_MINUTES; offset += 1) {
    const zoned = readZonedParts(cursor, schedule.timezone);
    if (matchesCron(parsed, zoned)) {
      return cursor;
    }

    cursor += MINUTE_MS;
  }

  throw new Error(`Unable to resolve the next fire time for cron ${schedule.cron}.`);
}

export function computeInitialNextFireAt(schedule: ScheduledTaskSchedule, nowMs: number): number {
  switch (schedule.kind) {
    case "once":
      return Date.parse(schedule.runAt);
    case "recurring":
      return computeRecurringNextFireAt(schedule, nowMs);
    default:
      throw new Error(`Unsupported scheduled task schedule kind ${(schedule as {kind?: string}).kind ?? "unknown"}.`);
  }
}

export function computeClaimNextFireAt(
  schedule: ScheduledTaskSchedule,
  scheduledForMs: number,
): number | undefined {
  if (schedule.kind !== "recurring") {
    return undefined;
  }

  return computeRecurringNextFireAt(schedule, scheduledForMs);
}
