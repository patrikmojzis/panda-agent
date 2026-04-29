import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {RadicaleAgentCalendarService} from "../src/integrations/calendar/radicale.js";

describe("RadicaleAgentCalendarService", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop() ?? "", {recursive: true, force: true});
    }
  });

  async function usersFile(contents: string): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-calendar-users-"));
    directories.push(directory);
    const file = path.join(directory, "users");
    await writeFile(file, contents);
    return file;
  }

  it("queries Radicale resources through the current agent credentials", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "REPORT") {
        return new Response(`<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/panda/calendar/event-1.ics</D:href>
    <D:propstat><D:prop>
      <D:getetag>"etag-1"</D:getetag>
      <C:calendar-data><![CDATA[BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-1
DTSTART:20260502T120000Z
DTEND:20260502T130000Z
SUMMARY:Planning
LOCATION:Office
END:VEVENT
END:VCALENDAR
]]></C:calendar-data>
    </D:prop></D:propstat>
  </D:response>
</D:multistatus>`, {
          status: 207,
        });
      }

      return new Response("not found", {status: 404});
    }) as typeof fetch;

    const service = new RadicaleAgentCalendarService({
      baseUrl: "http://radicale:5232",
      usersFile: await usersFile("panda:secret\n"),
      fetchImpl,
    });

    const result = await service.queryEvents({
      agentKey: "panda",
      from: new Date("2026-05-01T00:00:00Z"),
      to: new Date("2026-05-03T00:00:00Z"),
      limit: 10,
    });

    expect(result.events).toEqual([expect.objectContaining({
      eventId: "event-1",
      title: "Planning",
      location: "Office",
    })]);
    expect(fetchImpl).toHaveBeenCalledWith("http://radicale:5232/panda/calendar/", expect.objectContaining({
      method: "REPORT",
      headers: expect.objectContaining({
        Authorization: "Basic cGFuZGE6c2VjcmV0",
      }),
    }));
  });

  it("reads Panda-created event ids through their direct resource path", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET" && String(url).endsWith("/event-1.ics")) {
        return new Response([
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "BEGIN:VEVENT",
          "UID:event-1",
          "DTSTART:20260502T120000Z",
          "DTEND:20260502T130000Z",
          "SUMMARY:Planning",
          "END:VEVENT",
          "END:VCALENDAR",
          "",
        ].join("\r\n"), {
          headers: {
            ETag: "\"etag-1\"",
          },
        });
      }

      return new Response("not found", {status: 404});
    }) as typeof fetch;

    const service = new RadicaleAgentCalendarService({
      baseUrl: "http://radicale:5232",
      usersFile: await usersFile("panda:secret\n"),
      fetchImpl,
    });

    await expect(service.getEvent("panda", "event-1")).resolves.toMatchObject({
      eventId: "event-1",
      title: "Planning",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("http://radicale:5232/panda/calendar/event-1.ics", expect.objectContaining({
      method: "GET",
    }));
  });

  it("rejects cross-origin event hrefs before sending credentials", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response("not found", {status: 404});
      }

      if (init?.method === "PROPFIND") {
        return new Response(`<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>https://example.test/steal.ics</D:href>
    <D:propstat><D:prop><D:getetag>"etag-1"</D:getetag></D:prop></D:propstat>
  </D:response>
</D:multistatus>`, {
          status: 207,
        });
      }

      return new Response("should not fetch", {status: 500});
    }) as typeof fetch;

    const service = new RadicaleAgentCalendarService({
      baseUrl: "http://radicale:5232",
      usersFile: await usersFile("panda:secret\n"),
      fetchImpl,
    });

    await expect(service.getEvent("panda", "event-1")).rejects.toThrow("outside the configured Radicale origin");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
