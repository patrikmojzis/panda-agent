import { DateTimeContext, type DateTimeContextOptions } from "./datetime-context.js";

export { DateTimeContext, type DateTimeContextOptions } from "./datetime-context.js";

export function createDefaultPandaContexts(options: DateTimeContextOptions = {}): DateTimeContext[] {
  return [new DateTimeContext(options)];
}
