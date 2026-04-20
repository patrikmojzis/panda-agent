import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import {resolveLocalDateTimeInfo} from "../../lib/dates.js";
import {isRecord} from "../../lib/records.js";
import {buildTextToolPayload} from "./shared.js";

export class CurrentDateTimeTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof CurrentDateTimeTool.schema, TContext> {
  static schema = z.object({});

  name = "current_datetime";
  description =
    "Read the host's current local date and time. Use this when exact now matters instead of relying on stale prompt context.";
  schema = CurrentDateTimeTool.schema;

  override formatCall(): string {
    return "read current date and time";
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!isRecord(details) || typeof details.formattedDateTime !== "string" || typeof details.timeZone !== "string") {
      return super.formatResult(message);
    }
    return `${details.formattedDateTime} (${details.timeZone})`;
  }

  async handle(
    _args: z.output<typeof CurrentDateTimeTool.schema>,
    _run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const details = resolveLocalDateTimeInfo();
    return buildTextToolPayload([
      `Current local date and time: ${details.formattedDateTime}`,
      `Timezone: ${details.timeZone}`,
      `ISO timestamp: ${details.isoTimestamp}`,
      `Weekday: ${details.weekday}`,
      `Month: ${details.month}`,
    ].join("\n"), details);
  }
}
