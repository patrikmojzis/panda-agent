import {z} from "zod";

import type {WatchStore} from "../../domain/watches/store.js";
import type {WatchMutationService} from "../../domain/watches/mutation-service.js";
import type {WatchEventKind, WatchSourceKind} from "../../domain/watches/types.js";
import {readCurrentInputIdentityId} from "../../app/runtime/panda-path-context.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import {
    getCompactWatchDetectorEnvelopeSchema,
    getCompactWatchSourceEnvelopeSchema,
    getWatchDetectorExample,
    getWatchDetectorKindSchema,
    getWatchDetectorNotes,
    getWatchDetectorSchema,
    getWatchSourceExample,
    getWatchSourceKindSchema,
    getWatchSourceNotes,
    getWatchSourceSchema,
    parseWatchDetectorConfig,
    parseWatchSourceConfig,
    requireSchemaGetSelection,
} from "./watch-schema-catalog.js";
import {rethrowAsToolError} from "./shared.js";

function readWatchScope(context: unknown): {
  agentKey: string;
  sessionId: string;
  createdByIdentityId?: string;
} {
  if (
    !context
    || typeof context !== "object"
    || Array.isArray(context)
    || typeof (context as {agentKey?: unknown}).agentKey !== "string"
    || !(context as {agentKey: string}).agentKey.trim()
    || typeof (context as {sessionId?: unknown}).sessionId !== "string"
    || !(context as {sessionId: string}).sessionId.trim()
  ) {
    throw new ToolError("Watch tools require agentKey and sessionId in the runtime session context.");
  }

  return {
    agentKey: (context as {agentKey: string}).agentKey,
    sessionId: (context as {sessionId: string}).sessionId,
    createdByIdentityId: readCurrentInputIdentityId(context),
  };
}

export interface WatchToolOptions {
  mutations: WatchMutationService;
  store: WatchStore;
}

const compactWatchSourceEnvelopeSchema = getCompactWatchSourceEnvelopeSchema();
const compactWatchDetectorEnvelopeSchema = getCompactWatchDetectorEnvelopeSchema();

export class WatchSchemaGetTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof WatchSchemaGetTool.schema, TContext> {
  static schema = z.object({
    sourceKind: getWatchSourceKindSchema().optional(),
    detectorKind: getWatchDetectorKindSchema().optional(),
  }).superRefine((value, ctx) => {
    if (value.sourceKind === undefined && value.detectorKind === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "watch_schema_get requires sourceKind, detectorKind, or both.",
      });
    }
  });

  name = "watch_schema_get";
  description =
    "Return the exact detailed schema, one example, and short notes for a specific watch source kind, detector kind, or both. Call this before watch_create or watch_update once you know the chosen kinds.";
  schema = WatchSchemaGetTool.schema;

  override formatCall(args: Record<string, unknown>): string {
    const sourceKind = typeof args.sourceKind === "string" ? args.sourceKind : null;
    const detectorKind = typeof args.detectorKind === "string" ? args.detectorKind : null;
    return [sourceKind, detectorKind].filter(Boolean).join(" + ") || super.formatCall(args);
  }

  async handle(
    args: z.output<typeof WatchSchemaGetTool.schema>,
    _run: RunContext<TContext>,
  ): Promise<{
    source?: {
      kind: WatchSourceKind;
      schema: ReturnType<typeof getWatchSourceSchema>;
      example: ReturnType<typeof getWatchSourceExample>;
      notes: string[];
    };
    detector?: {
      kind: WatchEventKind;
      schema: ReturnType<typeof getWatchDetectorSchema>;
      example: ReturnType<typeof getWatchDetectorExample>;
      notes: string[];
    };
  }> {
    const request = requireSchemaGetSelection(args);
    return {
      ...(request.sourceKind
        ? {
          source: {
            kind: request.sourceKind,
            schema: getWatchSourceSchema(request.sourceKind),
            example: getWatchSourceExample(request.sourceKind),
            notes: getWatchSourceNotes(request.sourceKind),
          },
        }
        : {}),
      ...(request.detectorKind
        ? {
          detector: {
            kind: request.detectorKind,
            schema: getWatchDetectorSchema(request.detectorKind),
            example: getWatchDetectorExample(request.detectorKind),
            notes: getWatchDetectorNotes(request.detectorKind),
          },
        }
        : {}),
    };
  }
}

export class WatchCreateTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof WatchCreateTool.schema, TContext> {
  static schema = z.object({
    title: z.string().trim().min(1),
    intervalMinutes: z.number().int().positive(),
    source: compactWatchSourceEnvelopeSchema,
    detector: compactWatchDetectorEnvelopeSchema,
    enabled: z.boolean().optional(),
  });

  name = "watch_create";
  description =
    "Create a deterministic watch that polls a source, compares results in code, and wakes the agent only when a real change event exists. Before calling this tool, choose source.kind and detector.kind, call watch_schema_get for those kinds, and use the returned branch schema. Do not guess nested source or detector fields.";
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
      const watch = await this.options.mutations.createWatch({
        title: args.title,
        intervalMinutes: args.intervalMinutes,
        source: parseWatchSourceConfig(args.source),
        detector: parseWatchDetectorConfig(args.detector),
        enabled: args.enabled,
      }, scope);
      return {
        watchId: watch.id,
      };
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}

export class WatchUpdateTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof WatchUpdateTool.schema, TContext> {
  static schema = z.object({
    watchId: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    intervalMinutes: z.number().int().positive().optional(),
    source: compactWatchSourceEnvelopeSchema.optional(),
    detector: compactWatchDetectorEnvelopeSchema.optional(),
    enabled: z.boolean().optional(),
  });

  name = "watch_update";
  description =
    "Update an existing watch in the current session. Before changing source or detector, choose the kind, call watch_schema_get for that kind, and use the returned branch schema. Do not guess nested source or detector fields.";
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
      const watch = await this.options.mutations.updateWatch({
        watchId: args.watchId,
        title: args.title,
        intervalMinutes: args.intervalMinutes,
        source: args.source === undefined ? undefined : parseWatchSourceConfig(args.source),
        detector: args.detector === undefined ? undefined : parseWatchDetectorConfig(args.detector),
        enabled: args.enabled,
      }, scope);
      return {
        watchId: watch.id,
        updated: true,
      };
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}

export class WatchDisableTool<TContext = DefaultAgentSessionContext>
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
      rethrowAsToolError(error);
    }
  }
}
