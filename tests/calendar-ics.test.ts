import {describe, expect, it} from "vitest";

import {
  createCalendarEventIcs,
  parseCalendarResource,
  updateCalendarEventIcs,
} from "../src/integrations/calendar/ics.js";

describe("calendar ICS helpers", () => {
  it("creates parseable all-day events with Panda metadata", () => {
    const created = createCalendarEventIcs({
      agentKey: "panda",
      uid: "event-1@panda",
      now: new Date("2026-04-28T10:00:00Z"),
      title: "Focus day",
      start: "2026-05-02",
      allDay: true,
      timezone: "Europe/Bratislava",
      sessionId: "session-1",
      createdBy: "agent",
    });

    expect(created.ics).toContain("UID:event-1@panda");
    expect(created.ics).toContain("DTSTART;VALUE=DATE:20260502");
    expect(created.ics).toContain("X-PANDA-AGENT-KEY:panda");

    const parsed = parseCalendarResource({
      href: "/panda/calendar/event-1%40panda.ics",
      ics: created.ics,
      includeNotes: false,
    });
    expect(parsed?.event).toMatchObject({
      eventId: "event-1@panda",
      title: "Focus day",
      start: "2026-05-02",
      allDay: true,
      timezone: "Europe/Bratislava",
    });
  });

  it("updates timed events while preserving UID and CREATED", () => {
    const created = createCalendarEventIcs({
      agentKey: "panda",
      uid: "event-2@panda",
      now: new Date("2026-04-28T10:00:00Z"),
      title: "Draft plan",
      start: "2026-05-02T14:00:00+02:00",
      end: "2026-05-02T15:00:00+02:00",
      notes: "Initial notes",
    });

    const updated = updateCalendarEventIcs({
      existingIcs: created.ics,
      update: {
        agentKey: "panda",
        now: new Date("2026-04-29T10:00:00Z"),
        title: "Draft better plan",
        location: "Desk",
        notes: null,
      },
    });

    expect(updated.ics).toContain("UID:event-2@panda");
    expect(updated.ics).toContain("CREATED:20260428T100000Z");
    expect(updated.ics).toContain("SUMMARY:Draft better plan");
    expect(updated.ics).toContain("LOCATION:Desk");
    expect(updated.ics).not.toContain("DESCRIPTION:");
  });

  it("escapes carriage returns in model-provided text fields", () => {
    const created = createCalendarEventIcs({
      agentKey: "panda",
      uid: "event-3@panda",
      title: "Injected\rX-BAD:1",
      start: "2026-05-02",
      location: "Office\r\nX-BAD:2",
      notes: "Line one\rLine two",
    });

    expect(created.ics).toContain("SUMMARY:Injected X-BAD:1");
    expect(created.ics).toContain("LOCATION:Office\\nX-BAD:2");
    expect(created.ics).toContain("DESCRIPTION:Line one\\nLine two");
    expect(created.ics).not.toMatch(/\rX-BAD|\nX-BAD/);
  });

  it("rejects control characters in custom Panda metadata fields", () => {
    expect(() => createCalendarEventIcs({
      agentKey: "panda",
      uid: "event-4@panda",
      title: "Injected metadata",
      start: "2026-05-02",
      timezone: "Europe/Bratislava\r\nX-BAD:1",
    })).toThrow("X-PANDA-TIMEZONE must not contain control characters.");

    expect(() => createCalendarEventIcs({
      agentKey: "panda",
      uid: "event-5@panda",
      title: "Injected session",
      start: "2026-05-02",
      sessionId: "session-1\nX-BAD:1",
    })).toThrow("X-PANDA-SESSION-ID must not contain control characters.");
  });

  it("rejects impossible all-day dates and timezone-less timed inputs", () => {
    expect(() => createCalendarEventIcs({
      agentKey: "panda",
      uid: "event-6@panda",
      title: "Bad all-day date",
      start: "2026-02-31",
      allDay: true,
    })).toThrow("All-day calendar dates must use a real YYYY-MM-DD date.");

    expect(() => createCalendarEventIcs({
      agentKey: "panda",
      uid: "event-7@panda",
      title: "Bad timed date",
      start: "2026-05-02T14:00:00",
    })).toThrow("Timed calendar events must use an ISO datetime with timezone offset or Z.");
  });
});
