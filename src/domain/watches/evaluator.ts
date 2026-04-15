import {createHash} from "node:crypto";

import {ImapFlow} from "imapflow";
import {parseHTML} from "linkedom";
import {MongoClient} from "mongodb";
import {createConnection as createMysqlConnection} from "mysql2/promise";
import {Pool as PgPool} from "pg";

import type {CredentialResolver} from "../credentials/index.js";
import type {JsonObject, JsonValue} from "../../kernel/agent/types.js";
import {
    extractReadableContentFromHtml,
    type FetchImpl,
    fetchSafeHttpResource,
    type LookupHostname,
} from "../../personas/panda/tools/web-fetch.js";
import type {
    WatchCollectionItem,
    WatchCollectionObservation,
    WatchCursorValue,
    WatchEvaluationResult,
    WatchEventDraft,
    WatchHtmlFieldSelector,
    WatchHtmlResultConfig,
    WatchJsonResultConfig,
    WatchRecord,
    WatchRowCollectionResult,
    WatchRowScalarResult,
    WatchScalarObservation,
    WatchSnapshotObservation,
    WatchSourceEvaluation,
    WatchSourceKind,
} from "./types.js";

const SQL_WATCH_STATEMENT_TIMEOUT_MS = 5_000;
const SQL_WATCH_LOCK_TIMEOUT_MS = 500;
const SQL_WATCH_IDLE_TX_TIMEOUT_MS = 5_000;

export interface WatchEvaluationOptions {
  credentialResolver: CredentialResolver;
  credentialScope?: {
    agentKey: string;
    identityId?: string;
  };
  fetchImpl?: FetchImpl;
  lookupHostname?: LookupHostname;
  sourceResolvers?: Partial<Record<WatchSourceKind, WatchSourceResolver>>;
}

export type WatchSourceResolver = (
  watch: WatchRecord,
  options: Omit<WatchEvaluationOptions, "sourceResolvers">,
) => Promise<WatchSourceEvaluation>;

interface NewItemsState {
  kind: "new_items";
  identityToken?: string;
  bootstrapped: boolean;
  lastCursor?: WatchCursorValue;
  lastIds: string[];
}

interface SnapshotState {
  kind: "snapshot_changed";
  identityToken?: string;
  fingerprint: string;
  excerpt: string;
}

interface PercentChangeState {
  kind: "percent_change";
  identityToken?: string;
  baseline: number;
  lastValue: number;
}

interface HtmlQueryRoot {
  querySelector(selector: string): {
    getAttribute(name: string): string | null;
    textContent: string | null;
  } | null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function requireTrimmed(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty.`);
  }

  return trimmed;
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] as JsonValue)}`);
  return `{${entries.join(",")}}`;
}

function hashValue(value: JsonValue | string): string {
  const input = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

function normalizeUnknownJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeUnknownJson(entry));
  }

  if (typeof value === "object") {
    const asObject = value as Record<string, unknown>;
    if (typeof (asObject as {toHexString?: unknown}).toHexString === "function") {
      return String((asObject as {toHexString(): string}).toHexString());
    }

    const normalized: JsonObject = {};
    for (const [key, entry] of Object.entries(asObject)) {
      if (entry === undefined) {
        continue;
      }
      normalized[key] = normalizeUnknownJson(entry);
    }
    return normalized;
  }

  return String(value);
}

function parsePath(path: string): readonly string[] {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function readPath(value: JsonValue | undefined, path?: string): JsonValue | undefined {
  if (!path) {
    return value;
  }

  let cursor: JsonValue | undefined = value;
  for (const segment of parsePath(path)) {
    if (cursor === undefined || cursor === null) {
      return undefined;
    }

    if (Array.isArray(cursor)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= cursor.length) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }

    if (typeof cursor !== "object") {
      return undefined;
    }

    cursor = (cursor as JsonObject)[segment];
  }

  return cursor;
}

function readString(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeWhitespace(value);
    return normalized || undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function readNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function readCursorValue(value: JsonValue | undefined): WatchCursorValue | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return undefined;
}

function compareCursorValues(left: WatchCursorValue, right: WatchCursorValue): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  const leftText = String(left);
  const rightText = String(right);
  if (leftText === rightText) {
    return 0;
  }

  return leftText < rightText ? -1 : 1;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars).trimEnd();
}

function withIdentityToken<T extends JsonObject>(value: T, identityToken?: string): T & JsonObject {
  if (identityToken === undefined) {
    return value;
  }

  return {
    ...value,
    identityToken,
  };
}

function asStateObject(value: NewItemsState | SnapshotState | PercentChangeState): JsonObject {
  return value as unknown as JsonObject;
}

function asObject(value: JsonValue | undefined, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must resolve to an object.`);
  }

  return value;
}

function asArray(value: JsonValue | undefined, field: string): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must resolve to an array.`);
  }

  return value;
}

function buildCollectionState(
  items: readonly WatchCollectionItem[],
  identityToken?: string,
): NewItemsState {
  if (items.length === 0) {
    return withIdentityToken({
      kind: "new_items",
      bootstrapped: true,
      lastIds: [],
    }, identityToken) as NewItemsState;
  }

  const latestCursor = items[items.length - 1]!.cursor;
  const lastIds = items
    .filter((item) => compareCursorValues(item.cursor, latestCursor) === 0)
    .map((item) => item.id);

  return withIdentityToken({
    kind: "new_items",
    bootstrapped: true,
    lastCursor: latestCursor,
    lastIds,
  }, identityToken) as NewItemsState;
}

function formatPercentChange(value: number): string {
  const formatted = Math.abs(value).toFixed(2);
  return `${value >= 0 ? "+" : "-"}${formatted}%`;
}

function buildNewItemsEvent(items: readonly WatchCollectionItem[], maxItems: number): WatchEventDraft {
  const visibleItems = items.slice(-maxItems).reverse();
  const payloadItems = visibleItems.map((item) => {
    const normalized: JsonObject = {
      id: item.id,
      cursor: item.cursor,
    };
    if (item.summary) {
      normalized.summary = item.summary;
    }
    if (item.data) {
      normalized.data = item.data;
    }
    return normalized;
  });

  return {
    eventKind: "new_items",
    summary: `Detected ${items.length} new item${items.length === 1 ? "" : "s"}.`,
    dedupeKey: hashValue({
      kind: "new_items",
      ids: items.map((item) => item.id),
      lastCursor: items.at(-1)?.cursor ?? null,
    }),
    payload: {
      totalNewItems: items.length,
      items: payloadItems,
    },
  };
}

function evaluateNewItems(
  observation: WatchCollectionObservation,
  detector: WatchRecord["detector"] & {kind: "new_items"},
  previousState: JsonObject | undefined,
  identityToken?: string,
): WatchEvaluationResult {
  const items = [...observation.items].sort((left, right) => {
    const cursorComparison = compareCursorValues(left.cursor, right.cursor);
    if (cursorComparison !== 0) {
      return cursorComparison;
    }

    return left.id.localeCompare(right.id);
  });
  const state = previousState as Partial<NewItemsState> | undefined;
  const identityChanged = state?.identityToken !== identityToken;
  const nextState = buildCollectionState(items, identityToken);

  if (!state?.bootstrapped || identityChanged) {
    return {
      changed: false,
      nextState: asStateObject(nextState),
    };
  }

  const lastIds = new Set(state.lastIds ?? []);
  let newItems: WatchCollectionItem[];
  if (state.lastCursor === undefined) {
    newItems = items;
  } else {
    newItems = items.filter((item) => {
      const comparison = compareCursorValues(item.cursor, state.lastCursor as WatchCursorValue);
      return comparison > 0 || (comparison === 0 && !lastIds.has(item.id));
    });
  }

  if (newItems.length === 0) {
    return {
      changed: false,
      nextState: asStateObject(nextState),
    };
  }

  return {
    changed: true,
    nextState: asStateObject(nextState),
    event: buildNewItemsEvent(newItems, Math.max(1, detector.maxItems ?? 10)),
  };
}

function evaluateSnapshotChanged(
  observation: WatchSnapshotObservation,
  detector: WatchRecord["detector"] & {kind: "snapshot_changed"},
  previousState: JsonObject | undefined,
  identityToken?: string,
): WatchEvaluationResult {
  const excerptChars = Math.max(40, detector.excerptChars ?? 240);
  const excerpt = truncateText(observation.text, excerptChars);
  const fingerprint = hashValue(observation.text);
  const state = previousState as Partial<SnapshotState> | undefined;
  const nextState = withIdentityToken({
    kind: "snapshot_changed",
    fingerprint,
    excerpt,
  }, identityToken) as SnapshotState;

  if (!state?.fingerprint || state.identityToken !== identityToken) {
    return {
      changed: false,
      nextState: asStateObject(nextState),
    };
  }

  if (state.fingerprint === fingerprint) {
    return {
      changed: false,
      nextState: asStateObject(nextState),
    };
  }

  return {
    changed: true,
    nextState: asStateObject(nextState),
    event: {
      eventKind: "snapshot_changed",
      summary: "Observed content changed.",
      dedupeKey: fingerprint,
      payload: {
        previousExcerpt: state.excerpt ?? "",
        currentExcerpt: excerpt,
        fingerprint,
      },
    },
  };
}

function evaluatePercentChange(
  observation: WatchScalarObservation,
  detector: WatchRecord["detector"] & {kind: "percent_change"},
  previousState: JsonObject | undefined,
  identityToken?: string,
): WatchEvaluationResult {
  const state = previousState as Partial<PercentChangeState> | undefined;
  const current = observation.value;

  if (!Number.isFinite(current)) {
    throw new Error("Scalar watch observations must be finite numbers.");
  }

  if (state?.baseline === undefined || state.identityToken !== identityToken) {
    return {
      changed: false,
      nextState: asStateObject(withIdentityToken({
        kind: "percent_change",
        baseline: current,
        lastValue: current,
      }, identityToken) as PercentChangeState),
    };
  }

  const baseline = state.baseline;
  const delta = current - baseline;
  const percentChange = baseline === 0
    ? (current === 0 ? 0 : Number.POSITIVE_INFINITY)
    : Math.abs((delta / baseline) * 100);
  const nextState = withIdentityToken({
    kind: "percent_change",
    baseline,
    lastValue: current,
  }, identityToken) as PercentChangeState;

  if (percentChange < detector.percent) {
    return {
      changed: false,
      nextState: asStateObject(nextState),
    };
  }

  return {
    changed: true,
    nextState: asStateObject(withIdentityToken({
      kind: "percent_change",
      baseline: current,
      lastValue: current,
    }, identityToken) as PercentChangeState),
    event: {
      eventKind: "percent_change",
      summary: `${observation.label ?? "Value"} moved ${formatPercentChange(delta === 0 ? 0 : (delta / Math.abs(baseline || current || 1)) * 100)} from baseline.`,
      dedupeKey: hashValue({
        kind: "percent_change",
        baseline,
        current,
        threshold: detector.percent,
      }),
      payload: {
        label: observation.label ?? null,
        baseline,
        current,
        delta,
        percentChange,
        thresholdPercent: detector.percent,
      },
    },
  };
}

function extractRowCollectionObservation(
  rows: readonly JsonObject[],
  result: WatchRowCollectionResult,
): WatchCollectionObservation {
  const items = rows.map((row) => {
    const id = readString(readPath(row, result.itemIdField));
    if (!id) {
      throw new Error(`Collection result field ${result.itemIdField} did not resolve to a string.`);
    }

    const cursor = readCursorValue(readPath(row, result.itemCursorField));
    if (cursor === undefined) {
      throw new Error(`Collection result field ${result.itemCursorField} did not resolve to a cursor value.`);
    }

    const data: JsonObject = {};
    if (result.fields && result.fields.length > 0) {
      for (const field of result.fields) {
        const value = readPath(row, field);
        if (value !== undefined) {
          data[field] = value;
        }
      }
    } else {
      for (const [key, value] of Object.entries(row)) {
        if (value === undefined) {
          continue;
        }
        data[key] = value;
      }
    }

    const item: WatchCollectionItem = {
      id,
      cursor,
    };
    const summary = result.summaryField ? readString(readPath(row, result.summaryField)) : undefined;
    if (summary) {
      item.summary = summary;
    }
    if (Object.keys(data).length > 0) {
      item.data = data;
    }
    return item;
  });

  return {
    kind: "collection",
    items,
  };
}

function extractRowScalarObservation(
  rows: readonly JsonObject[],
  result: WatchRowScalarResult,
): WatchScalarObservation {
  const firstRow = rows[0];
  if (!firstRow) {
    throw new Error("Scalar query returned no rows.");
  }

  const value = readNumber(readPath(firstRow, result.valueField));
  if (value === undefined) {
    throw new Error(`Scalar result field ${result.valueField} did not resolve to a number.`);
  }

  return {
    kind: "scalar",
    value,
    ...(result.label ? {label: result.label} : {}),
  };
}

function extractJsonObservation(
  payload: JsonValue,
  result: WatchJsonResultConfig,
): WatchSourceEvaluation {
  switch (result.observation) {
    case "collection": {
      const itemsValue = result.itemsPath ? readPath(payload, result.itemsPath) : payload;
      const items = asArray(itemsValue, result.itemsPath ?? "response");
      const normalizedItems: WatchCollectionItem[] = items.map((entry) => {
        const row = asObject(entry, "collection item");
        const id = readString(readPath(row, result.itemIdPath));
        if (!id) {
          throw new Error(`JSON collection itemIdPath ${result.itemIdPath} did not resolve to a string.`);
        }
        const cursor = readCursorValue(readPath(row, result.itemCursorPath));
        if (cursor === undefined) {
          throw new Error(`JSON collection itemCursorPath ${result.itemCursorPath} did not resolve to a cursor.`);
        }

        const item: WatchCollectionItem = {
          id,
          cursor,
        };
        const summary = result.summaryPath ? readString(readPath(row, result.summaryPath)) : undefined;
        if (summary) {
          item.summary = summary;
        }

        if (result.fieldPaths && Object.keys(result.fieldPaths).length > 0) {
          const data: JsonObject = {};
          for (const [field, path] of Object.entries(result.fieldPaths)) {
            const value = readPath(row, path);
            if (value !== undefined) {
              data[field] = value;
            }
          }
          if (Object.keys(data).length > 0) {
            item.data = data;
          }
        } else {
          item.data = row;
        }

        return item;
      });

      return {
        observation: {
          kind: "collection",
          items: normalizedItems,
        },
      };
    }

    case "scalar": {
      const value = readNumber(readPath(payload, result.valuePath));
      if (value === undefined) {
        throw new Error(`JSON scalar valuePath ${result.valuePath} did not resolve to a number.`);
      }

      return {
        observation: {
          kind: "scalar",
          value,
          ...(result.label ? {label: result.label} : {}),
        },
      };
    }

    case "snapshot": {
      const value = result.path ? readPath(payload, result.path) : payload;
      const text = typeof value === "string"
        ? value
        : stableStringify(normalizeUnknownJson(value) as JsonValue);
      return {
        observation: {
          kind: "snapshot",
          text,
        },
      };
    }
  }
}

function readHtmlField(root: HtmlQueryRoot, field: WatchHtmlFieldSelector): string | undefined {
  const element = root.querySelector(field.selector);
  if (!element) {
    return undefined;
  }

  if (field.attribute) {
    const value = element.getAttribute(field.attribute);
    return value ? normalizeWhitespace(value) : undefined;
  }

  return normalizeWhitespace(element.textContent ?? "") || undefined;
}

function extractHtmlObservation(
  html: string,
  url: string,
  result: WatchHtmlResultConfig,
): WatchSourceEvaluation {
  if (result.observation === "snapshot") {
    if (result.mode === "readable_text") {
      return {
        observation: {
          kind: "snapshot",
          text: extractReadableContentFromHtml({
            html,
            url,
          }).content,
        },
      };
    }

    const {document} = parseHTML(html);
    const text = result.selector
      ? normalizeWhitespace(document.querySelector(result.selector)?.textContent ?? "")
      : normalizeWhitespace(document.body?.textContent ?? "");
    if (!text) {
      throw new Error("HTML snapshot selector did not produce any text.");
    }

    return {
      observation: {
        kind: "snapshot",
        text,
      },
    };
  }

  const {document} = parseHTML(html);
  const items = Array.from(document.querySelectorAll(result.itemSelector)).map((element) => {
    const root = element as unknown as HtmlQueryRoot;
    const id = readHtmlField(root, result.itemId);
    if (!id) {
      throw new Error(`HTML collection id selector ${result.itemId.selector} did not resolve to a value.`);
    }

    const cursor = readHtmlField(root, result.itemCursor);
    if (!cursor) {
      throw new Error(`HTML collection cursor selector ${result.itemCursor.selector} did not resolve to a value.`);
    }

    const item: WatchCollectionItem = {
      id,
      cursor,
    };
    const summary = result.summary ? readHtmlField(root, result.summary) : undefined;
    if (summary) {
      item.summary = summary;
    }

    if (result.fields && Object.keys(result.fields).length > 0) {
      const data: JsonObject = {};
      for (const [field, selector] of Object.entries(result.fields)) {
        const value = readHtmlField(root, selector);
        if (value !== undefined) {
          data[field] = value;
        }
      }
      if (Object.keys(data).length > 0) {
        item.data = data;
      }
    }

    return item;
  });

  return {
    observation: {
      kind: "collection",
      items,
    },
  };
}

async function resolveCredentialValue(
  watch: WatchRecord,
  resolver: CredentialResolver,
  scope: WatchEvaluationOptions["credentialScope"],
  envKey: string,
): Promise<string> {
  const agentKey = scope?.agentKey
    ?? ((watch as WatchRecord & {agentKey?: string}).agentKey?.trim() || undefined);
  if (!agentKey) {
    throw new Error(`Watch ${watch.id} is missing agent scope for credential ${envKey}.`);
  }

  const identityId = scope?.identityId
    ?? ((watch as WatchRecord & {identityId?: string}).identityId?.trim() || undefined);
  const resolved = await resolver.resolveCredential(envKey, {
    agentKey,
    identityId,
  });
  if (!resolved) {
    throw new Error(`Missing credential ${envKey} for watch ${watch.id}.`);
  }

  return resolved.value;
}

async function resolveHttpHeaders(
  watch: WatchRecord,
  options: Omit<WatchEvaluationOptions, "sourceResolvers">,
  headers: readonly {name: string; value?: string; credentialEnvKey?: string}[] = [],
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const header of headers) {
    const name = requireTrimmed("header name", header.name);
    if (header.credentialEnvKey) {
      resolved[name] = await resolveCredentialValue(
        watch,
        options.credentialResolver,
        options.credentialScope,
        header.credentialEnvKey,
      );
      continue;
    }
    if (header.value) {
      resolved[name] = header.value;
    }
  }

  return resolved;
}

function validateReadOnlySqlQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("SQL watch query must not be empty.");
  }

  const withoutTrailingSemicolon = trimmed.endsWith(";")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error("SQL watch query must be a single statement.");
  }

  const normalized = withoutTrailingSemicolon.replace(/--.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error("SQL watch query must start with SELECT or WITH.");
  }

  const forbidden = /\b(insert|update|delete|alter|drop|create|truncate|grant|revoke|copy|merge|replace|call|do|set|use|commit|rollback|begin)\b/i;
  if (forbidden.test(normalized)) {
    throw new Error("SQL watch query must be read-only.");
  }

  return withoutTrailingSemicolon;
}

async function resolveMongoSource(
  watch: WatchRecord,
  options: Omit<WatchEvaluationOptions, "sourceResolvers">,
): Promise<WatchSourceEvaluation> {
  const source = watch.source;
  if (source.kind !== "mongodb_query") {
    throw new Error("Expected mongodb_query source.");
  }

  const uri = await resolveCredentialValue(watch, options.credentialResolver, options.credentialScope, source.credentialEnvKey);
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const collection = client.db(source.database).collection(source.collection);
    const rows = source.operation === "find"
      ? await collection
          .find(
            normalizeUnknownJson(source.filter ?? {}) as Record<string, unknown>,
            {
              projection: source.projection === undefined
                ? undefined
                : normalizeUnknownJson(source.projection) as Record<string, unknown>,
              sort: source.sort === undefined
                ? undefined
                : normalizeUnknownJson(source.sort) as Record<string, 1 | -1>,
            },
          )
          .limit(Math.max(1, source.limit ?? 100))
          .toArray()
      : await collection
          .aggregate(
            asArray(normalizeUnknownJson(source.pipeline), "Mongo pipeline") as Record<string, unknown>[],
          )
          .limit(Math.max(1, source.limit ?? 100))
          .toArray();
    const normalizedRows = rows.map((row) => asObject(normalizeUnknownJson(row), "Mongo row"));

    return source.result.observation === "collection"
      ? {observation: extractRowCollectionObservation(normalizedRows, source.result)}
      : {observation: extractRowScalarObservation(normalizedRows, source.result)};
  } finally {
    await client.close();
  }
}

async function resolveSqlSource(
  watch: WatchRecord,
  _options: Omit<WatchEvaluationOptions, "sourceResolvers">,
): Promise<WatchSourceEvaluation> {
  const options = _options;
  const source = watch.source;
  if (source.kind !== "sql_query") {
    throw new Error("Expected sql_query source.");
  }

  const connectionString = await resolveCredentialValue(
    watch,
    options.credentialResolver,
    options.credentialScope,
    source.credentialEnvKey,
  );
  const query = validateReadOnlySqlQuery(source.query);
  const parameters = source.parameters ? [...source.parameters] : [];

  let normalizedRows: JsonObject[];
  if (source.dialect === "postgres") {
    const pool = new PgPool({
      connectionString,
      max: 1,
    });
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN READ ONLY");
      inTransaction = true;
      await client.query(`SET LOCAL statement_timeout = '${SQL_WATCH_STATEMENT_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${SQL_WATCH_LOCK_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${SQL_WATCH_IDLE_TX_TIMEOUT_MS}ms'`);
      const result = await client.query(query, parameters);
      await client.query("COMMIT");
      inTransaction = false;
      normalizedRows = result.rows.map((row) => asObject(normalizeUnknownJson(row), "SQL row"));
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  } else {
    const connection = await createMysqlConnection(connectionString);
    let inTransaction = false;
    try {
      await connection.query("START TRANSACTION READ ONLY");
      inTransaction = true;
      const [rows] = await connection.query(query, parameters);
      await connection.query("COMMIT");
      inTransaction = false;
      normalizedRows = Array.isArray(rows)
        ? rows.map((row) => asObject(normalizeUnknownJson(row), "SQL row"))
        : [];
    } catch (error) {
      if (inTransaction) {
        await connection.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      await connection.end();
    }
  }

  return source.result.observation === "collection"
    ? {observation: extractRowCollectionObservation(normalizedRows, source.result)}
    : {observation: extractRowScalarObservation(normalizedRows, source.result)};
}

async function resolveHttpJsonSource(
  watch: WatchRecord,
  options: Omit<WatchEvaluationOptions, "sourceResolvers">,
): Promise<WatchSourceEvaluation> {
  const source = watch.source;
  if (source.kind !== "http_json") {
    throw new Error("Expected http_json source.");
  }

  const headers = await resolveHttpHeaders(watch, options, source.headers);
  if (source.auth?.type === "bearer") {
    headers.Authorization = `Bearer ${await resolveCredentialValue(
      watch,
      options.credentialResolver,
      options.credentialScope,
      source.auth.credentialEnvKey,
    )}`;
  }
  if (source.body && !headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json";
  }

  const response = await fetchSafeHttpResource(source.url, {
    fetchImpl: options.fetchImpl,
    lookupHostname: options.lookupHostname,
    method: source.method ?? "GET",
    headers,
    body: source.body,
  });
  const payload = normalizeUnknownJson(JSON.parse(response.bodyText));
  return extractJsonObservation(payload, source.result);
}

async function resolveHttpHtmlSource(
  watch: WatchRecord,
  options: Omit<WatchEvaluationOptions, "sourceResolvers">,
): Promise<WatchSourceEvaluation> {
  const source = watch.source;
  if (source.kind !== "http_html") {
    throw new Error("Expected http_html source.");
  }

  const headers = await resolveHttpHeaders(watch, options, source.headers);
  if (source.auth?.type === "bearer") {
    headers.Authorization = `Bearer ${await resolveCredentialValue(
      watch,
      options.credentialResolver,
      options.credentialScope,
      source.auth.credentialEnvKey,
    )}`;
  }

  const response = await fetchSafeHttpResource(source.url, {
    fetchImpl: options.fetchImpl,
    lookupHostname: options.lookupHostname,
    headers,
  });
  return extractHtmlObservation(response.bodyText, response.finalUrl, source.result);
}

async function resolveImapMailboxSource(
  watch: WatchRecord,
  options: Omit<WatchEvaluationOptions, "sourceResolvers">,
): Promise<WatchSourceEvaluation> {
  const source = watch.source;
  if (source.kind !== "imap_mailbox") {
    throw new Error("Expected imap_mailbox source.");
  }

  const user = source.usernameCredentialEnvKey
    ? await resolveCredentialValue(
      watch,
      options.credentialResolver,
      options.credentialScope,
      source.usernameCredentialEnvKey,
    )
    : source.username;
  if (!user) {
    throw new Error(`Watch ${watch.id} needs an IMAP username or usernameCredentialEnvKey.`);
  }

  const client = new ImapFlow({
    host: source.host,
    port: source.port ?? (source.secure === false ? 143 : 993),
    secure: source.secure ?? true,
    logger: false,
    auth: {
      user,
      pass: await resolveCredentialValue(
        watch,
        options.credentialResolver,
        options.credentialScope,
        source.passwordCredentialEnvKey,
      ),
    },
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(source.mailbox ?? "INBOX", {readOnly: true});
    try {
      const mailbox = client.mailbox;
      if (!mailbox) {
        throw new Error("IMAP mailbox did not open correctly.");
      }
      const identityToken = String(mailbox.uidValidity);
      const previousState = watch.state as Partial<NewItemsState> | undefined;
      const lastSeenUid =
        previousState?.kind === "new_items"
        && previousState.identityToken === identityToken
        && typeof previousState.lastCursor === "number"
        && Number.isFinite(previousState.lastCursor)
          ? previousState.lastCursor
          : undefined;

      if (!mailbox.exists) {
        return {
          identityToken,
          observation: {
            kind: "collection",
            items: [],
          },
        };
      }

      const items: WatchCollectionItem[] = [];

      if (lastSeenUid === undefined) {
        const latest = await client.fetchOne(String(mailbox.exists), {
          uid: true,
          envelope: true,
          internalDate: true,
        });
        if (latest) {
          const fromList = latest.envelope?.from?.map((entry) => {
            if (entry.name && entry.address) {
              return `${entry.name} <${entry.address}>`;
            }

            return entry.address ?? entry.name ?? "";
          }).filter(Boolean) ?? [];
          const summary = normalizeWhitespace(latest.envelope?.subject ?? "") || undefined;
          const data: JsonObject = {};
          if (summary) {
            data.subject = summary;
          }
          if (fromList.length > 0) {
            data.from = fromList.join(", ");
          }
          if (latest.internalDate) {
            data.internalDate = new Date(latest.internalDate).toISOString();
          }

          items.push({
            id: String(latest.uid),
            cursor: latest.uid,
            ...(summary ? {summary} : {}),
            ...(Object.keys(data).length > 0 ? {data} : {}),
          });
        }
      } else {
        const range = `${Math.floor(lastSeenUid) + 1}:*`;
        for await (const message of client.fetch(range, {
          uid: true,
          envelope: true,
          internalDate: true,
        }, {
          uid: true,
        })) {
          const fromList = message.envelope?.from?.map((entry) => {
            if (entry.name && entry.address) {
              return `${entry.name} <${entry.address}>`;
            }

            return entry.address ?? entry.name ?? "";
          }).filter(Boolean) ?? [];
          const summary = normalizeWhitespace(message.envelope?.subject ?? "") || undefined;
          const data: JsonObject = {};
          if (summary) {
            data.subject = summary;
          }
          if (fromList.length > 0) {
            data.from = fromList.join(", ");
          }
          if (message.internalDate) {
            data.internalDate = new Date(message.internalDate).toISOString();
          }

          items.push({
            id: String(message.uid),
            cursor: message.uid,
            ...(summary ? {summary} : {}),
            ...(Object.keys(data).length > 0 ? {data} : {}),
          });
        }
      }

      return {
        identityToken,
        observation: {
          kind: "collection",
          items,
        },
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export const defaultWatchSourceResolvers: Record<WatchSourceKind, WatchSourceResolver> = {
  mongodb_query: resolveMongoSource,
  sql_query: resolveSqlSource,
  http_json: resolveHttpJsonSource,
  http_html: resolveHttpHtmlSource,
  imap_mailbox: resolveImapMailboxSource,
};

export async function evaluateWatch(
  watch: WatchRecord,
  options: WatchEvaluationOptions,
): Promise<WatchEvaluationResult> {
  const resolver = options.sourceResolvers?.[watch.source.kind] ?? defaultWatchSourceResolvers[watch.source.kind];
  if (!resolver) {
    throw new Error(`Unsupported watch source ${watch.source.kind}.`);
  }

  const resolved = await resolver(watch, {
    credentialResolver: options.credentialResolver,
    fetchImpl: options.fetchImpl,
    lookupHostname: options.lookupHostname,
  });

  switch (watch.detector.kind) {
    case "new_items":
      if (resolved.observation.kind !== "collection") {
        throw new Error(`Watch detector ${watch.detector.kind} requires a collection observation.`);
      }
      return evaluateNewItems(
        resolved.observation,
        watch.detector,
        watch.state,
        resolved.identityToken,
      );

    case "snapshot_changed":
      if (resolved.observation.kind !== "snapshot") {
        throw new Error(`Watch detector ${watch.detector.kind} requires a snapshot observation.`);
      }
      return evaluateSnapshotChanged(
        resolved.observation,
        watch.detector,
        watch.state,
        resolved.identityToken,
      );

    case "percent_change":
      if (resolved.observation.kind !== "scalar") {
        throw new Error(`Watch detector ${watch.detector.kind} requires a scalar observation.`);
      }
      return evaluatePercentChange(
        resolved.observation,
        watch.detector,
        watch.state,
        resolved.identityToken,
      );
  }
}

export {validateReadOnlySqlQuery};
