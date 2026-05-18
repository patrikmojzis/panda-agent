import {isJsonValue, type JsonPrimitive, type JsonValue} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import type {
  WatchDetectorConfig,
  WatchHtmlFieldSelector,
  WatchHtmlResultConfig,
  WatchHttpBearerAuthConfig,
  WatchJsonResultConfig,
  WatchRequestHeaderConfig,
  WatchRowResultConfig,
  WatchSourceConfig,
} from "./types.js";

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Watch ${label} must be a JSON object.`);
  }

  return value;
}

function readString(value: unknown, label: string): string {
  return requireNonEmptyString(value, `Watch ${label} must not be empty.`);
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return readString(value, label);
}

function readBoolean(value: unknown, label: string): boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Watch ${label} must be a boolean.`);
  }

  return value;
}

function readPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Watch ${label} must be a positive integer.`);
  }

  return value;
}

function readPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Watch ${label} must be a positive number.`);
  }

  return value;
}

function readJsonValue(value: unknown, label: string): JsonValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isJsonValue(value)) {
    throw new Error(`Watch ${label} must be JSON-serializable.`);
  }

  return value;
}

function readRequiredJsonValue(value: unknown, label: string): JsonValue {
  const parsed = readJsonValue(value, label);
  if (parsed === undefined) {
    throw new Error(`Watch ${label} must be JSON-serializable.`);
  }

  return parsed;
}

function readJsonPrimitiveArray(value: unknown, label: string): readonly JsonPrimitive[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry): entry is JsonPrimitive => {
    return entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean";
  })) {
    throw new Error(`Watch ${label} must be a JSON primitive array.`);
  }

  return value;
}

function readOptionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Watch ${label} must be a string array.`);
  }

  return value.map((entry) => readString(entry, label));
}

function readStringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const record = readRecord(value, label);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, readString(entry, `${label} ${key}`)]),
  );
}

function readHeader(value: unknown): WatchRequestHeaderConfig {
  const header = readRecord(value, "request header");
  const name = readString(header.name, "request header name");
  const valueText = readOptionalString(header.value, "request header value");
  const credentialEnvKey = readOptionalString(header.credentialEnvKey, "request header credential env key");
  if (!valueText && !credentialEnvKey) {
    throw new Error("Watch request header must include value or credentialEnvKey.");
  }

  return {
    name,
    ...(valueText === undefined ? {} : {value: valueText}),
    ...(credentialEnvKey === undefined ? {} : {credentialEnvKey}),
  };
}

function readHeaders(value: unknown): readonly WatchRequestHeaderConfig[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Watch request headers must be an array.");
  }

  return value.map(readHeader);
}

function readBearerAuth(value: unknown): WatchHttpBearerAuthConfig | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const auth = readRecord(value, "auth config");
  if (auth.type !== "bearer") {
    throw new Error(`Unsupported watch auth type ${String(auth.type)}.`);
  }

  return {
    type: "bearer",
    credentialEnvKey: readString(auth.credentialEnvKey, "auth credential env key"),
  };
}

function readHtmlFieldSelector(value: unknown, label: string): WatchHtmlFieldSelector {
  const selector = readRecord(value, label);
  const attribute = readOptionalString(selector.attribute, `${label} attribute`);
  return {
    selector: readString(selector.selector, `${label} selector`),
    ...(attribute === undefined ? {} : {attribute}),
  };
}

function readHtmlFieldMap(value: unknown, label: string): Record<string, WatchHtmlFieldSelector> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const record = readRecord(value, label);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, readHtmlFieldSelector(entry, `${label} ${key}`)]),
  );
}

function parseRowResult(value: unknown): WatchRowResultConfig {
  const result = readRecord(value, "row result config");
  if (result.observation === "collection") {
    const summaryField = readOptionalString(result.summaryField, "row summary field");
    const fields = readOptionalStringArray(result.fields, "row fields");
    return {
      observation: "collection",
      itemIdField: readString(result.itemIdField, "row item id field"),
      itemCursorField: readString(result.itemCursorField, "row item cursor field"),
      ...(summaryField === undefined ? {} : {summaryField}),
      ...(fields === undefined ? {} : {fields}),
    };
  }
  if (result.observation === "scalar") {
    const label = readOptionalString(result.label, "row label");
    return {
      observation: "scalar",
      valueField: readString(result.valueField, "row value field"),
      ...(label === undefined ? {} : {label}),
    };
  }

  throw new Error(`Unsupported watch row result observation ${String(result.observation)}.`);
}

function parseJsonResult(value: unknown): WatchJsonResultConfig {
  const result = readRecord(value, "JSON result config");
  if (result.observation === "collection") {
    const itemsPath = readOptionalString(result.itemsPath, "JSON items path");
    const summaryPath = readOptionalString(result.summaryPath, "JSON summary path");
    const fieldPaths = readStringMap(result.fieldPaths, "JSON field paths");
    return {
      observation: "collection",
      ...(itemsPath === undefined ? {} : {itemsPath}),
      itemIdPath: readString(result.itemIdPath, "JSON item id path"),
      itemCursorPath: readString(result.itemCursorPath, "JSON item cursor path"),
      ...(summaryPath === undefined ? {} : {summaryPath}),
      ...(fieldPaths === undefined ? {} : {fieldPaths}),
    };
  }
  if (result.observation === "scalar") {
    const label = readOptionalString(result.label, "JSON label");
    return {
      observation: "scalar",
      valuePath: readString(result.valuePath, "JSON value path"),
      ...(label === undefined ? {} : {label}),
    };
  }
  if (result.observation === "snapshot") {
    const path = readOptionalString(result.path, "JSON snapshot path");
    return {
      observation: "snapshot",
      ...(path === undefined ? {} : {path}),
    };
  }

  throw new Error(`Unsupported watch JSON result observation ${String(result.observation)}.`);
}

function parseHtmlResult(value: unknown): WatchHtmlResultConfig {
  const result = readRecord(value, "HTML result config");
  if (result.observation === "collection") {
    const summary = result.summary === undefined || result.summary === null
      ? undefined
      : readHtmlFieldSelector(result.summary, "HTML summary");
    const fields = readHtmlFieldMap(result.fields, "HTML fields");
    return {
      observation: "collection",
      itemSelector: readString(result.itemSelector, "HTML item selector"),
      itemId: readHtmlFieldSelector(result.itemId, "HTML item id"),
      itemCursor: readHtmlFieldSelector(result.itemCursor, "HTML item cursor"),
      ...(summary === undefined ? {} : {summary}),
      ...(fields === undefined ? {} : {fields}),
    };
  }
  if (result.observation === "snapshot") {
    if (result.mode !== "readable_text" && result.mode !== "selector_text") {
      throw new Error(`Unsupported watch HTML snapshot mode ${String(result.mode)}.`);
    }
    const selector = readOptionalString(result.selector, "HTML snapshot selector");
    if (result.mode === "selector_text" && !selector) {
      throw new Error("Watch HTML snapshot selector must not be empty.");
    }

    return {
      observation: "snapshot",
      mode: result.mode,
      ...(selector === undefined ? {} : {selector}),
    };
  }

  throw new Error(`Unsupported watch HTML result observation ${String(result.observation)}.`);
}

export function parseWatchSourceConfig(value: unknown): WatchSourceConfig {
  const source = readRecord(value, "source config");

  switch (source.kind) {
    case "mongodb_query": {
      const operation = source.operation;
      if (operation !== "find" && operation !== "aggregate") {
        throw new Error(`Unsupported watch MongoDB operation ${String(operation)}.`);
      }
      const base = {
        kind: "mongodb_query" as const,
        credentialEnvKey: readString(source.credentialEnvKey, "MongoDB credential env key"),
        database: readString(source.database, "MongoDB database"),
        collection: readString(source.collection, "MongoDB collection"),
        limit: readPositiveInteger(source.limit, "MongoDB limit"),
        result: parseRowResult(source.result),
      };
      if (operation === "find") {
        return {
          ...base,
          operation,
          filter: readJsonValue(source.filter, "MongoDB filter"),
          projection: readJsonValue(source.projection, "MongoDB projection"),
          sort: readJsonValue(source.sort, "MongoDB sort"),
        };
      }

      return {
        ...base,
        operation,
        pipeline: readRequiredJsonValue(source.pipeline, "MongoDB pipeline"),
      };
    }

    case "sql_query":
      if (source.dialect !== "postgres" && source.dialect !== "mysql") {
        throw new Error(`Unsupported watch SQL dialect ${String(source.dialect)}.`);
      }
      return {
        kind: "sql_query",
        credentialEnvKey: readString(source.credentialEnvKey, "SQL credential env key"),
        dialect: source.dialect,
        query: readString(source.query, "SQL query"),
        parameters: readJsonPrimitiveArray(source.parameters, "SQL parameters"),
        result: parseRowResult(source.result),
      };

    case "http_json":
      if (source.method !== undefined && source.method !== "GET" && source.method !== "POST") {
        throw new Error(`Unsupported watch HTTP method ${String(source.method)}.`);
      }
      return {
        kind: "http_json",
        url: readString(source.url, "HTTP JSON url"),
        method: source.method as "GET" | "POST" | undefined,
        headers: readHeaders(source.headers),
        auth: readBearerAuth(source.auth),
        body: readOptionalString(source.body, "HTTP JSON body"),
        result: parseJsonResult(source.result),
      };

    case "http_html":
      return {
        kind: "http_html",
        url: readString(source.url, "HTTP HTML url"),
        headers: readHeaders(source.headers),
        auth: readBearerAuth(source.auth),
        result: parseHtmlResult(source.result),
      };

    case "imap_mailbox":
      return {
        kind: "imap_mailbox",
        host: readString(source.host, "IMAP host"),
        port: readPositiveInteger(source.port, "IMAP port"),
        secure: readBoolean(source.secure, "IMAP secure flag"),
        mailbox: readOptionalString(source.mailbox, "IMAP mailbox"),
        username: readOptionalString(source.username, "IMAP username"),
        usernameCredentialEnvKey: readOptionalString(
          source.usernameCredentialEnvKey,
          "IMAP username credential env key",
        ),
        passwordCredentialEnvKey: readString(
          source.passwordCredentialEnvKey,
          "IMAP password credential env key",
        ),
        maxMessages: readPositiveInteger(source.maxMessages, "IMAP max messages"),
      };

    default:
      throw new Error(`Unsupported watch source kind ${String(source.kind)}.`);
  }
}

export function parseWatchDetectorConfig(value: unknown): WatchDetectorConfig {
  const detector = readRecord(value, "detector config");

  switch (detector.kind) {
    case "new_items":
      return {
        kind: "new_items",
        maxItems: readPositiveInteger(detector.maxItems, "new items max items"),
      };

    case "snapshot_changed":
      return {
        kind: "snapshot_changed",
        excerptChars: readPositiveInteger(detector.excerptChars, "snapshot excerpt chars"),
      };

    case "percent_change":
      return {
        kind: "percent_change",
        percent: readPositiveNumber(detector.percent, "percent change threshold"),
      };

    default:
      throw new Error(`Unsupported watch detector kind ${String(detector.kind)}.`);
  }
}
