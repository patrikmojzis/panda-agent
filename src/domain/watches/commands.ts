import {isRecord} from "../../lib/records.js";
import {normalizeToJsonValue, type JsonObject} from "../../lib/json.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import {parseWatchDetectorConfig, parseWatchSourceConfig} from "./config.js";
import {
  getWatchSchemaCatalog,
} from "./schema-catalog.js";
import type {WatchMutationService} from "./mutation-service.js";
import type {WatchStore} from "./store.js";
import type {
  ListWatchesStatus,
  WatchRecord,
  WatchRunHistoryRecord,
} from "./types.js";

export const WATCH_LIST_COMMAND_NAME = "watch.list";
export const WATCH_SHOW_COMMAND_NAME = "watch.show";
export const WATCH_RUNS_COMMAND_NAME = "watch.runs";
export const WATCH_CREATE_COMMAND_NAME = "watch.create";
export const WATCH_UPDATE_COMMAND_NAME = "watch.update";
export const WATCH_DISABLE_COMMAND_NAME = "watch.disable";

type WatchListStore = Pick<WatchStore, "listWatches">;
type WatchShowStore = Pick<WatchStore, "getWatch">;
type WatchRunsStore = Pick<WatchStore, "getWatch" | "listWatchRuns">;
type WatchCreateMutations = Pick<WatchMutationService, "createWatch">;
type WatchUpdateMutations = Pick<WatchMutationService, "updateWatch">;
type WatchDisableStore = Pick<WatchStore, "disableWatch">;

interface WatchCreateCommandInput {
  title: string;
  intervalMinutes: number;
  source: unknown;
  detector: unknown;
  enabled?: boolean;
}

interface WatchUpdateCommandInput {
  watchId: string;
  title?: string;
  intervalMinutes?: number;
  source?: unknown;
  detector?: unknown;
  enabled?: boolean;
}

interface WatchListCommandInput {
  status?: ListWatchesStatus;
  limit?: number;
}

interface WatchShowCommandInput {
  watchId: string;
}

interface WatchRunsCommandInput {
  watchId: string;
  limit?: number;
}

interface WatchDisableCommandInput {
  watchId: string;
  reason?: string;
}

export interface WatchCreateCommandOutput extends JsonObject {
  watchId: string;
}

export interface WatchUpdateCommandOutput extends JsonObject {
  watchId: string;
  updated: true;
}

export interface WatchDisableCommandOutput extends JsonObject {
  watchId: string;
  disabled: true;
}

export interface WatchListCommandOutput extends JsonObject {
  operation: "list";
  count: number;
}

export interface WatchShowCommandOutput extends JsonObject {
  operation: "show";
  watchId: string;
}

export interface WatchRunsCommandOutput extends JsonObject {
  operation: "runs";
  watchId: string;
  count: number;
}

const WATCH_SCHEMA_CATALOG = getWatchSchemaCatalog();

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return readRequiredString(value, label);
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return readPositiveInteger(value, label);
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }

  return value;
}

function readOptionalConfig(value: unknown): unknown {
  return value === undefined || value === null ? undefined : value;
}

function readOptionalListWatchesStatus(value: unknown): ListWatchesStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "enabled" || value === "disabled" || value === "all") {
    return value;
  }

  throw new Error("watch.list status must be enabled, disabled, or all.");
}

function parseWatchListCommandInput(input: unknown): WatchListCommandInput {
  if (!isRecord(input)) {
    throw new Error("watch.list input must be a JSON object.");
  }

  return {
    status: readOptionalListWatchesStatus(input.status),
    limit: readOptionalPositiveInteger(input.limit, "watch.list limit"),
  };
}

function parseWatchShowCommandInput(input: unknown): WatchShowCommandInput {
  if (!isRecord(input)) {
    throw new Error("watch.show input must be a JSON object.");
  }

  return {
    watchId: readRequiredString(input.watchId, "watch.show watchId"),
  };
}

function parseWatchRunsCommandInput(input: unknown): WatchRunsCommandInput {
  if (!isRecord(input)) {
    throw new Error("watch.runs input must be a JSON object.");
  }

  return {
    watchId: readRequiredString(input.watchId, "watch.runs watchId"),
    limit: readOptionalPositiveInteger(input.limit, "watch.runs limit"),
  };
}

function parseWatchCreateCommandInput(input: unknown): WatchCreateCommandInput {
  if (!isRecord(input)) {
    throw new Error("watch.create input must be a JSON object.");
  }

  return {
    title: readRequiredString(input.title, "watch.create title"),
    intervalMinutes: readPositiveInteger(input.intervalMinutes, "watch.create intervalMinutes"),
    source: input.source,
    detector: input.detector,
    enabled: readOptionalBoolean(input.enabled, "watch.create enabled"),
  };
}

function parseWatchUpdateCommandInput(input: unknown): WatchUpdateCommandInput {
  if (!isRecord(input)) {
    throw new Error("watch.update input must be a JSON object.");
  }

  return {
    watchId: readRequiredString(input.watchId, "watch.update watchId"),
    title: readOptionalString(input.title, "watch.update title"),
    intervalMinutes: readOptionalPositiveInteger(input.intervalMinutes, "watch.update intervalMinutes"),
    source: readOptionalConfig(input.source),
    detector: readOptionalConfig(input.detector),
    enabled: readOptionalBoolean(input.enabled, "watch.update enabled"),
  };
}

function parseWatchDisableCommandInput(input: unknown): WatchDisableCommandInput {
  if (!isRecord(input)) {
    throw new Error("watch.disable input must be a JSON object.");
  }

  return {
    watchId: readRequiredString(input.watchId, "watch.disable watchId"),
    reason: readOptionalString(input.reason, "watch.disable reason"),
  };
}

function assertWatchInSession(watch: WatchRecord, request: CommandRequest): void {
  if (watch.sessionId === request.scope.sessionId) {
    return;
  }

  throw new Error(`Watch ${watch.id} does not belong to this session.`);
}

function serializeWatchSummary(watch: WatchRecord): JsonObject {
  const statusReason: JsonObject = {};
  if (watch.lastError !== undefined) {
    statusReason[watch.enabled ? "lastError" : "disabledReason"] = watch.lastError;
  }

  return {
    watchId: watch.id,
    title: watch.title,
    enabled: watch.enabled,
    intervalMinutes: watch.intervalMinutes,
    sourceKind: watch.source.kind,
    detectorKind: watch.detector.kind,
    ...(watch.nextPollAt !== undefined ? {nextPollAt: watch.nextPollAt} : {}),
    ...(watch.disabledAt !== undefined ? {disabledAt: watch.disabledAt} : {}),
    ...statusReason,
    createdAt: watch.createdAt,
    updatedAt: watch.updatedAt,
  };
}

function serializeWatchDetail(watch: WatchRecord): JsonObject {
  return {
    ...serializeWatchSummary(watch),
    source: normalizeToJsonValue(watch.source),
    detector: normalizeToJsonValue(watch.detector),
    ...(watch.state !== undefined ? {state: watch.state} : {}),
  };
}

function serializeWatchRun(run: WatchRunHistoryRecord): JsonObject {
  return {
    runId: run.id,
    status: run.status,
    scheduledFor: run.scheduledFor,
    ...(run.resolvedThreadId !== undefined ? {resolvedThreadId: run.resolvedThreadId} : {}),
    ...(run.emittedEventId !== undefined ? {emittedEventId: run.emittedEventId} : {}),
    ...(run.error !== undefined ? {error: run.error} : {}),
    createdAt: run.createdAt,
    ...(run.startedAt !== undefined ? {startedAt: run.startedAt} : {}),
    ...(run.finishedAt !== undefined ? {finishedAt: run.finishedAt} : {}),
    ...(run.event
      ? {
        event: {
          eventId: run.event.id,
          eventKind: run.event.eventKind,
          summary: run.event.summary,
          dedupeKey: run.event.dedupeKey,
          createdAt: run.event.createdAt,
        },
      }
      : {}),
  };
}

export const watchCreateCommandDescriptor: CommandDescriptor = {
  name: WATCH_CREATE_COMMAND_NAME,
  summary: "Create a deterministic watch.",
  description:
    "Creates a session-scoped watch after validating and preflighting the source/detector config through Panda runtime policy.",
  usage: "panda watch create --title <text|@file|@-> --every <minutes> (--url <url> --value-path <path> --percent-change <n> [--label <text|@file|@->]|--source-json <json|@file|@-> --detector-json <json|@file|@-> [--source-kind <kind>] [--detector-kind <kind>]) [--disabled]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "title",
      description: "Watch title. Accepts literal text, @file, or @-.",
      required: true,
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "every",
      description: "Polling interval in minutes.",
      required: true,
      valueType: "number",
      valueName: "minutes",
    },
    {
      name: "source-json",
      description: "Watch source config JSON. Accepts inline JSON, @file, or @-. Use with --detector-json for advanced watch sources.",
      valueType: "json",
      valueName: "json|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "detector-json",
      description: "Watch detector config JSON. Accepts inline JSON, @file, or @-. Use with --source-json for advanced detectors.",
      valueType: "json",
      valueName: "json|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "url",
      description: "HTTP JSON scalar shortcut URL. Use with --value-path and --percent-change.",
      valueType: "string",
      valueName: "url",
    },
    {
      name: "value-path",
      description: "JSON value path for the HTTP JSON scalar shortcut.",
      valueType: "string",
      valueName: "path",
    },
    {
      name: "label",
      description: "Optional label for the HTTP JSON scalar value. Accepts literal text, @file, or @-.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "percent-change",
      description: "Percent threshold for the HTTP JSON scalar shortcut.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "source-kind",
      description: "Optional source kind assertion. The source JSON kind must match when provided.",
      valueType: "string",
      valueName: "kind",
    },
    {
      name: "detector-kind",
      description: "Optional detector kind assertion. The detector JSON kind must match when provided.",
      valueType: "string",
      valueName: "kind",
    },
    {
      name: "disabled",
      description: "Create the watch disabled.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "Structured JSON object containing title, intervalMinutes, source, detector, and optional enabled.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Create an HTTP JSON percent-change watch",
      command: "panda watch create --title PandaStars --every 60 --url https://api.github.com/repos/patrikmojzis/panda-agent --value-path stargazers_count --label stars --percent-change 10",
    },
    {
      description: "Create a watch from source and detector JSON files",
      command: "panda watch create --title BTC --every 5 --source-json @source.json --detector-json @detector.json",
    },
    {
      description: "Use JSON input",
      command: "cat watch.json | panda watch create --json @-",
    },
  ],
  requiredCapabilities: ["watch.create"],
  resultShape: {
    watchId: "string",
  },
  schemaCatalog: WATCH_SCHEMA_CATALOG,
};

export const watchListCommandDescriptor: CommandDescriptor = {
  name: WATCH_LIST_COMMAND_NAME,
  summary: "List watches for the current session.",
  description: "Lists session-scoped watch summaries. Use panda watch show <watch-id> for full source and detector configuration.",
  usage: "panda watch list [--status enabled|disabled|all] [--limit <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "status",
      description: "Optional status filter. Defaults to enabled.",
      valueType: "string",
      valueName: "enabled|disabled|all",
      defaultValue: "enabled",
    },
    {
      name: "limit",
      description: "Maximum number of watches to return. Defaults to 25.",
      valueType: "number",
      valueName: "n",
      defaultValue: 25,
    },
    {
      name: "json",
      description: "Structured JSON object containing optional status and limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List enabled watches",
      command: "panda watch list",
    },
    {
      description: "List every watch",
      command: "panda watch list --status all --limit 50",
    },
  ],
  requiredCapabilities: [WATCH_LIST_COMMAND_NAME],
  resultShape: {
    operation: "list",
    count: "number",
    watches: [{
      watchId: "string",
      title: "string",
      enabled: "boolean",
      sourceKind: "string",
      detectorKind: "string",
      disabledReason: "string|absent",
      lastError: "string|absent",
    }],
  },
};

export const watchShowCommandDescriptor: CommandDescriptor = {
  name: WATCH_SHOW_COMMAND_NAME,
  summary: "Show a watch for the current session.",
  description: "Shows one session-scoped watch, including full source and detector configuration for safe edits.",
  usage: "panda watch show <watch-id>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "watch-id",
      description: "Watch id to inspect.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "watch-id",
    },
    {
      name: "json",
      description: "Structured JSON object containing watchId.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Show watch details",
      command: "panda watch show watch_123",
    },
    {
      description: "Use JSON input",
      command: "panda watch show --json '{\"watchId\":\"watch_123\"}'",
    },
  ],
  requiredCapabilities: [WATCH_SHOW_COMMAND_NAME],
  resultShape: {
    operation: "show",
    watchId: "string",
    title: "string",
    source: "object",
    detector: "object",
  },
};

export const watchRunsCommandDescriptor: CommandDescriptor = {
  name: WATCH_RUNS_COMMAND_NAME,
  summary: "List recent watch runs for the current session.",
  description:
    "Lists compact run history for one session-scoped watch, including status, timestamps, error text, and emitted event summary when present. Raw event payloads are intentionally omitted.",
  usage: "panda watch runs <watch-id> [--limit <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "watch-id",
      description: "Watch id to inspect.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "watch-id",
    },
    {
      name: "limit",
      description: "Maximum number of runs to return. Defaults to 25.",
      valueType: "number",
      valueName: "n",
      defaultValue: 25,
    },
    {
      name: "json",
      description: "Structured JSON object containing watchId and optional limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List recent runs",
      command: "panda watch runs watch_123 --limit 10",
    },
    {
      description: "Use JSON input",
      command: "panda watch runs --json '{\"watchId\":\"watch_123\",\"limit\":10}'",
    },
  ],
  requiredCapabilities: [WATCH_RUNS_COMMAND_NAME],
  resultShape: {
    operation: "runs",
    watchId: "string",
    count: "number",
    runs: [{
      runId: "string",
      status: "claimed|running|no_change|changed|failed|disabled",
      scheduledFor: "number",
      event: "object|absent",
    }],
  },
};

export const watchUpdateCommandDescriptor: CommandDescriptor = {
  name: WATCH_UPDATE_COMMAND_NAME,
  summary: "Update a deterministic watch.",
  description:
    "Updates a session-scoped watch after validating and preflighting any changed source/detector config through Panda runtime policy.",
  usage: "panda watch update <watch-id> [--title <text|@file|@->] [--every <minutes>] [--url <url> --value-path <path> [--label <text|@file|@->]] [--percent-change <n>] [--source-json <json|@file|@->] [--detector-json <json|@file|@->] [--source-kind <kind>] [--detector-kind <kind>] [--enable|--disable]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "watch-id",
      description: "Watch id to update.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "watch-id",
    },
    {
      name: "title",
      description: "New watch title. Accepts literal text, @file, or @-.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "every",
      description: "New polling interval in minutes.",
      valueType: "number",
      valueName: "minutes",
    },
    {
      name: "source-json",
      description: "Replacement source config JSON. Accepts inline JSON, @file, or @-. Use for advanced watch sources.",
      valueType: "json",
      valueName: "json|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "detector-json",
      description: "Replacement detector config JSON. Accepts inline JSON, @file, or @-. Use for advanced detectors.",
      valueType: "json",
      valueName: "json|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "url",
      description: "Replacement HTTP JSON scalar shortcut URL. Use with --value-path.",
      valueType: "string",
      valueName: "url",
    },
    {
      name: "value-path",
      description: "Replacement JSON value path for the HTTP JSON scalar shortcut.",
      valueType: "string",
      valueName: "path",
    },
    {
      name: "label",
      description: "Optional replacement label for the HTTP JSON scalar value. Accepts literal text, @file, or @-.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "percent-change",
      description: "Replacement percent threshold for the HTTP JSON scalar shortcut.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "source-kind",
      description: "Optional source kind assertion. The source JSON kind must match when provided.",
      valueType: "string",
      valueName: "kind",
    },
    {
      name: "detector-kind",
      description: "Optional detector kind assertion. The detector JSON kind must match when provided.",
      valueType: "string",
      valueName: "kind",
    },
    {
      name: "enable",
      description: "Enable the watch.",
      valueType: "boolean",
    },
    {
      name: "disable",
      description: "Disable the watch.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "Structured JSON object containing watchId and any of title, intervalMinutes, source, detector, or enabled.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Update title and interval",
      command: "panda watch update watch_123 --title BTC --every 10",
    },
    {
      description: "Replace configs from files and disable",
      command: "panda watch update watch_123 --source-json @source.json --detector-json @detector.json --disable",
    },
    {
      description: "Replace HTTP JSON scalar source and percent threshold",
      command: "panda watch update watch_123 --url https://api.github.com/repos/patrikmojzis/panda-agent --value-path stargazers_count --percent-change 15",
    },
    {
      description: "Use JSON input",
      command: "panda watch update --json '{\"watchId\":\"watch_123\",\"enabled\":false}'",
    },
  ],
  requiredCapabilities: ["watch.update"],
  resultShape: {
    watchId: "string",
    updated: true,
  },
  schemaCatalog: WATCH_SCHEMA_CATALOG,
};

export const watchDisableCommandDescriptor: CommandDescriptor = {
  name: WATCH_DISABLE_COMMAND_NAME,
  summary: "Disable a watch.",
  description: "Disables a session-scoped watch without deleting its event history.",
  usage: "panda watch disable <watch-id> [--reason <text|@file|@->]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "watch-id",
      description: "Watch id to disable.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "watch-id",
    },
    {
      name: "reason",
      description: "Optional reason. Accepts literal text, @file, or @-.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "json",
      description: "Structured JSON object containing watchId and optional reason.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Disable with a reason",
      command: "panda watch disable watch_123 --reason \"not needed\"",
    },
    {
      description: "Use JSON input",
      command: "panda watch disable --json '{\"watchId\":\"watch_123\",\"reason\":\"not needed\"}'",
    },
  ],
  requiredCapabilities: ["watch.disable"],
  resultShape: {
    watchId: "string",
    disabled: true,
  },
};

export function createWatchListCommand(store: WatchListStore): RegisteredCommand {
  return {
    descriptor: watchListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<WatchListCommandOutput>> {
      const input = parseWatchListCommandInput(request.input);
      const watches = await store.listWatches({
        sessionId: request.scope.sessionId,
        status: input.status,
        limit: input.limit,
      });

      return {
        ok: true,
        command: WATCH_LIST_COMMAND_NAME,
        output: {
          operation: "list",
          count: watches.length,
          watches: watches.map(serializeWatchSummary),
        },
        summary: `Listed ${watches.length} watch${watches.length === 1 ? "" : "es"}.`,
      };
    },
  };
}

export function createWatchShowCommand(store: WatchShowStore): RegisteredCommand {
  return {
    descriptor: watchShowCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<WatchShowCommandOutput>> {
      const input = parseWatchShowCommandInput(request.input);
      const watch = await store.getWatch(input.watchId);
      assertWatchInSession(watch, request);

      return {
        ok: true,
        command: WATCH_SHOW_COMMAND_NAME,
        output: {
          operation: "show",
          ...serializeWatchDetail(watch),
          watchId: watch.id,
        },
        summary: `Showed watch ${watch.id}.`,
      };
    },
  };
}

export function createWatchRunsCommand(store: WatchRunsStore): RegisteredCommand {
  return {
    descriptor: watchRunsCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<WatchRunsCommandOutput>> {
      const input = parseWatchRunsCommandInput(request.input);
      const watch = await store.getWatch(input.watchId);
      assertWatchInSession(watch, request);
      const runs = await store.listWatchRuns({
        watchId: input.watchId,
        sessionId: request.scope.sessionId,
        limit: input.limit,
      });

      return {
        ok: true,
        command: WATCH_RUNS_COMMAND_NAME,
        output: {
          operation: "runs",
          watchId: watch.id,
          count: runs.length,
          runs: runs.map(serializeWatchRun),
        },
        summary: `Listed ${runs.length} run${runs.length === 1 ? "" : "s"} for watch ${watch.id}.`,
      };
    },
  };
}

export function createWatchCreateCommand(mutations: WatchCreateMutations): RegisteredCommand {
  return {
    descriptor: watchCreateCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<WatchCreateCommandOutput>> {
      const input = parseWatchCreateCommandInput(request.input);
      const watch = await mutations.createWatch({
        title: input.title,
        intervalMinutes: input.intervalMinutes,
        source: parseWatchSourceConfig(input.source),
        detector: parseWatchDetectorConfig(input.detector),
        enabled: input.enabled,
      }, {
        agentKey: request.scope.agentKey,
        sessionId: request.scope.sessionId,
        createdByIdentityId: request.scope.identityId,
      });

      return {
        ok: true,
        command: WATCH_CREATE_COMMAND_NAME,
        output: {
          watchId: watch.id,
        },
        summary: `Created watch ${watch.id}.`,
      };
    },
  };
}

export function createWatchUpdateCommand(mutations: WatchUpdateMutations): RegisteredCommand {
  return {
    descriptor: watchUpdateCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<WatchUpdateCommandOutput>> {
      const input = parseWatchUpdateCommandInput(request.input);
      const watch = await mutations.updateWatch({
        watchId: input.watchId,
        title: input.title,
        intervalMinutes: input.intervalMinutes,
        source: input.source === undefined ? undefined : parseWatchSourceConfig(input.source),
        detector: input.detector === undefined ? undefined : parseWatchDetectorConfig(input.detector),
        enabled: input.enabled,
      }, {
        agentKey: request.scope.agentKey,
        sessionId: request.scope.sessionId,
        createdByIdentityId: request.scope.identityId,
      });

      return {
        ok: true,
        command: WATCH_UPDATE_COMMAND_NAME,
        output: {
          watchId: watch.id,
          updated: true,
        },
        summary: `Updated watch ${watch.id}.`,
      };
    },
  };
}

export function createWatchDisableCommand(store: WatchDisableStore): RegisteredCommand {
  return {
    descriptor: watchDisableCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<WatchDisableCommandOutput>> {
      const input = parseWatchDisableCommandInput(request.input);
      const watch = await store.disableWatch({
        sessionId: request.scope.sessionId,
        watchId: input.watchId,
        reason: input.reason,
      });

      return {
        ok: true,
        command: WATCH_DISABLE_COMMAND_NAME,
        output: {
          watchId: watch.id,
          disabled: true,
        },
        summary: `Disabled watch ${watch.id}.`,
      };
    },
  };
}
