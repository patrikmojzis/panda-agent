export interface CalendarEvent {
  eventId: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  timezone?: string;
  location?: string;
  notes?: string;
  source: "radicale";
}

export interface CalendarEventInput {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  timezone?: string;
  location?: string;
  notes?: string;
  sessionId?: string;
  createdBy?: string;
}

export interface CalendarEventUpdate {
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  timezone?: string;
  location?: string | null;
  notes?: string | null;
  sessionId?: string;
}

export interface CalendarQuery {
  agentKey: string;
  from: Date;
  to: Date;
  text?: string;
  limit: number;
  includeNotes?: boolean;
  requestTimeoutMs?: number;
}

export interface AgentCalendarService {
  queryEvents(query: CalendarQuery): Promise<{
    events: CalendarEvent[];
    truncated: boolean;
  }>;
  getEvent(agentKey: string, eventId: string): Promise<CalendarEvent>;
  createEvent(agentKey: string, input: CalendarEventInput): Promise<CalendarEvent>;
  updateEvent(agentKey: string, eventId: string, update: CalendarEventUpdate): Promise<CalendarEvent>;
  deleteEvent(agentKey: string, eventId: string): Promise<{eventId: string; deleted: true}>;
}
