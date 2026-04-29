import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {AgentCalendarService, CalendarEvent} from "../../integrations/calendar/types.js";
import {addLocalDays, startOfLocalWeek} from "../../lib/dates.js";
import {renderCalendarAgendaContext} from "../../prompts/contexts/calendar-agenda.js";

const DEFAULT_LOOKAHEAD_DAYS = 35;
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;

export interface CalendarAgendaContextOptions {
  service: AgentCalendarService;
  agentKey: string;
  now?: Date | (() => Date);
  maxItems?: number;
  lookaheadDays?: number;
  requestTimeoutMs?: number;
}

function resolveNow(now?: Date | (() => Date)): Date {
  return typeof now === "function" ? now() : now ?? new Date();
}

function formatRangeDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatEventWhen(event: CalendarEvent): string {
  if (event.allDay) {
    return event.start;
  }

  const date = new Date(event.start);
  if (Number.isNaN(date.getTime())) {
    return event.start;
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function sanitizeAgendaField(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

export class CalendarAgendaContext extends LlmContext {
  override name = "Calendar Agenda";

  private readonly options: CalendarAgendaContextOptions;

  constructor(options: CalendarAgendaContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const now = resolveNow(this.options.now);
    const from = startOfLocalWeek(now);
    const to = addLocalDays(from, this.options.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS);
    const limit = this.options.maxItems ?? DEFAULT_MAX_ITEMS;
    const requestTimeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    try {
      const result = await this.options.service.queryEvents({
        agentKey: this.options.agentKey,
        from,
        to,
        limit,
        includeNotes: false,
        requestTimeoutMs,
      });

      return renderCalendarAgendaContext({
        range: `${formatRangeDate(from)} through ${formatRangeDate(to)}`,
        items: result.events.map((event) => ({
          title: sanitizeAgendaField(event.title),
          when: sanitizeAgendaField(formatEventWhen(event)),
          ...(event.location ? {location: sanitizeAgendaField(event.location)} : {}),
        })),
        truncated: result.truncated,
      });
    } catch {
      // Calendar context is ambient. If Radicale is temporarily unavailable,
      // keep the main prompt clean and let the explicit calendar tool report errors.
      return "";
    }
  }
}
