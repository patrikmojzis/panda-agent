import {resolveLocalDateTimeInfo} from "../../lib/dates.js";
import type {JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";

export const TIME_NOW_COMMAND_NAME = "time.now";

type TimeNowFormat = "iso" | "local" | "full";

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function readOptionalTimeZone(input: Record<string, unknown>): string | undefined {
  const raw = readOptionalString(input.timezone ?? input.timeZone, "time.now timezone");
  if (!raw) {
    return undefined;
  }

  try {
    return new Intl.DateTimeFormat(undefined, {timeZone: raw}).resolvedOptions().timeZone;
  } catch {
    throw new Error(`time.now timezone must be a valid IANA timezone, for example UTC or Europe/Bratislava.`);
  }
}

function readOptionalFormat(input: Record<string, unknown>): TimeNowFormat {
  const raw = readOptionalString(input.format, "time.now format");
  if (!raw) {
    return "full";
  }
  if (raw === "iso" || raw === "local" || raw === "full") {
    return raw;
  }

  throw new Error("time.now format must be iso, local, or full.");
}

function parseTimeNowInput(input: unknown): {timeZone?: string; format: TimeNowFormat} {
  if (!isRecord(input)) {
    throw new Error("time.now input must be a JSON object.");
  }
  const timeZone = readOptionalTimeZone(input);

  return {
    ...(timeZone ? {timeZone} : {}),
    format: readOptionalFormat(input),
  };
}

function selectTimeDisplay(output: JsonObject, format: TimeNowFormat): string {
  switch (format) {
    case "iso":
      return String(output.isoTimestamp);
    case "local":
      return String(output.formattedDateTime);
    case "full":
      return String(output.formattedDateTimeWithZone);
  }
}

export const timeNowCommandDescriptor: CommandDescriptor = {
  name: TIME_NOW_COMMAND_NAME,
  summary: "Read the current local date and time.",
  description: "Returns Panda core's current date/time for the requested timezone, plus ISO timestamp, weekday, and month.",
  usage: "panda time now [--timezone <iana>] [--format iso|local|full]",
  inputModes: ["flags", "json"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "timezone",
      description: "Optional IANA timezone, for example UTC or Europe/Bratislava.",
      valueType: "string",
      valueName: "iana",
    },
    {
      name: "format",
      description: "Preferred display field: iso, local, or full.",
      valueType: "string",
      valueName: "iso|local|full",
      defaultValue: "full",
    },
    {
      name: "json",
      description: "Structured JSON object with optional timezone/timeZone and format.",
      required: false,
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Read current time",
      command: "panda time now",
    },
    {
      description: "Read UTC as an ISO timestamp",
      command: "panda time now --timezone UTC --format iso",
    },
    {
      description: "Use JSON input",
      command: "panda time now --json '{\"timezone\":\"UTC\",\"format\":\"iso\"}'",
    },
  ],
  requiredCapabilities: [TIME_NOW_COMMAND_NAME],
  resultShape: {
    display: "string",
    format: "iso|local|full",
    formattedDateTime: "string",
    formattedDateTimeWithZone: "string",
    isoTimestamp: "string",
    timeZone: "string",
    weekday: "string",
    month: "string",
  },
};

export function createTimeNowCommand(options: {
  now?: () => Date;
} = {}): RegisteredCommand {
  return {
    descriptor: timeNowCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseTimeNowInput(request.input);
      const dateInfo = resolveLocalDateTimeInfo(options.now ? options.now() : new Date(), {
        ...(input.timeZone ? {timeZone: input.timeZone} : {}),
      });
      const output: JsonObject = {
        display: selectTimeDisplay(dateInfo, input.format),
        format: input.format,
        ...dateInfo,
      };

      return {
        ok: true,
        command: TIME_NOW_COMMAND_NAME,
        output,
        summary: `Current local date/time: ${output.formattedDateTimeWithZone}.`,
      };
    },
  };
}
