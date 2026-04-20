import {z} from "zod";

import type {
    WatchDetectorConfig,
    WatchEventKind,
    WatchSourceConfig,
    WatchSourceKind,
} from "../../domain/watches/types.js";
import {isRecord} from "../../lib/records.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {formatParameters} from "../../kernel/agent/helpers/schema.js";
import type {JsonObject, JsonValue} from "../../kernel/agent/types.js";

// Temporary context-budget escape hatch for watch creation and updates.
//
// Why this exists:
// - The current tool transport injects full JSON Schema into model context.
// - The watch source/detector unions are unusually large and burn thousands of tokens.
// - We only need the detailed branch schema on demand, not on every turn.
//
// Why this should not spread:
// - This is not the preferred pattern for normal tools.
// - If more tools need schema side-loading, the real fix is transport-level:
//   CLI-style help, lazy schema discovery, or provider-native tool introspection.
const WATCH_SOURCE_KINDS = [
  "mongodb_query",
  "sql_query",
  "http_json",
  "http_html",
  "imap_mailbox",
] as const satisfies readonly WatchSourceKind[];

const WATCH_DETECTOR_KINDS = [
  "new_items",
  "snapshot_changed",
  "percent_change",
] as const satisfies readonly WatchEventKind[];

const watchSourceKindSchema = z.enum(WATCH_SOURCE_KINDS);
const watchDetectorKindSchema = z.enum(WATCH_DETECTOR_KINDS);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const requestHeaderSchema = z.object({
  name: z.string().trim().min(1),
  value: z.string().trim().min(1).optional(),
  credentialEnvKey: z.string().trim().min(1).optional(),
});

const htmlFieldSelectorSchema = z.object({
  selector: z.string().trim().min(1),
  attribute: z.string().trim().min(1).optional(),
});

const rowCollectionResultSchema = z.object({
  observation: z.literal("collection"),
  itemIdField: z.string().trim().min(1),
  itemCursorField: z.string().trim().min(1),
  summaryField: z.string().trim().min(1).optional(),
  fields: z.array(z.string().trim().min(1)).optional(),
});

const rowScalarResultSchema = z.object({
  observation: z.literal("scalar"),
  valueField: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
});

const rowResultSchema = z.union([
  rowCollectionResultSchema,
  rowScalarResultSchema,
]);

const jsonCollectionResultSchema = z.object({
  observation: z.literal("collection"),
  itemsPath: z.string().trim().min(1).optional(),
  itemIdPath: z.string().trim().min(1),
  itemCursorPath: z.string().trim().min(1),
  summaryPath: z.string().trim().min(1).optional(),
  fieldPaths: z.record(z.string(), z.string().trim().min(1)).optional(),
});

const jsonScalarResultSchema = z.object({
  observation: z.literal("scalar"),
  valuePath: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
});

const jsonSnapshotResultSchema = z.object({
  observation: z.literal("snapshot"),
  path: z.string().trim().min(1).optional(),
});

const jsonResultSchema = z.union([
  jsonCollectionResultSchema,
  jsonScalarResultSchema,
  jsonSnapshotResultSchema,
]);

const htmlCollectionResultSchema = z.object({
  observation: z.literal("collection"),
  itemSelector: z.string().trim().min(1),
  itemId: htmlFieldSelectorSchema,
  itemCursor: htmlFieldSelectorSchema,
  summary: htmlFieldSelectorSchema.optional(),
  fields: z.record(z.string(), htmlFieldSelectorSchema).optional(),
});

const htmlSnapshotResultSchema = z.object({
  observation: z.literal("snapshot"),
  mode: z.enum(["readable_text", "selector_text"]),
  selector: z.string().trim().min(1).optional(),
});

const htmlResultSchema = z.union([
  htmlCollectionResultSchema,
  htmlSnapshotResultSchema,
]);

const mongoFindSourceSchema = z.object({
  kind: z.literal("mongodb_query"),
  credentialEnvKey: z.string().trim().min(1),
  database: z.string().trim().min(1),
  collection: z.string().trim().min(1),
  operation: z.literal("find"),
  filter: jsonValueSchema.optional(),
  projection: jsonValueSchema.optional(),
  sort: jsonValueSchema.optional(),
  limit: z.number().int().positive().optional(),
  result: rowResultSchema,
});

const mongoAggregateSourceSchema = z.object({
  kind: z.literal("mongodb_query"),
  credentialEnvKey: z.string().trim().min(1),
  database: z.string().trim().min(1),
  collection: z.string().trim().min(1),
  operation: z.literal("aggregate"),
  pipeline: jsonValueSchema,
  limit: z.number().int().positive().optional(),
  result: rowResultSchema,
});

const mongodbSourceSchema = z.union([
  mongoFindSourceSchema,
  mongoAggregateSourceSchema,
]);

const sqlSourceSchema = z.object({
  kind: z.literal("sql_query"),
  credentialEnvKey: z.string().trim().min(1),
  dialect: z.enum(["postgres", "mysql"]),
  query: z.string().trim().min(1),
  parameters: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  result: rowResultSchema,
});

const httpJsonSourceSchema = z.object({
  kind: z.literal("http_json"),
  url: z.string().trim().url(),
  method: z.enum(["GET", "POST"]).optional(),
  headers: z.array(requestHeaderSchema).optional(),
  auth: z.object({
    type: z.literal("bearer"),
    credentialEnvKey: z.string().trim().min(1),
  }).optional(),
  body: z.string().optional(),
  result: jsonResultSchema,
});

const httpHtmlSourceSchema = z.object({
  kind: z.literal("http_html"),
  url: z.string().trim().url(),
  headers: z.array(requestHeaderSchema).optional(),
  auth: z.object({
    type: z.literal("bearer"),
    credentialEnvKey: z.string().trim().min(1),
  }).optional(),
  result: htmlResultSchema,
});

const imapMailboxSourceSchema = z.object({
  kind: z.literal("imap_mailbox"),
  host: z.string().trim().min(1),
  port: z.number().int().positive().optional(),
  secure: z.boolean().optional(),
  mailbox: z.string().trim().min(1).optional(),
  username: z.string().trim().min(1).optional(),
  usernameCredentialEnvKey: z.string().trim().min(1).optional(),
  passwordCredentialEnvKey: z.string().trim().min(1),
  maxMessages: z.number().int().positive().optional(),
}).refine((value) => Boolean(value.username || value.usernameCredentialEnvKey), {
  message: "imap_mailbox requires either username or usernameCredentialEnvKey.",
});

const watchSourceSchemaByKind = {
  mongodb_query: mongodbSourceSchema,
  sql_query: sqlSourceSchema,
  http_json: httpJsonSourceSchema,
  http_html: httpHtmlSourceSchema,
  imap_mailbox: imapMailboxSourceSchema,
} as const satisfies Record<WatchSourceKind, z.ZodType<WatchSourceConfig>>;

const watchSourceExampleByKind = {
  mongodb_query: {
    kind: "mongodb_query",
    credentialEnvKey: "MONGO_URI",
    database: "app",
    collection: "registrations",
    operation: "find",
    sort: {createdAt: -1},
    limit: 100,
    result: {
      observation: "collection",
      itemIdField: "_id",
      itemCursorField: "createdAt",
      summaryField: "email",
      fields: ["email", "plan", "createdAt"],
    },
  },
  sql_query: {
    kind: "sql_query",
    credentialEnvKey: "DATABASE_URL",
    dialect: "postgres",
    query: "select id, created_at, customer_email from charges order by created_at desc limit 100",
    result: {
      observation: "collection",
      itemIdField: "id",
      itemCursorField: "created_at",
      summaryField: "customer_email",
      fields: ["customer_email", "created_at"],
    },
  },
  http_json: {
    kind: "http_json",
    url: "https://api.example.com/btc-price",
    auth: {
      type: "bearer",
      credentialEnvKey: "COINAPI_TOKEN",
    },
    result: {
      observation: "scalar",
      valuePath: "price_usd",
      label: "BTC/USD",
    },
  },
  http_html: {
    kind: "http_html",
    url: "https://example.com/properties",
    result: {
      observation: "collection",
      itemSelector: ".listing",
      itemId: {selector: "a", attribute: "href"},
      itemCursor: {selector: "time", attribute: "datetime"},
      summary: {selector: ".price"},
    },
  },
  imap_mailbox: {
    kind: "imap_mailbox",
    host: "imap.example.com",
    username: "alice@example.com",
    passwordCredentialEnvKey: "IMAP_PASSWORD",
    mailbox: "INBOX",
    maxMessages: 50,
  },
} as const satisfies Record<WatchSourceKind, JsonValue>;

const watchSourceNotesByKind = {
  mongodb_query: [
    "Use credentialEnvKey for the Mongo connection string.",
    "operation may be find or aggregate; the schema covers both.",
    "result supports collection or scalar observations from rows.",
  ],
  sql_query: [
    "SQL watches are single-statement only and run read-only.",
    "Set dialect explicitly to postgres or mysql.",
    "result supports collection or scalar observations from rows.",
  ],
  http_json: [
    "Use auth.credentialEnvKey or headers[].credentialEnvKey for secrets.",
    "result supports collection, scalar, or snapshot observations from JSON.",
    "Negative array indices are rejected; sort/filter upstream and use [0].",
  ],
  http_html: [
    "Use auth.credentialEnvKey or headers[].credentialEnvKey for secrets.",
    "result supports collection extraction or snapshot text detection.",
    "Selectors are validated before persistence via preflight evaluation.",
  ],
  imap_mailbox: [
    "Provide username directly or via usernameCredentialEnvKey.",
    "passwordCredentialEnvKey is always required.",
    "IMAP watches are read-only and track mailbox identity with uidValidity.",
  ],
} as const satisfies Record<WatchSourceKind, readonly string[]>;

const newItemsDetectorSchema = z.object({
  kind: z.literal("new_items"),
  maxItems: z.number().int().positive().optional(),
});

const snapshotChangedDetectorSchema = z.object({
  kind: z.literal("snapshot_changed"),
  excerptChars: z.number().int().positive().optional(),
});

const percentChangeDetectorSchema = z.object({
  kind: z.literal("percent_change"),
  percent: z.number().positive(),
});

const watchDetectorSchemaByKind = {
  new_items: newItemsDetectorSchema,
  snapshot_changed: snapshotChangedDetectorSchema,
  percent_change: percentChangeDetectorSchema,
} as const satisfies Record<WatchEventKind, z.ZodType<WatchDetectorConfig>>;

const watchDetectorExampleByKind = {
  new_items: {
    kind: "new_items",
    maxItems: 20,
  },
  snapshot_changed: {
    kind: "snapshot_changed",
    excerptChars: 240,
  },
  percent_change: {
    kind: "percent_change",
    percent: 10,
  },
} as const satisfies Record<WatchEventKind, JsonValue>;

const watchDetectorNotesByKind = {
  new_items: [
    "Use for collection observations when you want newly seen rows/items.",
    "maxItems caps how many new items are surfaced in one event.",
  ],
  snapshot_changed: [
    "Use for snapshot observations like page text or JSON blobs.",
    "excerptChars trims the stored excerpt when a change is detected.",
  ],
  percent_change: [
    "Use for scalar numeric observations.",
    "percent is required and must be greater than zero.",
  ],
} as const satisfies Record<WatchEventKind, readonly string[]>;

const compactWatchSourceEnvelopeSchema = z.looseObject({
  kind: watchSourceKindSchema,
});

const compactWatchDetectorEnvelopeSchema = z.looseObject({
  kind: watchDetectorKindSchema,
});

function throwIssues(prefix: string, issues: readonly string[]): never {
  const message = issues.length === 1
    ? `${prefix}: ${issues[0] ?? "Invalid arguments"}`
    : `${prefix}: ${issues.join("; ")}`;
  throw new ToolError(message, {details: [...issues]});
}

function parseKindEnvelope<TKind extends string>(options: {
  value: unknown;
  schema: z.ZodType<{kind: TKind}>;
  missingKindMessage: string;
  invalidPrefix: string;
}): TKind {
  const parsed = options.schema.safeParse(options.value);
  if (!parsed.success) {
    throwIssues(
      options.invalidPrefix,
      parsed.error.issues.map((issue) => issue.message),
    );
  }

  return parsed.data.kind;
}

export function parseWatchSourceConfig(value: unknown): WatchSourceConfig {
  const kind = parseKindEnvelope({
    value,
    schema: compactWatchSourceEnvelopeSchema,
    missingKindMessage: "Watch source requires a kind.",
    invalidPrefix: "Invalid watch source",
  });
  const schema = watchSourceSchemaByKind[kind];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throwIssues(
      `Invalid watch source for ${kind}`,
      parsed.error.issues.map((issue) => issue.message),
    );
  }
  return parsed.data;
}

export function parseWatchDetectorConfig(value: unknown): WatchDetectorConfig {
  const kind = parseKindEnvelope({
    value,
    schema: compactWatchDetectorEnvelopeSchema,
    missingKindMessage: "Watch detector requires a kind.",
    invalidPrefix: "Invalid watch detector",
  });
  const schema = watchDetectorSchemaByKind[kind];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throwIssues(
      `Invalid watch detector for ${kind}`,
      parsed.error.issues.map((issue) => issue.message),
    );
  }
  return parsed.data;
}

export function getCompactWatchSourceEnvelopeSchema() {
  return compactWatchSourceEnvelopeSchema;
}

export function getCompactWatchDetectorEnvelopeSchema() {
  return compactWatchDetectorEnvelopeSchema;
}

export function getWatchSourceKindSchema() {
  return watchSourceKindSchema;
}

export function getWatchDetectorKindSchema() {
  return watchDetectorKindSchema;
}

export function getWatchSourceSchema(kind: WatchSourceKind): JsonObject {
  return formatParameters(watchSourceSchemaByKind[kind]);
}

export function getWatchDetectorSchema(kind: WatchEventKind): JsonObject {
  return formatParameters(watchDetectorSchemaByKind[kind]);
}

export function getWatchSourceExample(kind: WatchSourceKind): JsonValue {
  return watchSourceExampleByKind[kind];
}

export function getWatchDetectorExample(kind: WatchEventKind): JsonValue {
  return watchDetectorExampleByKind[kind];
}

export function getWatchSourceNotes(kind: WatchSourceKind): string[] {
  return [...watchSourceNotesByKind[kind]];
}

export function getWatchDetectorNotes(kind: WatchEventKind): string[] {
  return [...watchDetectorNotesByKind[kind]];
}

export function requireSchemaGetSelection(value: unknown): {
  sourceKind?: WatchSourceKind;
  detectorKind?: WatchEventKind;
} {
  if (!isRecord(value)) {
    throw new ToolError("watch_schema_get requires an object.");
  }

  const sourceKind = value.sourceKind;
  const detectorKind = value.detectorKind;
  if (sourceKind === undefined && detectorKind === undefined) {
    throw new ToolError("watch_schema_get requires sourceKind, detectorKind, or both.");
  }

  const parsed = z.object({
    sourceKind: watchSourceKindSchema.optional(),
    detectorKind: watchDetectorKindSchema.optional(),
  }).safeParse(value);

  if (!parsed.success) {
    throwIssues(
      "Invalid watch schema request",
      parsed.error.issues.map((issue) => issue.message),
    );
  }

  return parsed.data;
}
