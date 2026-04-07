import type { LlmContext } from "../../agent-core/llm-context.js";
import { DateTimeContext, type DateTimeContextOptions } from "./datetime-context.js";
import { EnvironmentContext, type EnvironmentContextOptions } from "./environment-context.js";

export { DateTimeContext, type DateTimeContextOptions } from "./datetime-context.js";
export { EnvironmentContext, type EnvironmentContextOptions } from "./environment-context.js";

export interface DefaultPandaContextOptions {
  cwd?: EnvironmentContextOptions["cwd"];
  locale?: DateTimeContextOptions["locale"];
  timeZone?: DateTimeContextOptions["timeZone"];
  now?: DateTimeContextOptions["now"];
}

export function createDefaultPandaContexts(options: DefaultPandaContextOptions = {}): LlmContext[] {
  return [
    new DateTimeContext({
      locale: options.locale,
      timeZone: options.timeZone,
      now: options.now,
    }),
    new EnvironmentContext({
      cwd: options.cwd,
    }),
  ];
}
