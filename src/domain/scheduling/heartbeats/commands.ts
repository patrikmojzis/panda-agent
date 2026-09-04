import type {JsonObject} from "../../../lib/json.js";
import {isRecord} from "../../../lib/records.js";
import {CommandStructuredError} from "../../commands/errors.js";
import type {CommandDescriptor, RegisteredCommand} from "../../commands/types.js";
import type {SessionStore} from "../../sessions/store.js";
import type {SessionHeartbeatRecord} from "../../sessions/types.js";
import type {HeartbeatCadenceBounds} from "./config.js";

export const HEARTBEAT_SHOW_COMMAND_NAME = "heartbeat.show";
export const HEARTBEAT_SET_COMMAND_NAME = "heartbeat.set";

type HeartbeatCommandStore = Pick<SessionStore, "getHeartbeat" | "updateHeartbeatConfig">;

function invalidInput(message: string): never {
  throw new CommandStructuredError("invalid_input", message, {retryable: false});
}

function requireInput(input: unknown, command: string, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(input)) invalidInput(`${command} input must be a JSON object.`);
  for (const field of Object.keys(input)) {
    if (!fields.includes(field)) invalidInput(`${command} does not accept ${field}.`);
  }
  return input;
}

function serializeHeartbeat(heartbeat: SessionHeartbeatRecord, bounds: HeartbeatCadenceBounds): JsonObject {
  return {
    sessionId: heartbeat.sessionId,
    enabled: heartbeat.enabled,
    everyMinutes: heartbeat.everyMinutes,
    nextFireAt: new Date(heartbeat.nextFireAt).toISOString(),
    lastCadenceChangeReason: heartbeat.lastCadenceChangeReason ?? null,
    configRevision: heartbeat.configRevision,
    ...bounds,
  };
}

function summarizeHeartbeat(heartbeat: SessionHeartbeatRecord, bounds: HeartbeatCadenceBounds): string {
  return [
    `Heartbeat interval: ${heartbeat.everyMinutes} minutes; ${heartbeat.enabled ? "enabled" : "heartbeats remain disabled"}.`,
    `Next tick: ${new Date(heartbeat.nextFireAt).toISOString()}${heartbeat.enabled ? "" : " (inactive while disabled)"}.`,
    `Allowed interval: ${bounds.minEveryMinutes}-${bounds.maxEveryMinutes} minutes.`,
    `Last cadence change reason: ${heartbeat.lastCadenceChangeReason ?? "none"}.`,
  ].join(" ");
}

const resultShape: JsonObject = {
  sessionId: "string",
  enabled: "boolean",
  everyMinutes: "number",
  nextFireAt: "ISO timestamp; no wake occurs while disabled",
  lastCadenceChangeReason: "string|null",
  configRevision: "number",
  minEveryMinutes: "number",
  maxEveryMinutes: "number",
};

export const heartbeatShowCommandDescriptor: CommandDescriptor = {
  name: HEARTBEAT_SHOW_COMMAND_NAME,
  summary: "Show your session's heartbeat cadence.",
  description: "Shows the current interval, enabled state, next heartbeat time, last cadence change reason, and operator-defined interval limits. Scope supplies the session; do not pass a session id.",
  usage: "panda heartbeat show",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [],
  examples: [{description: "Inspect the current cadence and permitted limits", command: "panda heartbeat show"}],
  requiredCapabilities: [HEARTBEAT_SHOW_COMMAND_NAME],
  resultShape,
};

export const heartbeatSetCommandDescriptor: CommandDescriptor = {
  name: HEARTBEAT_SET_COMMAND_NAME,
  summary: "Adjust your session's ongoing heartbeat interval.",
  description: "Shorten the interval when frequent reassessment helps; lengthen it when work is quiet, after checking live commitments. The interval persists until changed. Setting the same interval is a no-op. A change cannot cancel a heartbeat already being delivered; busy sessions skip ticks. Use schedules for specific timed work and watches for external changes. Operator-defined limits apply. Disabled heartbeats stay disabled. Scope supplies the session; do not pass a session id.",
  usage: "panda heartbeat set --every <duration> --reason <text>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {name: "every", description: "Positive whole minutes, optionally suffixed with m or h (15m, 4h). JSON uses everyMinutes.", required: true, valueType: "string", valueName: "duration"},
    {name: "reason", description: "Brief single-line reason for changing cadence (up to 500 characters).", required: true, valueType: "string", valueName: "text"},
    {name: "json", description: "Canonical input: {everyMinutes: number, reason: string}.", valueType: "json"},
  ],
  examples: [
    {description: "Reassess active work more frequently", command: 'panda heartbeat set --every 15m --reason "Active investigation"'},
    {description: "Back off during a quiet period", command: 'panda heartbeat set --every 4h --reason "Quiet period"'},
    {description: "Use structured input", command: `panda heartbeat set --json '{"everyMinutes":60,"reason":"Normal cadence"}'`},
  ],
  requiredCapabilities: [HEARTBEAT_SET_COMMAND_NAME],
  resultShape,
};

export function createHeartbeatShowCommand(sessions: HeartbeatCommandStore, bounds: HeartbeatCadenceBounds): RegisteredCommand {
  return {
    descriptor: heartbeatShowCommandDescriptor,
    async execute(request) {
      requireInput(request.input, HEARTBEAT_SHOW_COMMAND_NAME, []);
      const heartbeat = await sessions.getHeartbeat(request.scope.sessionId);
      if (!heartbeat) invalidInput("This session has no heartbeat configuration.");
      return {
        ok: true,
        command: HEARTBEAT_SHOW_COMMAND_NAME,
        output: serializeHeartbeat(heartbeat, bounds),
        summary: summarizeHeartbeat(heartbeat, bounds),
      };
    },
  };
}

export function createHeartbeatSetCommand(sessions: HeartbeatCommandStore, bounds: HeartbeatCadenceBounds): RegisteredCommand {
  return {
    descriptor: heartbeatSetCommandDescriptor,
    async execute(request) {
      const input = requireInput(request.input, HEARTBEAT_SET_COMMAND_NAME, ["everyMinutes", "reason"]);
      if (typeof input.everyMinutes !== "number" || !Number.isSafeInteger(input.everyMinutes)
        || input.everyMinutes < bounds.minEveryMinutes || input.everyMinutes > bounds.maxEveryMinutes) {
        invalidInput(`heartbeat.set everyMinutes must be an integer between ${bounds.minEveryMinutes} and ${bounds.maxEveryMinutes}.`);
      }
      if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500 || /[\u0000-\u001f\u007f]/.test(input.reason)) {
        invalidInput("heartbeat.set reason must be a non-empty single line of at most 500 characters without control characters.");
      }
      const heartbeat = await sessions.updateHeartbeatConfig({
        sessionId: request.scope.sessionId,
        everyMinutes: input.everyMinutes,
        lastCadenceChangeReason: input.reason.trim(),
      });
      return {
        ok: true,
        command: HEARTBEAT_SET_COMMAND_NAME,
        output: serializeHeartbeat(heartbeat, bounds),
        summary: summarizeHeartbeat(heartbeat, bounds),
      };
    },
  };
}
