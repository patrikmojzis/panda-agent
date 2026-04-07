import { LlmContext } from "../../agent-core/llm-context.js";

export interface DateTimeContextOptions {
  locale?: string;
  timeZone?: string;
  now?: Date | (() => Date);
}

function resolveNow(now?: Date | (() => Date)): Date {
  if (typeof now === "function") {
    return now();
  }

  return now ?? new Date();
}

function resolveTimeZone(timeZone?: string): string {
  return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

export class DateTimeContext extends LlmContext {
  override name = "Current DateTime";

  private readonly locale?: string;
  private readonly timeZone?: string;
  private readonly now?: Date | (() => Date);

  constructor(options: DateTimeContextOptions = {}) {
    super();
    this.locale = options.locale;
    this.timeZone = options.timeZone;
    this.now = options.now;
  }

  async getContent(): Promise<string> {
    const now = resolveNow(this.now);
    const timeZone = resolveTimeZone(this.timeZone);
    const locale = this.locale;
    const dateTime = new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "short",
      timeZone,
    }).format(now);
    const weekday = new Intl.DateTimeFormat(locale, {
      weekday: "long",
      timeZone,
    }).format(now);
    const month = new Intl.DateTimeFormat(locale, {
      month: "long",
      timeZone,
    }).format(now);

    return [
      `Current local date and time: ${dateTime}`,
      `Timezone: ${timeZone}`,
      `Weekday: ${weekday}`,
      `Month: ${month}`,
    ].join("\n");
  }
}
