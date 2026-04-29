import {readFile} from "node:fs/promises";

import {DOMParser} from "linkedom";

import {trimToNull, trimToUndefined} from "../../lib/strings.js";
import {
  createCalendarEventIcs,
  parseCalendarResource,
  updateCalendarEventIcs,
  type CalendarResourceForFiltering,
} from "./ics.js";
import type {
  AgentCalendarService,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarQuery,
} from "./types.js";

const DEFAULT_CALENDAR_NAME = "calendar";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LOAD_CONCURRENCY = 8;

export interface RadicaleAgentCalendarServiceOptions {
  baseUrl: string;
  usersFile: string;
  calendarName?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface CalendarAccount {
  agentKey: string;
  password: string;
  calendarUrl: string;
}

interface ListedCalendarResource {
  href: string;
  etag?: string;
}

interface CalendarDataResource extends ListedCalendarResource {
  ics: string;
}

interface XmlElement {
  textContent: string | null;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "%252F");
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function parseUsersFile(contents: string): Map<string, string> {
  const users = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf(":");
    if (separator < 1) {
      continue;
    }

    users.set(line.slice(0, separator), line.slice(separator + 1));
  }

  return users;
}

function readXmlElements(xml: string, localName: string): XmlElement[] {
  const document = new DOMParser().parseFromString(xml, "text/xml");
  return [
    ...Array.from(document.getElementsByTagName(localName) as ArrayLike<XmlElement>),
    ...Array.from(document.getElementsByTagName(`D:${localName}`) as ArrayLike<XmlElement>),
    ...Array.from(document.getElementsByTagName(`d:${localName}`) as ArrayLike<XmlElement>),
  ];
}

function textContent(element: XmlElement | undefined): string | undefined {
  return trimToUndefined(element?.textContent ?? undefined);
}

function responseChildText(response: XmlElement, localName: string): string | undefined {
  return textContent(
    response.getElementsByTagName(localName)[0]
    ?? response.getElementsByTagName(`D:${localName}`)[0]
    ?? response.getElementsByTagName(`d:${localName}`)[0]
    ?? response.getElementsByTagName(`C:${localName}`)[0]
    ?? response.getElementsByTagName(`c:${localName}`)[0],
  );
}

function parsePropfindResources(xml: string): ListedCalendarResource[] {
  const responses = readXmlElements(xml, "response");
  const resources: ListedCalendarResource[] = [];

  for (const response of responses) {
    const href = responseChildText(response, "href");
    if (!href || !href.endsWith(".ics")) {
      continue;
    }

    const etag = responseChildText(response, "getetag");
    resources.push({
      href,
      ...(etag ? {etag} : {}),
    });
  }

  return resources;
}

function parseCalendarDataResources(xml: string): CalendarDataResource[] {
  const responses = readXmlElements(xml, "response");
  const resources: CalendarDataResource[] = [];

  for (const response of responses) {
    const href = responseChildText(response, "href");
    const ics = responseChildText(response, "calendar-data");
    if (!href || !href.endsWith(".ics") || !ics) {
      continue;
    }

    const etag = responseChildText(response, "getetag");
    resources.push({
      href,
      ics,
      ...(etag ? {etag} : {}),
    });
  }

  return resources;
}

function assertSuccessfulResponse(
  response: Response,
  action: string,
  allowedStatuses: readonly number[] = [],
): void {
  if (response.ok || response.status === 207 || allowedStatuses.includes(response.status)) {
    return;
  }

  throw new Error(`${action} failed with HTTP ${response.status}.`);
}

function normalizeEventId(eventId: string): string {
  const normalized = trimToNull(eventId);
  if (!normalized) {
    throw new Error("Calendar event id must not be empty.");
  }

  return normalized;
}

function eventMatchesQuery(resource: CalendarResourceForFiltering, query: CalendarQuery): boolean {
  if (resource.endMs <= query.from.getTime() || resource.startMs >= query.to.getTime()) {
    return false;
  }

  const needle = query.text?.trim().toLowerCase();
  return !needle || resource.searchableText.includes(needle);
}

function sortByStart(a: CalendarResourceForFiltering, b: CalendarResourceForFiltering): number {
  return a.startMs - b.startMs || a.event.title.localeCompare(b.event.title);
}

function formatCalDavUtcDateTime(date: Date): string {
  return date.toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({length: workerCount}, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        break;
      }

      results[index] = await mapper(items[index]!);
    }
  }));

  return results;
}

export class RadicaleAgentCalendarService implements AgentCalendarService {
  private readonly baseUrl: string;
  private readonly usersFile: string;
  private readonly calendarName: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RadicaleAgentCalendarServiceOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.usersFile = options.usersFile;
    this.calendarName = options.calendarName?.trim() || DEFAULT_CALENDAR_NAME;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async queryEvents(query: CalendarQuery): Promise<{events: CalendarEvent[]; truncated: boolean}> {
    const resources = await this.queryResources(query);
    const matched = resources
      .filter((resource) => eventMatchesQuery(resource, query))
      .sort(sortByStart);
    const limited = matched.slice(0, query.limit);

    return {
      events: limited.map((resource) => resource.event),
      truncated: matched.length > limited.length,
    };
  }

  async getEvent(agentKey: string, eventId: string): Promise<CalendarEvent> {
    return (await this.findResourceByEventId(agentKey, eventId, true)).event;
  }

  async createEvent(agentKey: string, input: CalendarEventInput): Promise<CalendarEvent> {
    const account = await this.resolveAccount(agentKey);
    const created = createCalendarEventIcs({
      ...input,
      agentKey,
    });
    await this.request(account, `${account.calendarUrl}${encodePathPart(created.uid)}.ics`, {
      method: "PUT",
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "If-None-Match": "*",
      },
      body: created.ics,
    }, "Create calendar event");

    return created.event;
  }

  async updateEvent(agentKey: string, eventId: string, update: CalendarEventUpdate): Promise<CalendarEvent> {
    const account = await this.resolveAccount(agentKey);
    const existing = await this.findResourceByEventId(agentKey, eventId, true);
    const updated = updateCalendarEventIcs({
      existingIcs: existing.ics,
      update: {
        ...update,
        agentKey,
      },
    });

    await this.request(account, this.resolveHrefUrl(existing.href), {
      method: "PUT",
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        ...(existing.etag ? {"If-Match": existing.etag} : {}),
      },
      body: updated.ics,
    }, "Update calendar event");

    return updated.event;
  }

  async deleteEvent(agentKey: string, eventId: string): Promise<{eventId: string; deleted: true}> {
    const account = await this.resolveAccount(agentKey);
    const existing = await this.findResourceByEventId(agentKey, eventId, false);
    await this.request(account, this.resolveHrefUrl(existing.href), {
      method: "DELETE",
      headers: {
        ...(existing.etag ? {"If-Match": existing.etag} : {}),
      },
    }, "Delete calendar event");

    return {
      eventId: existing.event.eventId,
      deleted: true,
    };
  }

  private async resolveAccount(agentKey: string): Promise<CalendarAccount> {
    const users = parseUsersFile(await readFile(this.usersFile, "utf8"));
    const password = users.get(agentKey);
    if (!password) {
      throw new Error(`Calendar credentials missing for agent ${agentKey}.`);
    }

    return {
      agentKey,
      password,
      calendarUrl: `${this.baseUrl}/${encodePathPart(agentKey)}/${encodePathPart(this.calendarName)}/`,
    };
  }

  private resolveHrefUrl(href: string): string {
    const url = new URL(href, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new Error("Calendar server returned an event URL outside the configured Radicale origin.");
    }

    return url.toString();
  }

  private async request(
    account: CalendarAccount,
    url: string,
    init: RequestInit,
    action: string,
    timeoutMs = this.requestTimeoutMs,
    allowedStatuses: readonly number[] = [],
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: basicAuth(account.agentKey, account.password),
          ...(init.headers ?? {}),
        },
      });
      assertSuccessfulResponse(response, action, allowedStatuses);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async listResources(account: CalendarAccount): Promise<ListedCalendarResource[]> {
    const response = await this.request(account, account.calendarUrl, {
      method: "PROPFIND",
      headers: {
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:getetag />
  </D:prop>
</D:propfind>`,
    }, "List calendar events");

    return parsePropfindResources(await response.text());
  }

  private async queryResources(query: CalendarQuery): Promise<CalendarResourceForFiltering[]> {
    const account = await this.resolveAccount(query.agentKey);
    const response = await this.request(account, account.calendarUrl, {
      method: "REPORT",
      headers: {
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag />
    <C:calendar-data />
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${formatCalDavUtcDateTime(query.from)}" end="${formatCalDavUtcDateTime(query.to)}" />
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`,
    }, "Query calendar events", query.requestTimeoutMs);
    const loaded = parseCalendarDataResources(await response.text()).map((resource) => parseCalendarResource({
      href: resource.href,
      etag: resource.etag,
      ics: resource.ics,
      includeNotes: query.includeNotes,
    }));

    return loaded.filter((resource): resource is CalendarResourceForFiltering => resource !== null);
  }

  private async loadResources(agentKey: string, includeNotes: boolean): Promise<CalendarResourceForFiltering[]> {
    const account = await this.resolveAccount(agentKey);
    const listed = await this.listResources(account);
    const loaded = await mapWithConcurrency(listed, DEFAULT_LOAD_CONCURRENCY, async (resource) => {
      const response = await this.request(account, this.resolveHrefUrl(resource.href), {
        method: "GET",
        headers: {
          Accept: "text/calendar",
        },
      }, "Read calendar event");
      return parseCalendarResource({
        href: resource.href,
        etag: resource.etag,
        ics: await response.text(),
        includeNotes,
      });
    });

    return loaded.filter((resource): resource is CalendarResourceForFiltering => resource !== null);
  }

  private async loadDirectResource(
    agentKey: string,
    eventId: string,
    includeNotes: boolean,
  ): Promise<CalendarResourceForFiltering | null> {
    const account = await this.resolveAccount(agentKey);
    const url = `${account.calendarUrl}${encodePathPart(eventId)}.ics`;
    const response = await this.request(account, url, {
      method: "GET",
      headers: {
        Accept: "text/calendar",
      },
    }, "Read calendar event", undefined, [404]);
    if (response.status === 404) {
      return null;
    }

    return parseCalendarResource({
      href: url,
      etag: response.headers.get("etag") ?? undefined,
      ics: await response.text(),
      includeNotes,
    });
  }

  private async findResourceByEventId(
    agentKey: string,
    eventId: string,
    includeNotes: boolean,
  ): Promise<CalendarResourceForFiltering> {
    const normalizedEventId = normalizeEventId(eventId);
    const directResource = await this.loadDirectResource(agentKey, normalizedEventId, includeNotes);
    if (directResource?.event.eventId === normalizedEventId) {
      return directResource;
    }

    const resources = await this.loadResources(agentKey, includeNotes);
    const resource = resources.find((candidate) => candidate.event.eventId === normalizedEventId);
    if (!resource) {
      throw new Error(`Calendar event ${normalizedEventId} was not found.`);
    }

    return resource;
  }
}

export function createRadicaleAgentCalendarServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RadicaleAgentCalendarService | null {
  const baseUrl = trimToNull(env.PANDA_CALENDAR_URL);
  const usersFile = trimToNull(env.PANDA_CALENDAR_USERS_FILE);
  if (!baseUrl || !usersFile) {
    return null;
  }

  return new RadicaleAgentCalendarService({
    baseUrl,
    usersFile,
    calendarName: trimToUndefined(env.PANDA_CALENDAR_NAME),
  });
}
