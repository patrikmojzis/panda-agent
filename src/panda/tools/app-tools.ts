import {z} from "zod";

import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import type {AgentAppAuthService} from "../../domain/apps/auth.js";
import type {
  AgentAppActionResult,
  AgentAppCheckResult,
  AgentAppDefinition,
  AgentAppInspectionResult,
  AgentAppViewResult,
} from "../../domain/apps/types.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {buildAgentAppOpenPath, resolveAgentAppUrls} from "../../integrations/apps/http-config.js";
import type {
  CreateBlankAgentAppOptions,
  CreateBlankAgentAppResult,
} from "../../integrations/apps/scaffold-install.js";
import type {
  AgentAppActionExecutionOptions,
  AgentAppViewExecutionOptions,
} from "../../integrations/apps/sqlite-execution.js";
import {
  describeAgentAppDetails,
  describeAgentAppSummary,
} from "../../integrations/apps/descriptors.js";
import {buildJsonToolPayload, buildTextToolPayload, readRequiredAgentSessionToolScope, rethrowAsToolError} from "./shared.js";

export interface AppToolService {
  createBlankApp(agentKey: string, options: CreateBlankAgentAppOptions): Promise<CreateBlankAgentAppResult>;
  inspectApps(agentKey: string): Promise<AgentAppInspectionResult>;
  checkApps(agentKey: string, options?: {appSlug?: string}): Promise<readonly AgentAppCheckResult[]>;
  getApp(agentKey: string, appSlug: string): Promise<AgentAppDefinition>;
  executeView(
    agentKey: string,
    appSlug: string,
    viewName: string,
    options?: AgentAppViewExecutionOptions,
  ): Promise<AgentAppViewResult>;
  executeAction(
    agentKey: string,
    appSlug: string,
    actionName: string,
    options?: AgentAppActionExecutionOptions,
  ): Promise<AgentAppActionResult>;
}

export type AppLinkAuthService = Pick<AgentAppAuthService, "createLaunchToken">;

function readAppScope(context: unknown): {
  agentKey: string;
  sessionId: string;
  identityId?: string;
} {
  return readRequiredAgentSessionToolScope(
    context,
    "App tools require agentKey and sessionId in the runtime session context.",
  );
}

const looseRecordSchema = z.record(z.string(), z.unknown());
const appListDetailSchema = z.enum(["summary", "full"]);

function requireAppToolJsonObject(value: unknown, label: string): JsonObject {
  if (isJsonObject(value)) {
    return value;
  }

  throw new ToolError(`${label} must be a JSON object.`);
}

function serializeAppSummary(app: AgentAppDefinition): JsonObject {
  return requireAppToolJsonObject(describeAgentAppSummary(app), "app summary");
}

function serializeBrokenAppSummary(app: AgentAppCheckResult): JsonObject {
  return requireAppToolJsonObject({
    slug: app.appSlug,
    errorCount: app.errors.length,
    warningCount: app.warnings.length,
    ...(app.errors[0] ? {firstError: app.errors[0].message} : {}),
    ...(app.warnings[0] ? {firstWarning: app.warnings[0].message} : {}),
  }, "broken app summary");
}

function serializeAppFull(app: AgentAppDefinition): JsonObject {
  return requireAppToolJsonObject({
    ...describeAgentAppDetails(app),
    ...(app.hasUi ? resolveAgentAppUrls({
      agentKey: app.agentKey,
      appSlug: app.slug,
    }) : {}),
  }, "app details");
}

function serializeBrokenAppFull(app: AgentAppCheckResult): JsonObject {
  return requireAppToolJsonObject({
    slug: app.appSlug,
    appDir: app.appDir,
    errors: app.errors,
    warnings: app.warnings,
  }, "broken app details");
}

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

  constructor(private readonly service: AppToolService) {
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
        requireAppToolJsonObject({
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
          schemaApplied: result.schemaApplied,
          ...(urls ? urls : {}),
        }, "app_create result"),
      );
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}

export class AppListTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof AppListTool.schema, TContext> {
  static schema = z.object({
    appSlug: z.string().trim().min(1).optional()
      .describe("Optional app slug to filter to one installed micro-app."),
    detail: appListDetailSchema.optional()
      .describe("Defaults to summary. Use full only for one app when you need action inputSchema metadata or raw UI URLs."),
  });

  name = "app_list";
  description =
    "List filesystem-backed micro-apps installed for the current agent. Defaults to a compact discovery index with app/view/action names. Pass appSlug plus detail=\"full\" only when you need one app's action inputSchema metadata or raw UI URLs.";
  schema = AppListTool.schema;

  constructor(private readonly service: AppToolService) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    if (typeof args.appSlug === "string") {
      return args.detail === "full" ? `${args.appSlug} full` : args.appSlug;
    }

    return super.formatCall(args);
  }

  async handle(
    args: z.output<typeof AppListTool.schema>,
    run: RunContext<TContext>,
  ) {
    try {
      if (args.detail === "full" && !args.appSlug) {
        throw new ToolError("app_list detail=\"full\" requires appSlug so the full manifest dump stays scoped.");
      }

      const scope = readAppScope(run.context);
      const inspection = await this.service.inspectApps(scope.agentKey);
      const apps = args.appSlug
        ? inspection.apps.filter((app) => app.slug === args.appSlug)
        : inspection.apps;
      const brokenApps = args.appSlug
        ? inspection.brokenApps.filter((app) => app.appSlug === args.appSlug)
        : inspection.brokenApps;

      if (args.appSlug && apps.length === 0 && brokenApps.length === 0) {
        throw new ToolError(`No installed micro-app found for slug ${args.appSlug}.`);
      }

      const detail = args.detail ?? "summary";
      return buildJsonToolPayload(requireAppToolJsonObject({
        detail,
        apps: apps.map((app) => detail === "full" ? serializeAppFull(app) : serializeAppSummary(app)),
        brokenApps: brokenApps.map((app) => detail === "full" ? serializeBrokenAppFull(app) : serializeBrokenAppSummary(app)),
      }, "app_list result"));
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}

export class AppLinkCreateTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof AppLinkCreateTool.schema, TContext> {
  static schema = z.object({
    appSlug: z.string().trim().min(1),
    expiresInMinutes: z.number().int().positive().max(60).optional()
      .describe("Launch link lifetime. Defaults to 10 minutes and is capped at 60."),
  });

  name = "app_link_create";
  description =
    "Create a short-lived one-time browser launch link for a micro-app UI. Use this when the current human asks to open an app. The link signs the browser into that one app as the current input identity.";
  schema = AppLinkCreateTool.schema;

  constructor(
    private readonly service: AppToolService,
    private readonly auth: AppLinkAuthService,
  ) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.appSlug === "string" ? args.appSlug : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof AppLinkCreateTool.schema>,
    run: RunContext<TContext>,
  ) {
    try {
      const scope = readAppScope(run.context);
      const app = await this.service.getApp(scope.agentKey, args.appSlug);
      if (!app.hasUi) {
        throw new ToolError(`App ${app.slug} does not expose a UI.`);
      }

      const identityId = scope.identityId;
      if (!identityId) {
        throw new ToolError("app_link_create needs an identity. Ask the user to chat through an identity-bound channel first.");
      }

      const launch = await this.auth.createLaunchToken({
        agentKey: scope.agentKey,
        appSlug: app.slug,
        identityId,
        sessionId: scope.sessionId,
        expiresInMs: (args.expiresInMinutes ?? 10) * 60 * 1000,
      });
      const urls = resolveAgentAppUrls({
        agentKey: app.agentKey,
        appSlug: app.slug,
      });
      const openUrl = new URL(buildAgentAppOpenPath(launch.token), urls.appUrl).toString();

      return buildTextToolPayload(
        `Created one-time app link for ${app.slug}.`,
        requireAppToolJsonObject({
          agentKey: app.agentKey,
          appSlug: app.slug,
          openUrl,
          expiresAt: new Date(launch.expiresAt).toISOString(),
          appUrl: urls.appUrl,
          localAppUrl: urls.localAppUrl,
          ...(urls.internalAppUrl ? {internalAppUrl: urls.internalAppUrl} : {}),
          ...(urls.publicAppUrl ? {publicAppUrl: urls.publicAppUrl} : {}),
        }, "app_link_create result"),
      );
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

  constructor(private readonly service: AppToolService) {
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
      return buildJsonToolPayload(requireAppToolJsonObject({
        ok: apps.every((app) => app.ok),
        apps,
      }, "app_check result"));
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
    params: looseRecordSchema.optional(),
    pageSize: z.number().int().positive().optional(),
    offset: z.number().int().min(0).optional(),
  });

  name = "app_view";
  description =
    "Run one readonly view from an installed micro-app for the current input identity. If you do not know the app or view name, call app_list first for the compact discovery index. Pass params when the app view expects them.";
  schema = AppViewTool.schema;

  constructor(private readonly service: AppToolService) {
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
        identityId: scope.identityId,
        params: args.params,
        pageSize: args.pageSize,
        offset: args.offset,
        sessionId: scope.sessionId,
      });

      return buildJsonToolPayload(requireAppToolJsonObject({
        appSlug: args.appSlug,
        viewName: args.viewName,
        ...result,
      }, "app_view result"));
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
    input: looseRecordSchema.optional(),
  });

  name = "app_action";
  description =
    "Run one declared micro-app action for the current input identity. If you do not know the app or action name, call app_list first for the compact discovery index. Use app_list with appSlug and detail=\"full\" only when you need inputSchema details. If the action needs values, pass them through the input object. This is for fixed app actions, not arbitrary SQL.";
  schema = AppActionTool.schema;

  constructor(private readonly service: AppToolService) {
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
        identityId: scope.identityId,
        input: args.input,
        sessionId: scope.sessionId,
      });

      return buildJsonToolPayload(requireAppToolJsonObject({
        appSlug: args.appSlug,
        actionName: args.actionName,
        ...result,
      }, "app_action result"));
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}
