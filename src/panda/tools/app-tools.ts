import {z} from "zod";

import {readCurrentInputIdentityId} from "../../app/runtime/panda-path-context.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {readAgentAppRequiredInputKeys} from "../../domain/apps/types.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {JsonObject} from "../../kernel/agent/types.js";
import {resolveAgentAppUrls} from "../../integrations/apps/http-server.js";
import {AgentAppService} from "../../integrations/apps/sqlite-service.js";
import {buildJsonToolPayload, buildTextToolPayload, rethrowAsToolError} from "./shared.js";

function readAppScope(context: unknown): {
  agentKey: string;
  sessionId: string;
  identityId?: string;
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
    throw new ToolError("App tools require agentKey and sessionId in the runtime session context.");
  }

  return {
    agentKey: (context as {agentKey: string}).agentKey,
    sessionId: (context as {sessionId: string}).sessionId,
    identityId: readCurrentInputIdentityId(context),
  };
}

const looseRecordSchema = z.record(z.string(), z.unknown());

export class AppCreateTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof AppCreateTool.schema, TContext> {
  static schema = z.object({
    slug: z.string().trim().min(1).describe("Stable app slug, for example period-tracker."),
    name: z.string().trim().min(1).describe("Human-friendly app name."),
    description: z.string().trim().min(1).optional().describe("Short description for the app manifest and README."),
    identityScoped: z.boolean().optional().describe("Set true when views and actions should require identityId."),
    schemaSql: z.string().trim().min(1).optional().describe("Optional bootstrap SQL to apply immediately to data/app.sqlite."),
  });

  name = "app_create";
  description =
    "Create a blank filesystem-backed micro-app scaffold for the current agent. This writes manifest.json, views.json, actions.json, schema.sql, a basic public UI, README.md, and data/app.sqlite. Use it to start a new app, then edit the generated files. It does not generate a finished product for you.";
  schema = AppCreateTool.schema;

  constructor(private readonly service: AgentAppService) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.slug === "string" ? args.slug : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof AppCreateTool.schema>,
    run: RunContext<TContext>,
  ) {
    try {
      const scope = readAppScope(run.context);
      const result = await this.service.createBlankApp(scope.agentKey, args);
      const urls = result.app.hasUi
        ? resolveAgentAppUrls({
          agentKey: result.app.agentKey,
          appSlug: result.app.slug,
        })
        : null;

      return buildTextToolPayload(
        `Created blank app ${result.app.slug} for ${result.app.agentKey}.`,
        {
          agentKey: result.app.agentKey,
          slug: result.app.slug,
          name: result.app.name,
          ...(result.app.description ? {description: result.app.description} : {}),
          identityScoped: result.app.identityScoped,
          appDir: result.app.appDir,
          manifestPath: result.manifestPath,
          viewsPath: result.viewPath,
          actionsPath: result.actionPath,
          schemaPath: result.schemaPath,
          readmePath: result.readmePath,
          dbPath: result.app.dbPath,
          hasUi: result.app.hasUi,
          createdDatabase: result.createdDatabase,
          schemaApplied: result.schemaApplied,
          ...(urls ? urls : {}),
        } as JsonObject,
      );
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}

export class AppListTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof AppListTool.schema, TContext> {
  static schema = z.object({});

  name = "app_list";
  description =
    "List filesystem-backed micro-apps installed for the current agent, including available views, actions, descriptions, UI URLs, inputSchema metadata, required input keys, and whether the app expects identity-scoped data. Use this before app_view or app_action.";
  schema = AppListTool.schema;

  constructor(private readonly service: AgentAppService) {
    super();
  }

  async handle(
    _args: z.output<typeof AppListTool.schema>,
    run: RunContext<TContext>,
  ) {
    try {
      const scope = readAppScope(run.context);
      const inspection = await this.service.inspectApps(scope.agentKey);
      const apps = inspection.apps;
      return buildJsonToolPayload({
        apps: apps.map((app) => ({
          slug: app.slug,
          name: app.name,
          ...(app.description ? {description: app.description} : {}),
          identityScoped: app.identityScoped,
          hasUi: app.hasUi,
          ...(app.hasUi ? resolveAgentAppUrls({
            agentKey: app.agentKey,
            appSlug: app.slug,
          }) : {}),
          viewNames: Object.keys(app.views),
          actionNames: Object.keys(app.actions),
          views: Object.entries(app.views).map(([name, definition]) => ({
            name,
            ...(definition.description ? {description: definition.description} : {}),
            paginated: Boolean(definition.pagination),
          })),
          actions: Object.entries(app.actions).map(([name, definition]) => ({
            name,
            mode: definition.mode ?? "native",
            ...(definition.description ? {description: definition.description} : {}),
            ...(readAgentAppRequiredInputKeys(definition)?.length
              ? {requiredInputKeys: readAgentAppRequiredInputKeys(definition)}
              : {}),
            ...(definition.inputSchema ? {inputSchema: definition.inputSchema} : {}),
          })),
        })),
        brokenApps: inspection.brokenApps.map((app) => ({
          slug: app.appSlug,
          appDir: app.appDir,
          errors: app.errors,
          warnings: app.warnings,
        })),
      } as unknown as JsonObject);
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}

export class AppCheckTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof AppCheckTool.schema, TContext> {
  static schema = z.object({
    appSlug: z.string().trim().min(1).optional(),
  });

  name = "app_check";
  description =
    "Check whether one micro-app, or all micro-apps for the current agent, can be loaded cleanly by Panda. Returns exact file/path/message diagnostics and lightweight SQL prepare checks. Use this when app_list or the UI feels confused.";
  schema = AppCheckTool.schema;

  constructor(private readonly service: AgentAppService) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.appSlug === "string" ? args.appSlug : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof AppCheckTool.schema>,
    run: RunContext<TContext>,
  ) {
    try {
      const scope = readAppScope(run.context);
      const apps = await this.service.checkApps(scope.agentKey, {
        appSlug: args.appSlug,
      });
      return buildJsonToolPayload({
        ok: apps.every((app) => app.ok),
        apps,
      } as unknown as JsonObject);
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}

export class AppViewTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof AppViewTool.schema, TContext> {
  static schema = z.object({
    appSlug: z.string().trim().min(1),
    viewName: z.string().trim().min(1),
    identityId: z.string().trim().min(1).optional(),
    params: looseRecordSchema.optional(),
    pageSize: z.number().int().positive().optional(),
    offset: z.number().int().min(0).optional(),
  });

  name = "app_view";
  description =
    "Run one readonly view from an installed micro-app. Use app_list first to discover available view names and descriptions. Pass params when the app view expects them.";
  schema = AppViewTool.schema;

  constructor(private readonly service: AgentAppService) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    if (typeof args.appSlug === "string" && typeof args.viewName === "string") {
      return `${args.appSlug}.${args.viewName}`;
    }

    return super.formatCall(args);
  }

  async handle(
    args: z.output<typeof AppViewTool.schema>,
    run: RunContext<TContext>,
  ) {
    try {
      const scope = readAppScope(run.context);
      const result = await this.service.executeView(scope.agentKey, args.appSlug, args.viewName, {
        identityId: args.identityId ?? scope.identityId,
        params: args.params,
        pageSize: args.pageSize,
        offset: args.offset,
        sessionId: scope.sessionId,
      });

      return buildJsonToolPayload({
        appSlug: args.appSlug,
        viewName: args.viewName,
        ...result,
      } as unknown as JsonObject);
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}

export class AppActionTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof AppActionTool.schema, TContext> {
  static schema = z.object({
    appSlug: z.string().trim().min(1),
    actionName: z.string().trim().min(1),
    identityId: z.string().trim().min(1).optional(),
    input: looseRecordSchema.optional(),
  });

  name = "app_action";
  description =
    "Run one declared micro-app action. Use app_list first to discover action names, descriptions, modes, requiredInputKeys, and inputSchema. If the action needs values, pass them through the input object. This is for fixed app actions, not arbitrary SQL.";
  schema = AppActionTool.schema;

  constructor(private readonly service: AgentAppService) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    if (typeof args.appSlug === "string" && typeof args.actionName === "string") {
      return `${args.appSlug}.${args.actionName}`;
    }

    return super.formatCall(args);
  }

  async handle(
    args: z.output<typeof AppActionTool.schema>,
    run: RunContext<TContext>,
  ) {
    try {
      const scope = readAppScope(run.context);
      const result = await this.service.executeAction(scope.agentKey, args.appSlug, args.actionName, {
        identityId: args.identityId ?? scope.identityId,
        input: args.input,
        sessionId: scope.sessionId,
      });

      return buildJsonToolPayload({
        appSlug: args.appSlug,
        actionName: args.actionName,
        ...result,
      } as unknown as JsonObject);
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}
