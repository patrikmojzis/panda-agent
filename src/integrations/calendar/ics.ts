import {randomUUID} from "node:crypto";

import {collapseWhitespace, trimToUndefined} from "../../lib/strings.js";
import type {CalendarEvent, CalendarEventInput, CalendarEventUpdate} from "./types.js";

const DEFAULT_TIMED_EVENT_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const ABSOLUTE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface ParsedIcsEvent {
  uid: string;
  summary: string;
  dtstart: ParsedDateTime;
  dtend?: ParsedDateTime;
  location?: string;
  description?: string;
  created?: string;
  pandaSessionId?: string;
  pandaCreatedBy?: string;
  pandaTimezone?: string;
}

interface ParsedDateTime {
  value: string;
  allDay: boolean;
  date: Date;
  output: string;
  timezone?: string;
}

export interface CalendarResourceForFiltering {
  href: string;
  etag?: string;
  event: CalendarEvent;
  ics: string;
  startMs: number;
  endMs: number;
  searchableText: string;
}

function unfoldIcsLines(ics: string): string[] {
  return ics
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function splitProperty(line: string): IcsProperty | null {
  const colonIndex = line.indexOf(":");
  if (colonIndex < 1) {
    return null;
  }

  const head = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);
  const [namePart = "", ...paramParts] = head.split(";");
  const name = namePart.toUpperCase();
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const equalsIndex = part.indexOf("=");
    if (equalsIndex < 1) {
      continue;
    }

    params[part.slice(0, equalsIndex).toUpperCase()] = part.slice(equalsIndex + 1).replace(/^"|"$/g, "");
  }

  return {name, params, value};
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function escapeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function escapeCustomTextProperty(name: string, value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must not contain control characters.`);
  }

  return escapeText(value);
}

function foldIcsLine(line: string): string {
  const chunks: string[] = [];
  let rest = line;
  while (rest.length > 75) {
    chunks.push(rest.slice(0, 75));
    rest = rest.slice(75);
  }
  chunks.push(rest);
  return chunks.map((chunk, index) => index === 0 ? chunk : ` ${chunk}`).join("\r\n");
}

function formatDateParts(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}${month}${day}`;
}

function formatUtcDateTime(date: Date): string {
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  return `${formatDateParts(date)}T${hours}${minutes}${seconds}Z`;
}

function formatIsoDateFromIcsDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function isSameUtcDate(date: Date, year: number, month: number, day: number): boolean {
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function parseIcsDate(value: string, params: Record<string, string>): ParsedDateTime | null {
  if (/^\d{8}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6));
    const day = Number(value.slice(6, 8));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!isSameUtcDate(date, year, month, day)) {
      return null;
    }

    return {
      value,
      allDay: true,
      date,
      output: formatIsoDateFromIcsDate(value),
      timezone: params.TZID,
    };
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, utcSuffix] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  const date = new Date(Date.UTC(
    yearNumber,
    monthNumber - 1,
    dayNumber,
    hourNumber,
    minuteNumber,
    secondNumber,
  ));
  if (
    !isSameUtcDate(date, yearNumber, monthNumber, dayNumber)
    || date.getUTCHours() !== hourNumber
    || date.getUTCMinutes() !== minuteNumber
    || date.getUTCSeconds() !== secondNumber
  ) {
    return null;
  }

  return {
    value,
    allDay: false,
    date,
    output: utcSuffix ? date.toISOString() : `${year}-${month}-${day}T${hour}:${minute}:${second}`,
    timezone: params.TZID,
  };
}

function parseIcsEvent(ics: string): ParsedIcsEvent | null {
  const lines = unfoldIcsLines(ics);
  let inEvent = false;
  const props: IcsProperty[] = [];

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      inEvent = true;
      continue;
    }
    if (upper === "END:VEVENT") {
      break;
    }
    if (!inEvent) {
      continue;
    }

    const prop = splitProperty(line);
    if (prop) {
      props.push(prop);
    }
  }

  const get = (name: string): IcsProperty | undefined => props.find((prop) => prop.name === name);
  const uid = trimToUndefined(get("UID")?.value);
  const summary = trimToUndefined(get("SUMMARY")?.value);
  const dtstartProp = get("DTSTART");
  if (!uid || !summary || !dtstartProp) {
    return null;
  }

  const dtstart = parseIcsDate(dtstartProp.value, dtstartProp.params);
  if (!dtstart) {
    return null;
  }

  const dtendProp = get("DTEND");
  const dtend = dtendProp ? parseIcsDate(dtendProp.value, dtendProp.params) ?? undefined : undefined;

  return {
    uid,
    summary: unescapeText(summary),
    dtstart,
    dtend,
    location: trimToUndefined(unescapeText(get("LOCATION")?.value ?? "")),
    description: trimToUndefined(unescapeText(get("DESCRIPTION")?.value ?? "")),
    created: trimToUndefined(get("CREATED")?.value),
    pandaSessionId: trimToUndefined(get("X-PANDA-SESSION-ID")?.value),
    pandaCreatedBy: trimToUndefined(get("X-PANDA-CREATED-BY")?.value),
    pandaTimezone: trimToUndefined(get("X-PANDA-TIMEZONE")?.value),
  };
}

function defaultEndFor(start: ParsedDateTime): ParsedDateTime {
  const date = new Date(start.date.getTime() + (start.allDay ? DAY_MS : DEFAULT_TIMED_EVENT_MS));
  const value = start.allDay ? formatDateParts(date) : formatUtcDateTime(date);
  return {
    value,
    allDay: start.allDay,
    date,
    output: start.allDay ? formatIsoDateFromIcsDate(value) : date.toISOString(),
    timezone: start.timezone,
  };
}

function toCalendarEvent(parsed: ParsedIcsEvent, includeNotes: boolean): CalendarEvent {
  return {
    eventId: parsed.uid,
    title: parsed.summary,
    start: parsed.dtstart.output,
    end: parsed.dtend?.output,
    allDay: parsed.dtstart.allDay,
    ...(parsed.dtstart.timezone || parsed.pandaTimezone ? {timezone: parsed.dtstart.timezone ?? parsed.pandaTimezone} : {}),
    ...(parsed.location ? {location: parsed.location} : {}),
    ...(includeNotes && parsed.description ? {notes: parsed.description} : {}),
    source: "radicale",
  };
}

export function parseCalendarResource(input: {
  href: string;
  etag?: string;
  ics: string;
  includeNotes?: boolean;
}): CalendarResourceForFiltering | null {
  const parsed = parseIcsEvent(input.ics);
  if (!parsed) {
    return null;
  }

  const end = parsed.dtend ?? defaultEndFor(parsed.dtstart);
  const searchableText = [
    parsed.summary,
    parsed.location,
    parsed.description,
  ].filter((value): value is string => Boolean(value)).join("\n").toLowerCase();

  return {
    href: input.href,
    etag: input.etag,
    event: toCalendarEvent(parsed, Boolean(input.includeNotes)),
    ics: input.ics,
    startMs: parsed.dtstart.date.getTime(),
    endMs: end.date.getTime(),
    searchableText,
  };
}

function parseIsoInput(value: string, allDay?: boolean): ParsedDateTime {
  const trimmed = value.trim();
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (!match) {
      throw new Error("All-day calendar dates must use YYYY-MM-DD.");
    }

    const [, year, month, day] = match;
    const yearNumber = Number(year);
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    const date = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
    if (!isSameUtcDate(date, yearNumber, monthNumber, dayNumber)) {
      throw new Error("All-day calendar dates must use a real YYYY-MM-DD date.");
    }

    const icsValue = `${year}${month}${day}`;
    return {
      value: icsValue,
      allDay: true,
      date,
      output: trimmed,
    };
  }

  if (!ABSOLUTE_TIMESTAMP_RE.test(trimmed)) {
    throw new Error("Timed calendar events must use an ISO datetime with timezone offset or Z.");
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Timed calendar events must use an ISO datetime with timezone offset or Z.");
  }

  return {
    value: formatUtcDateTime(parsed),
    allDay: false,
    date: parsed,
    output: parsed.toISOString(),
  };
}

function buildDateProperty(name: string, value: ParsedDateTime): string {
  if (value.allDay) {
    return `${name};VALUE=DATE:${value.value}`;
  }

  return `${name}:${value.value}`;
}

function buildIcsLines(lines: string[]): string {
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

function buildShiftedEnd(
  start: ParsedDateTime,
  durationMs: number,
  previousEnd: ParsedDateTime,
): ParsedDateTime {
  const endDate = new Date(start.date.getTime() + durationMs);
  const dateValue = formatDateParts(endDate);
  return {
    ...previousEnd,
    allDay: start.allDay,
    date: endDate,
    value: start.allDay ? dateValue : formatUtcDateTime(endDate),
    output: start.allDay ? formatIsoDateFromIcsDate(dateValue) : endDate.toISOString(),
  };
}

export function createCalendarEventIcs(input: CalendarEventInput & {
  agentKey: string;
  uid?: string;
  now?: Date;
}): {uid: string; ics: string; event: CalendarEvent} {
  const now = input.now ?? new Date();
  const uid = input.uid ?? `${randomUUID()}@panda`;
  const title = collapseWhitespace(input.title);
  if (!title) {
    throw new Error("Calendar event title must not be empty.");
  }

  const start = parseIsoInput(input.start, input.allDay);
  const end = input.end ? parseIsoInput(input.end, start.allDay) : defaultEndFor(start);
  if (end.date.getTime() <= start.date.getTime()) {
    throw new Error("Calendar event end must be after start.");
  }

  const timestamp = formatUtcDateTime(now);
  const location = trimToUndefined(input.location);
  const notes = trimToUndefined(input.notes);
  const timezone = trimToUndefined(input.timezone);
  const sessionId = trimToUndefined(input.sessionId);
  const createdBy = trimToUndefined(input.createdBy);
  const agentKey = escapeCustomTextProperty("X-PANDA-AGENT-KEY", input.agentKey);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Panda Agent//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${timestamp}`,
    `CREATED:${timestamp}`,
    `LAST-MODIFIED:${timestamp}`,
    buildDateProperty("DTSTART", start),
    buildDateProperty("DTEND", end),
    `SUMMARY:${escapeText(title)}`,
    ...(location ? [`LOCATION:${escapeText(location)}`] : []),
    ...(notes ? [`DESCRIPTION:${escapeText(notes)}`] : []),
    `X-PANDA-AGENT-KEY:${agentKey}`,
    ...(timezone ? [`X-PANDA-TIMEZONE:${escapeCustomTextProperty("X-PANDA-TIMEZONE", timezone)}`] : []),
    ...(sessionId ? [`X-PANDA-SESSION-ID:${escapeCustomTextProperty("X-PANDA-SESSION-ID", sessionId)}`] : []),
    ...(createdBy ? [`X-PANDA-CREATED-BY:${escapeCustomTextProperty("X-PANDA-CREATED-BY", createdBy)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const ics = buildIcsLines(lines);
  const parsed = parseCalendarResource({href: `${uid}.ics`, ics, includeNotes: true});
  if (!parsed) {
    throw new Error("Created calendar event could not be parsed.");
  }

  return {uid, ics, event: parsed.event};
}

export function updateCalendarEventIcs(input: {
  existingIcs: string;
  update: CalendarEventUpdate & {agentKey: string; now?: Date};
}): {uid: string; ics: string; event: CalendarEvent} {
  const existing = parseIcsEvent(input.existingIcs);
  if (!existing) {
    throw new Error("Existing calendar event could not be parsed.");
  }

  const oldEnd = existing.dtend ?? defaultEndFor(existing.dtstart);
  const oldDuration = Math.max(1, oldEnd.date.getTime() - existing.dtstart.date.getTime());
  const nextAllDay = input.update.allDay ?? existing.dtstart.allDay;
  const convertedStart = nextAllDay === existing.dtstart.allDay
    ? undefined
    : nextAllDay
      ? existing.dtstart.output.slice(0, 10)
      : existing.dtstart.date.toISOString();
  const nextStart = input.update.start || convertedStart
    ? parseIsoInput(input.update.start ?? convertedStart ?? existing.dtstart.output, nextAllDay)
    : existing.dtstart;
  const nextEnd = input.update.end
    ? parseIsoInput(input.update.end, nextStart.allDay)
    : buildShiftedEnd(nextStart, oldDuration, oldEnd);

  const next = createCalendarEventIcs({
    agentKey: input.update.agentKey,
    uid: existing.uid,
    now: input.update.now,
    title: input.update.title ?? existing.summary,
    start: nextStart.output,
    end: nextEnd.output,
    allDay: nextStart.allDay,
    location: input.update.location === undefined ? existing.location : input.update.location ?? undefined,
    notes: input.update.notes === undefined ? existing.description : input.update.notes ?? undefined,
    timezone: input.update.timezone ?? existing.pandaTimezone,
    sessionId: input.update.sessionId ?? existing.pandaSessionId,
    createdBy: existing.pandaCreatedBy,
  });

  const created = existing.created;
  if (!created) {
    return next;
  }

  return {
    ...next,
    ics: next.ics.replace(/^CREATED:[^\r\n]+/m, `CREATED:${created}`),
  };
}
