import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {AgentCalendarService, CalendarEvent} from "../../integrations/calendar/types.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {JsonObject, ToolResultPayload} from "../../kernel/agent/types.js";
import {addLocalDays, resolveLocalDateTimeInfo, startOfLocalWeek} from "../../lib/dates.js";
import {buildJsonToolPayload, rethrowAsToolError} from "./shared.js";

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;

const querySchema = z.strictObject({
  action: z.literal("query"),
  from: z.string().trim().min(1).optional()
    .describe("Inclusive ISO date/datetime. Defaults to the start of the current local week."),
  to: z.string().trim().min(1).optional()
    .describe("Exclusive ISO date/datetime. Defaults to 35 days after the current local week starts."),
  text: z.string().trim().min(1).optional()
    .describe("Optional text search across title, location, and notes."),
  limit: z.number().int().positive().max(MAX_QUERY_LIMIT).optional(),
  includeNotes: z.boolean().optional()
    .describe("Return event notes. Defaults false; use only when the notes matter."),
});

const getEventSchema = z.strictObject({
  action: z.literal("get_event"),
  eventId: z.string().trim().min(1),
});

const createEventSchema = z.strictObject({
  action: z.literal("create_event"),
  title: z.string().trim().min(1),
  start: z.string().trim().min(1)
    .describe("ISO date for all-day events, or ISO datetime with timezone offset/Z for timed events."),
  end: z.string().trim().min(1).optional()
    .describe("ISO date for all-day events, or ISO datetime with timezone offset/Z for timed events."),
  allDay: z.boolean().optional(),
  timezone: z.string().trim().min(1).optional()
    .describe("IANA timezone label for display context. Defaults to the runtime timezone."),
  location: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
});

const updateEventSchema = z.strictObject({
  action: z.literal("update_event"),
  eventId: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  start: z.string().trim().min(1).optional()
    .describe("ISO date for all-day events, or ISO datetime with timezone offset/Z for timed events."),
  end: z.string().trim().min(1).optional()
    .describe("ISO date for all-day events, or ISO datetime with timezone offset/Z for timed events."),
  allDay: z.boolean().optional(),
  timezone: z.string().trim().min(1).optional(),
  location: z.string().trim().min(1).nullable().optional(),
  notes: z.string().trim().min(1).nullable().optional(),
});

const deleteEventSchema = z.strictObject({
  action: z.literal("delete_event"),
  eventId: z.string().trim().min(1),
});

function readCalendarScope(context: unknown): {agentKey: string; sessionId?: string} {
  if (
    !context
    || typeof context !== "object"
    || Array.isArray(context)
    || typeof (context as {agentKey?: unknown}).agentKey !== "string"
    || !(context as {agentKey: string}).agentKey.trim()
  ) {
    throw new ToolError("Calendar requires agentKey in the runtime session context.");
  }

  const sessionId = typeof (context as {sessionId?: unknown}).sessionId === "string"
    ? (context as {sessionId: string}).sessionId.trim()
    : "";

  return {
    agentKey: (context as {agentKey: string}).agentKey.trim(),
    ...(sessionId ? {sessionId} : {}),
  };
}

function parseDateBoundary(value: string | undefined, fallback: Date, field: string): Date {
  if (!value) {
    return fallback;
  }

  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ToolError(`Calendar ${field} must be an ISO date or datetime.`);
  }

  return parsed;
}

function serializeCalendarEvent(event: CalendarEvent): JsonObject {
  return {
    eventId: event.eventId,
    title: event.title,
    start: event.start,
    ...(event.end ? {end: event.end} : {}),
    allDay: event.allDay,
    ...(event.timezone ? {timezone: event.timezone} : {}),
    ...(event.location ? {location: event.location} : {}),
    ...(event.notes ? {notes: event.notes} : {}),
    source: event.source,
  };
}

export interface CalendarToolOptions {
  service: AgentCalendarService;
  now?: Date | (() => Date);
}

export class CalendarTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof CalendarTool.schema, TContext> {
  static schema = z.strictObject({
    action: z.enum(["query", "get_event", "create_event", "update_event", "delete_event"]),
    from: z.string().trim().min(1).optional()
      .describe("For query: inclusive ISO date/datetime. Defaults to the start of the current local week."),
    to: z.string().trim().min(1).optional()
      .describe("For query: exclusive ISO date/datetime. Defaults to 35 days after the current local week starts."),
    text: z.string().trim().min(1).optional()
      .describe("For query: optional text search across title, location, and notes."),
    limit: z.number().int().positive().max(MAX_QUERY_LIMIT).optional()
      .describe("For query: max events to return. Defaults 50, max 200."),
    includeNotes: z.boolean().optional()
      .describe("For query: return event notes. Defaults false; use only when notes matter."),
    eventId: z.string().trim().min(1).optional()
      .describe("For get_event, update_event, and delete_event."),
    title: z.string().trim().min(1).optional()
      .describe("For create_event and update_event."),
    start: z.string().trim().min(1).optional()
      .describe("For create_event and update_event: ISO date for all-day events, or ISO datetime with timezone offset/Z for timed events."),
    end: z.string().trim().min(1).optional()
      .describe("For create_event and update_event: ISO date for all-day events, or ISO datetime with timezone offset/Z for timed events."),
    allDay: z.boolean().optional(),
    timezone: z.string().trim().min(1).optional()
      .describe("For create_event and update_event: IANA timezone label for display context."),
    location: z.string().trim().min(1).nullable().optional(),
    notes: z.string().trim().min(1).nullable().optional(),
  });

  name = "calendar";
  description = [
    "Read and manage the current agent's private planning calendar.",
    "Use this for the agent's own durable planning surface, not for reminder wakes.",
    "For reminders or future execution, use scheduled_task_create instead.",
    "Events never wake the session by themselves.",
  ].join("\n");
  schema = CalendarTool.schema;

  private readonly service: AgentCalendarService;
  private readonly now?: Date | (() => Date);

  constructor(options: CalendarToolOptions) {
    super();
    this.service = options.service;
    this.now = options.now;
  }

  override formatCall(args: Record<string, unknown>): string {
    const action = typeof args.action === "string" ? args.action : "calendar";
    const title = typeof args.title === "string" ? args.title : undefined;
    const eventId = typeof args.eventId === "string" ? args.eventId : undefined;
    return [action, title ?? eventId].filter(Boolean).join(": ");
  }

  async handle(
    args: z.output<typeof CalendarTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    try {
      const scope = readCalendarScope(run.context);
      const now = typeof this.now === "function" ? this.now() : this.now ?? new Date();
      const timezone = resolveLocalDateTimeInfo(now).timeZone;

      switch (args.action) {
        case "query": {
          const parsed = querySchema.parse(args);
          const defaultFrom = startOfLocalWeek(now);
          const from = parseDateBoundary(parsed.from, defaultFrom, "from");
          const to = parseDateBoundary(parsed.to, addLocalDays(defaultFrom, 35), "to");
          if (to.getTime() <= from.getTime()) {
            throw new ToolError("Calendar query to must be after from.");
          }

          const result = await this.service.queryEvents({
            agentKey: scope.agentKey,
            from,
            to,
            text: parsed.text,
            limit: parsed.limit ?? DEFAULT_QUERY_LIMIT,
            includeNotes: parsed.includeNotes,
          });
          return buildJsonToolPayload({
            ok: true,
            action: parsed.action,
            from: from.toISOString(),
            to: to.toISOString(),
            events: result.events.map(serializeCalendarEvent),
            truncated: result.truncated,
          });
        }
        case "get_event": {
          const parsed = getEventSchema.parse(args);
          const event = await this.service.getEvent(scope.agentKey, parsed.eventId);
          return buildJsonToolPayload({
            ok: true,
            action: parsed.action,
            event: serializeCalendarEvent(event),
          });
        }
        case "create_event": {
          const parsed = createEventSchema.parse(args);
          const event = await this.service.createEvent(scope.agentKey, {
            title: parsed.title,
            start: parsed.start,
            end: parsed.end,
            allDay: parsed.allDay,
            timezone: parsed.timezone ?? timezone,
            location: parsed.location,
            notes: parsed.notes,
            sessionId: scope.sessionId,
            createdBy: "agent",
          });
          return buildJsonToolPayload({
            ok: true,
            action: parsed.action,
            event: serializeCalendarEvent(event),
          });
        }
        case "update_event": {
          const parsed = updateEventSchema.parse(args);
          const event = await this.service.updateEvent(scope.agentKey, parsed.eventId, {
            title: parsed.title,
            start: parsed.start,
            end: parsed.end,
            allDay: parsed.allDay,
            timezone: parsed.timezone,
            location: parsed.location,
            notes: parsed.notes,
            sessionId: scope.sessionId,
          });
          return buildJsonToolPayload({
            ok: true,
            action: parsed.action,
            event: serializeCalendarEvent(event),
          });
        }
        case "delete_event": {
          const parsed = deleteEventSchema.parse(args);
          const result = await this.service.deleteEvent(scope.agentKey, parsed.eventId);
          return buildJsonToolPayload({
            ok: true,
            action: parsed.action,
            ...result,
          });
        }
      }
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}
