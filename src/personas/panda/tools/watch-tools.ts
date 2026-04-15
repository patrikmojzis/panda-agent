import {z} from "zod";

import type {JsonValue} from "../../../kernel/agent/types.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {RunContext} from "../../../kernel/agent/run-context.js";
import {Tool} from "../../../kernel/agent/tool.js";
import type {WatchStore} from "../../../domain/watches/store.js";
import type {WatchDetectorConfig, WatchSourceConfig} from "../../../domain/watches/types.js";
import type {PandaSessionContext} from "../types.js";
import {readPandaCurrentInputIdentityId} from "./context.js";

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

const watchSourceSchema = z.union([
  mongoFindSourceSchema,
  mongoAggregateSourceSchema,
  sqlSourceSchema,
  httpJsonSourceSchema,
  httpHtmlSourceSchema,
  imapMailboxSourceSchema,
]) as z.ZodType<WatchSourceConfig>;

const watchDetectorSchema = z.union([
  z.object({
    kind: z.literal("new_items"),
    maxItems: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("snapshot_changed"),
    excerptChars: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("percent_change"),
    percent: z.number().positive(),
  }),
]) as z.ZodType<WatchDetectorConfig>;

function readWatchScope(context: unknown): {
  sessionId: string;
  createdByIdentityId?: string;
} {
  if (
    !context
    || typeof context !== "object"
    || Array.isArray(context)
    || typeof (context as {sessionId?: unknown}).sessionId !== "string"
    || !(context as {sessionId: string}).sessionId.trim()
  ) {
    throw new ToolError("Watch tools require sessionId in the Panda session context.");
  }

  return {
    sessionId: (context as {sessionId: string}).sessionId,
    createdByIdentityId: readPandaCurrentInputIdentityId(context),
  };
}

function wrapWatchError(error: unknown): never {
  if (error instanceof ToolError) {
    throw error;
  }

  const message = error instanceof Error ? error.message : String(error);
  throw new ToolError(message);
}

export interface WatchToolOptions {
  store: WatchStore;
}

export class WatchCreateTool<TContext = PandaSessionContext>
  extends Tool<typeof WatchCreateTool.schema, TContext> {
  static schema = z.object({
    title: z.string().trim().min(1),
    intervalMinutes: z.number().int().positive(),
    source: watchSourceSchema,
    detector: watchDetectorSchema,
    enabled: z.boolean().optional(),
  });

  name = "watch_create";
  description =
    "Create a deterministic watch that polls a source, compares results in code, and wakes Panda only when a real change event exists.";
  schema = WatchCreateTool.schema;

  constructor(private readonly options: WatchToolOptions) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.title === "string" ? args.title : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof WatchCreateTool.schema>,
    run: RunContext<TContext>,
  ): Promise<{watchId: string}> {
    try {
      const scope = readWatchScope(run.context);
      const watch = await this.options.store.createWatch({
        ...scope,
        title: args.title,
        intervalMinutes: args.intervalMinutes,
        source: args.source,
        detector: args.detector,
        enabled: args.enabled,
      });
      return {
        watchId: watch.id,
      };
    } catch (error) {
      wrapWatchError(error);
    }
  }
}

export class WatchUpdateTool<TContext = PandaSessionContext>
  extends Tool<typeof WatchUpdateTool.schema, TContext> {
  static schema = z.object({
    watchId: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    intervalMinutes: z.number().int().positive().optional(),
    source: watchSourceSchema.optional(),
    detector: watchDetectorSchema.optional(),
    enabled: z.boolean().optional(),
  });

  name = "watch_update";
  description =
    "Update an existing watch in the current session.";
  schema = WatchUpdateTool.schema;

  constructor(private readonly options: WatchToolOptions) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.watchId === "string" ? args.watchId : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof WatchUpdateTool.schema>,
    run: RunContext<TContext>,
  ): Promise<{watchId: string; updated: true}> {
    try {
      const scope = readWatchScope(run.context);
      const watch = await this.options.store.updateWatch({
        ...scope,
        watchId: args.watchId,
        title: args.title,
        intervalMinutes: args.intervalMinutes,
        source: args.source,
        detector: args.detector,
        enabled: args.enabled,
      });
      return {
        watchId: watch.id,
        updated: true,
      };
    } catch (error) {
      wrapWatchError(error);
    }
  }
}

export class WatchDisableTool<TContext = PandaSessionContext>
  extends Tool<typeof WatchDisableTool.schema, TContext> {
  static schema = z.object({
    watchId: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional(),
  });

  name = "watch_disable";
  description = "Disable a watch without deleting its event history.";
  schema = WatchDisableTool.schema;

  constructor(private readonly options: WatchToolOptions) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.watchId === "string" ? args.watchId : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof WatchDisableTool.schema>,
    run: RunContext<TContext>,
  ): Promise<{watchId: string; disabled: true}> {
    try {
      const scope = readWatchScope(run.context);
      const watch = await this.options.store.disableWatch({
        ...scope,
        watchId: args.watchId,
        reason: args.reason,
      });
      return {
        watchId: watch.id,
        disabled: true,
      };
    } catch (error) {
      wrapWatchError(error);
    }
  }
}
