import {LlmContext} from "../../kernel/agent/llm-context.js";
import {renderDateTimeContext} from "../../prompts/contexts/datetime.js";

export interface DateTimeContextOptions {
  now?: Date | (() => Date);
}

export interface ResolvedDateTimeContextOptions {
  locale: string;
  timeZone: string;
}

function resolveNow(now?: Date | (() => Date)): Date {
  if (typeof now === "function") {
    return now();
  }

  return now ?? new Date();
}

export function resolveDateTimeContextOptions(): ResolvedDateTimeContextOptions {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    locale: resolved.locale,
    timeZone: resolved.timeZone ?? "UTC",
  };
}

export class DateTimeContext extends LlmContext {
  override name = "Current DateTime";

  private readonly now?: Date | (() => Date);

  constructor(options: DateTimeContextOptions = {}) {
    super();
    this.now = options.now;
  }

  async getContent(): Promise<string> {
    const now = resolveNow(this.now);
    // Panda uses the host clock and host timezone as the single source of truth.
    const { locale, timeZone } = resolveDateTimeContextOptions();
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

    return renderDateTimeContext({
      formattedDateTime: dateTime,
      timeZone,
      weekday,
      month,
    });
  }
}
