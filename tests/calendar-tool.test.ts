import {describe, expect, it, vi} from "vitest";

import type {RunContext} from "../src/kernel/agent/run-context.js";
import {CalendarTool} from "../src/panda/tools/calendar-tool.js";
import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";
import type {AgentCalendarService} from "../src/integrations/calendar/types.js";

function runContext(context: Partial<DefaultAgentSessionContext>): RunContext<DefaultAgentSessionContext> {
  return {context} as RunContext<DefaultAgentSessionContext>;
}

describe("CalendarTool", () => {
  it("queries the current agent calendar with default week range", async () => {
    const service: AgentCalendarService = {
      queryEvents: vi.fn(async () => ({
        events: [{
          eventId: "event-1",
          title: "Planning",
          start: "2026-05-02T12:00:00.000Z",
          allDay: false,
          source: "radicale",
        }],
        truncated: false,
      })),
      getEvent: vi.fn(),
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      deleteEvent: vi.fn(),
    };
    const tool = new CalendarTool({
      service,
      now: new Date("2026-04-29T12:00:00Z"),
    });

    const result = await tool.handle({
      action: "query",
    }, runContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    }));

    expect(service.queryEvents).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: "panda",
      limit: 50,
      includeNotes: undefined,
    }));
    expect(JSON.stringify(result.details)).toContain("Planning");
  });

  it("creates events without exposing an agent selector", async () => {
    const service: AgentCalendarService = {
      queryEvents: vi.fn(),
      getEvent: vi.fn(),
      createEvent: vi.fn(async () => ({
        eventId: "event-2",
        title: "Think",
        start: "2026-05-02",
        allDay: true,
        timezone: "UTC",
        source: "radicale",
      })),
      updateEvent: vi.fn(),
      deleteEvent: vi.fn(),
    };
    const tool = new CalendarTool({
      service,
      now: new Date("2026-04-29T12:00:00Z"),
    });

    await tool.handle({
      action: "create_event",
      title: "Think",
      start: "2026-05-02",
      allDay: true,
    }, runContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    }));

    expect(service.createEvent).toHaveBeenCalledWith("panda", expect.objectContaining({
      title: "Think",
      sessionId: "session-1",
      createdBy: "agent",
    }));
  });
});
