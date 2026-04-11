import {LlmContext} from "../../../kernel/agent/llm-context.js";
import {renderDateTimeContext} from "../../../prompts/contexts/datetime.js";

export interface DateTimeContextOptions {
  timeZone?: string;
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

export function resolveDateTimeContextOptions(
  options: Pick<DateTimeContextOptions, "timeZone"> = {},
): ResolvedDateTimeContextOptions {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    locale: resolved.locale,
    timeZone: options.timeZone ?? resolved.timeZone ?? "UTC",
  };
}

export class DateTimeContext extends LlmContext {
  override name = "Current DateTime";

  private readonly timeZone?: string;
  private readonly now?: Date | (() => Date);

  constructor(options: DateTimeContextOptions = {}) {
    super();
    this.timeZone = options.timeZone;
    this.now = options.now;
  }

  async getContent(): Promise<string> {
    const now = resolveNow(this.now);
    const { locale, timeZone } = resolveDateTimeContextOptions({
      timeZone: this.timeZone,
    });
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
