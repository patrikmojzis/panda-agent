import type {JsonObject} from "../../lib/json.js";
import {isJsonObject, requireJsonValue} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import type {
  AgentAppActionExecutionOptions,
  AgentAppActionResult,
  AgentAppCheckResult,
  AgentAppDefinition,
  AgentAppInspectionResult,
  AgentAppViewExecutionOptions,
  AgentAppViewResult,
} from "./types.js";
import {readAgentAppRequiredInputKeys} from "./types.js";

export const APP_CHECK_COMMAND_NAME = "micro-app.check";
export const APP_CREATE_COMMAND_NAME = "micro-app.create";
export const APP_LINK_CREATE_COMMAND_NAME = "micro-app.link.create";
export const APP_LIST_COMMAND_NAME = "micro-app.list";
export const APP_VIEW_COMMAND_NAME = "micro-app.view";
export const APP_ACTION_COMMAND_NAME = "micro-app.action";

export interface CreateBlankAgentAppCommandOptions {
  slug: string;
  name: string;
  description?: string;
  identityScoped?: boolean;
  schemaSql?: string;
}

export interface CreateBlankAgentAppCommandResult {
  app: AgentAppDefinition;
  manifestPath: string;
  viewPath: string;
  actionPath: string;
  schemaPath: string;
  readmePath: string;
  schemaApplied: boolean;
}

export interface AgentAppCommandService {
  createBlankApp(agentKey: string, options: CreateBlankAgentAppCommandOptions): Promise<CreateBlankAgentAppCommandResult>;
  getApp(agentKey: string, appSlug: string): Promise<AgentAppDefinition>;
  inspectApps(agentKey: string): Promise<AgentAppInspectionResult>;
  checkApps(agentKey: string, options?: {appSlug?: string}): Promise<readonly AgentAppCheckResult[]>;
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

export interface AgentAppCommandUrls {
  appUrl: string;
  localAppUrl: string;
  internalAppUrl?: string;
  publicAppUrl?: string;
}

export interface AgentAppLaunchTokenResult {
  token: string;
  expiresAt: number;
}

export interface AgentAppCommandAuthService {
  createLaunchToken(input: {
    agentKey: string;
    appSlug: string;
    identityId: string;
    sessionId?: string;
    expiresInMs?: number;
  }): Promise<AgentAppLaunchTokenResult>;
}

export interface AppCommandOptions {
  resolveUrls?: (input: {agentKey: string; appSlug: string}) => AgentAppCommandUrls;
  resolveLaunchUrls?: (input: {agentKey: string; appSlug: string; token: string}) => AgentAppCommandUrls & {openUrl: string};
}

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

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function readOptionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return value;
}

function readOptionalJsonObject(value: unknown, label: string): JsonObject | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function parseAppCheckInput(input: unknown): {appSlug?: string} {
  if (!isRecord(input)) {
    throw new Error("micro-app.check input must be a JSON object.");
  }

  return {
    appSlug: readOptionalString(input.appSlug, "micro-app.check appSlug"),
  };
}

function parseAppCreateInput(input: unknown): CreateBlankAgentAppCommandOptions {
  if (!isRecord(input)) {
    throw new Error("micro-app.create input must be a JSON object.");
  }

  const description = readOptionalString(input.description, "micro-app.create description");
  const schemaSql = readOptionalString(input.schemaSql, "micro-app.create schemaSql");
  const identityScoped = input.identityScoped;
  if (identityScoped !== undefined && typeof identityScoped !== "boolean") {
    throw new Error("micro-app.create identityScoped must be a boolean.");
  }

  return {
    slug: readRequiredString(input.slug, "micro-app.create slug"),
    name: readRequiredString(input.name, "micro-app.create name"),
    ...(description ? {description} : {}),
    ...(identityScoped === undefined ? {} : {identityScoped}),
    ...(schemaSql ? {schemaSql} : {}),
  };
}

function parseAppLinkCreateInput(input: unknown): {appSlug: string; expiresInMinutes?: number} {
  if (!isRecord(input)) {
    throw new Error("micro-app.link.create input must be a JSON object.");
  }

  const expiresInMinutes = readOptionalPositiveInteger(input.expiresInMinutes, "micro-app.link.create expiresInMinutes");
  if (expiresInMinutes !== undefined && expiresInMinutes > 60) {
    throw new Error("micro-app.link.create expiresInMinutes must be at most 60.");
  }

  return {
    appSlug: readRequiredString(input.appSlug, "micro-app.link.create appSlug"),
    ...(expiresInMinutes === undefined ? {} : {expiresInMinutes}),
  };
}

function parseAppListInput(input: unknown): {appSlug?: string; detail?: "summary" | "full"} {
  if (!isRecord(input)) {
    throw new Error("micro-app.list input must be a JSON object.");
  }

  const detail = input.detail;
  if (detail !== undefined && detail !== "summary" && detail !== "full") {
    throw new Error("micro-app.list detail must be summary or full.");
  }

  return {
    appSlug: readOptionalString(input.appSlug, "micro-app.list appSlug"),
    detail,
  };
}

function parseAppViewInput(input: unknown): {
  appSlug: string;
  viewName: string;
  params?: JsonObject;
  pageSize?: number;
  offset?: number;
} {
  if (!isRecord(input)) {
    throw new Error("micro-app.view input must be a JSON object.");
  }

  return {
    appSlug: readRequiredString(input.appSlug, "micro-app.view appSlug"),
    viewName: readRequiredString(input.viewName, "micro-app.view viewName"),
    params: readOptionalJsonObject(input.params, "micro-app.view params"),
    pageSize: readOptionalPositiveInteger(input.pageSize, "micro-app.view pageSize"),
    offset: readOptionalNonNegativeInteger(input.offset, "micro-app.view offset"),
  };
}

function parseAppActionInput(input: unknown): {
  appSlug: string;
  actionName: string;
  input?: JsonObject;
} {
  if (!isRecord(input)) {
    throw new Error("micro-app.action input must be a JSON object.");
  }

  return {
    appSlug: readRequiredString(input.appSlug, "micro-app.action appSlug"),
    actionName: readRequiredString(input.actionName, "micro-app.action actionName"),
    input: readOptionalJsonObject(input.input, "micro-app.action input"),
  };
}

function requireCommandJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function serializeAppSummary(app: AgentAppDefinition): JsonObject {
  return requireCommandJsonObject({
    slug: app.slug,
    name: app.name,
    ...(app.description ? {description: app.description} : {}),
    identityScoped: app.identityScoped,
    hasUi: app.hasUi,
    viewNames: Object.keys(app.views),
    actionNames: Object.keys(app.actions),
  }, "app summary");
}

function serializeAppDetails(app: AgentAppDefinition, options: AppCommandOptions = {}): JsonObject {
  return requireCommandJsonObject({
    ...serializeAppSummary(app),
    views: Object.entries(app.views).map(([name, definition]) => requireJsonValue({
      name,
      ...(definition.description ? {description: definition.description} : {}),
      paginated: Boolean(definition.pagination),
    }, "micro-app.list view")),
    actions: Object.entries(app.actions).map(([name, definition]) => {
      const requiredInputKeys = readAgentAppRequiredInputKeys(definition);
      return requireJsonValue({
        name,
        mode: definition.mode ?? "native",
        ...(definition.description ? {description: definition.description} : {}),
        ...(requiredInputKeys?.length ? {requiredInputKeys} : {}),
        ...(definition.inputSchema ? {inputSchema: definition.inputSchema} : {}),
      }, "micro-app.list action");
    }),
    ...(app.hasUi && options.resolveUrls
      ? options.resolveUrls({
        agentKey: app.agentKey,
        appSlug: app.slug,
      })
      : {}),
  }, "app details");
}

function serializeBrokenAppSummary(app: AgentAppCheckResult): JsonObject {
  return requireCommandJsonObject({
    slug: app.appSlug,
    errorCount: app.errors.length,
    warningCount: app.warnings.length,
    ...(app.errors[0] ? {firstError: app.errors[0].message} : {}),
    ...(app.warnings[0] ? {firstWarning: app.warnings[0].message} : {}),
  }, "broken app summary");
}

function serializeBrokenAppDetails(app: AgentAppCheckResult): JsonObject {
  return requireCommandJsonObject({
    slug: app.appSlug,
    appDir: app.appDir,
    errors: app.errors,
    warnings: app.warnings,
  }, "broken app details");
}

export const appCheckCommandDescriptor: CommandDescriptor = {
  name: APP_CHECK_COMMAND_NAME,
  summary: "Check installed micro-app health.",
  description: "Checks whether one micro-app, or all micro-apps for the current agent, can be loaded cleanly by Panda.",
  usage: "panda micro-app check [app-slug]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "app-slug",
      description: "Optional micro-app slug. Omit to check all installed micro-apps.",
      kind: "positional",
      required: false,
      valueType: "string",
    },
    {
      name: "json",
      description: "JSON object containing optional appSlug.",
      required: false,
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Check all apps",
      command: "panda micro-app check",
    },
    {
      description: "Check one app",
      command: "panda micro-app check food-tracker",
    },
    {
      description: "Check one app from JSON stdin",
      command: "printf '{\"appSlug\":\"food-tracker\"}' | panda micro-app check --json @-",
    },
  ],
  requiredCapabilities: ["micro-app.check"],
  resultShape: {
    ok: "boolean",
    apps: ["object"],
  },
};

export const appCreateCommandDescriptor: CommandDescriptor = {
  name: APP_CREATE_COMMAND_NAME,
  summary: "Create a blank micro-app.",
  description: "Creates a blank filesystem-backed micro-app scaffold for the current agent.",
  usage: "panda micro-app create <slug> --name <text|@file|@-> [--description <text|@file|@->] [--identity-scoped] [--schema <sql|@file|@->]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "slug",
      description: "Micro-app slug to create.",
      kind: "positional",
      required: true,
      valueType: "string",
    },
    {
      name: "name",
      description: "Human-readable app name.",
      required: true,
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "description",
      description: "Optional human-readable app description.",
      required: false,
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "identity-scoped",
      description: "Create an identity-scoped app database.",
      required: false,
      valueType: "boolean",
    },
    {
      name: "schema",
      description: "Optional SQL schema to apply to data/app.sqlite.",
      required: false,
      valueType: "string",
      valueName: "sql|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "json",
      description: "JSON object containing slug, name, optional description, identityScoped, and schemaSql.",
      required: false,
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Create a blank app",
      command: "panda micro-app create food-tracker --name \"Food Tracker\"",
    },
    {
      description: "Create an app and apply schema SQL from a file",
      command: "panda micro-app create food-tracker --name \"Food Tracker\" --schema @schema.sql",
    },
  ],
  requiredCapabilities: ["micro-app.create"],
  resultShape: {
    agentKey: "string",
    slug: "string",
    appDir: "string",
    schemaApplied: "boolean",
  },
};

export const appLinkCreateCommandDescriptor: CommandDescriptor = {
  name: APP_LINK_CREATE_COMMAND_NAME,
  summary: "Create a one-time micro-app launch link.",
  description: "Creates a short-lived one-time browser launch link for a micro-app UI using the current input identity.",
  usage: "panda micro-app link create <app-slug> [--expires <minutes|Nm|Nh>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "app-slug",
      description: "Micro-app slug to open.",
      kind: "positional",
      required: true,
      valueType: "string",
    },
    {
      name: "expires",
      description: "Optional link lifetime in minutes, Nm, or Nh. The command contract still caps this at 60 minutes.",
      required: false,
      valueType: "string",
      valueName: "minutes|Nm|Nh",
    },
    {
      name: "json",
      description: "JSON object containing appSlug and optional expiresInMinutes. The identity comes from command scope, not input.",
      required: false,
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Create a launch link",
      command: "panda micro-app link create food-tracker --expires 10m",
    },
  ],
  requiredCapabilities: ["micro-app.link.create"],
  resultShape: {
    agentKey: "string",
    appSlug: "string",
    openUrl: "string",
    expiresAt: "string",
  },
};

export const appListCommandDescriptor: CommandDescriptor = {
  name: APP_LIST_COMMAND_NAME,
  summary: "List installed micro-apps.",
  description: "Lists filesystem-backed micro-apps installed for the current agent.",
  usage: "panda micro-app list [app-slug] [--full]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "app-slug",
      description: "Optional micro-app slug to inspect.",
      kind: "positional",
      required: false,
      valueType: "string",
    },
    {
      name: "full",
      description: "Return full manifest details for one app.",
      required: false,
      valueType: "boolean",
    },
    {
      name: "json",
      description: "JSON object containing optional appSlug and detail values. detail is summary or full.",
      required: false,
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List apps",
      command: "panda micro-app list",
    },
    {
      description: "Show one full app manifest summary",
      command: "panda micro-app list food-tracker --full",
    },
  ],
  requiredCapabilities: ["micro-app.list"],
  resultShape: {
    detail: "string",
    apps: ["object"],
    brokenApps: ["object"],
  },
};

export const appViewCommandDescriptor: CommandDescriptor = {
  name: APP_VIEW_COMMAND_NAME,
  summary: "Run a micro-app view.",
  description: "Runs one readonly view from an installed micro-app for the current input identity.",
  usage: "panda micro-app view <app-slug> <view-name> [--param key=value] [--params <json|@file|@->] [--page-size <n>] [--offset <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "app-slug",
      description: "Micro-app slug that owns the view.",
      kind: "positional",
      required: true,
      valueType: "string",
    },
    {
      name: "view-name",
      description: "Declared readonly view name to run.",
      kind: "positional",
      required: true,
      valueType: "string",
    },
    {
      name: "param",
      description: "Simple string parameter as key=value. Repeat for multiple params.",
      required: false,
      valueType: "string",
      valueName: "key=value",
      repeatable: true,
    },
    {
      name: "params",
      description: "JSON object for typed view params. Merges with repeated --param values.",
      required: false,
      valueType: "json",
      valueName: "json|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "page-size",
      description: "Optional positive page size for paginated views.",
      required: false,
      valueType: "number",
      valueName: "n",
    },
    {
      name: "offset",
      description: "Optional non-negative row offset for paginated views.",
      required: false,
      valueType: "number",
      valueName: "n",
    },
    {
      name: "json",
      description: "JSON object containing appSlug, viewName, optional params, pageSize, and offset.",
      required: false,
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Run a view",
      command: "panda micro-app view food-tracker today_summary",
    },
    {
      description: "Run a paginated view with params",
      command: "panda micro-app view food-tracker entries --param day=2026-06-25 --page-size 20",
    },
  ],
  requiredCapabilities: ["micro-app.view"],
  resultShape: {
    appSlug: "string",
    viewName: "string",
    items: ["object"],
  },
};

export const appActionCommandDescriptor: CommandDescriptor = {
  name: APP_ACTION_COMMAND_NAME,
  summary: "Run a micro-app action.",
  description: "Runs one declared micro-app action for the current input identity.",
  usage: "panda micro-app action <app-slug> <action-name> [--input <json|@file|@->]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "app-slug",
      description: "Micro-app slug that owns the action.",
      kind: "positional",
      required: true,
      valueType: "string",
    },
    {
      name: "action-name",
      description: "Declared action name to run.",
      kind: "positional",
      required: true,
      valueType: "string",
    },
    {
      name: "input",
      description: "Optional JSON object passed to the action.",
      required: false,
      valueType: "json",
      valueName: "json|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "json",
      description: "JSON object containing appSlug, actionName, and optional input object.",
      required: false,
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Run an action",
      command: "panda micro-app action food-tracker delete_entry --input '{\"id\":1}'",
    },
  ],
  requiredCapabilities: ["micro-app.action"],
  resultShape: {
    appSlug: "string",
    actionName: "string",
    mode: "string",
    changes: "number",
    wakeRequested: "boolean",
  },
};

export function createAppCheckCommand(service: AgentAppCommandService): RegisteredCommand {
  return {
    descriptor: appCheckCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseAppCheckInput(request.input);
      const apps = await service.checkApps(request.scope.agentKey, {
        ...(input.appSlug ? {appSlug: input.appSlug} : {}),
      });
      const output = requireCommandJsonObject({
        ok: apps.every((app) => app.ok),
        apps: apps.map((app) => requireJsonValue(app, "micro-app.check app")),
      }, "micro-app.check result");

      return {
        ok: true,
        command: APP_CHECK_COMMAND_NAME,
        output,
        summary: input.appSlug ? `Checked app ${input.appSlug}.` : "Checked installed apps.",
      };
    },
  };
}

export function createAppCreateCommand(
  service: AgentAppCommandService,
  options: AppCommandOptions = {},
): RegisteredCommand {
  return {
    descriptor: appCreateCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseAppCreateInput(request.input);
      const result = await service.createBlankApp(request.scope.agentKey, input);
      const urls = result.app.hasUi && options.resolveUrls
        ? options.resolveUrls({
          agentKey: result.app.agentKey,
          appSlug: result.app.slug,
        })
        : null;
      const output = requireCommandJsonObject({
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
      }, "micro-app.create result");

      return {
        ok: true,
        command: APP_CREATE_COMMAND_NAME,
        output,
        summary: `Created blank app ${result.app.slug}.`,
      };
    },
  };
}

export function createAppLinkCreateCommand(
  service: AgentAppCommandService,
  auth: AgentAppCommandAuthService,
  options: AppCommandOptions = {},
): RegisteredCommand {
  return {
    descriptor: appLinkCreateCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseAppLinkCreateInput(request.input);
      const app = await service.getApp(request.scope.agentKey, input.appSlug);
      if (!app.hasUi) {
        throw new Error(`App ${app.slug} does not expose a UI.`);
      }
      if (!request.scope.identityId) {
        throw new Error("micro-app.link.create needs an identity. Ask the user to chat through an identity-bound channel first.");
      }

      const launch = await auth.createLaunchToken({
        agentKey: request.scope.agentKey,
        appSlug: app.slug,
        identityId: request.scope.identityId,
        sessionId: request.scope.sessionId,
        expiresInMs: (input.expiresInMinutes ?? 10) * 60 * 1000,
      });
      const urls = options.resolveLaunchUrls
        ? options.resolveLaunchUrls({
          agentKey: app.agentKey,
          appSlug: app.slug,
          token: launch.token,
        })
        : null;
      if (!urls) {
        throw new Error("micro-app.link.create requires app launch URL resolution in this runtime.");
      }

      const output = requireCommandJsonObject({
        agentKey: app.agentKey,
        appSlug: app.slug,
        openUrl: urls.openUrl,
        expiresAt: new Date(launch.expiresAt).toISOString(),
        appUrl: urls.appUrl,
        localAppUrl: urls.localAppUrl,
        ...(urls.internalAppUrl ? {internalAppUrl: urls.internalAppUrl} : {}),
        ...(urls.publicAppUrl ? {publicAppUrl: urls.publicAppUrl} : {}),
      }, "micro-app.link.create result");

      return {
        ok: true,
        command: APP_LINK_CREATE_COMMAND_NAME,
        output,
        summary: `Created one-time app link for ${app.slug}.`,
      };
    },
  };
}

export function createAppListCommand(
  service: AgentAppCommandService,
  options: AppCommandOptions = {},
): RegisteredCommand {
  return {
    descriptor: appListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseAppListInput(request.input);
      if (input.detail === "full" && !input.appSlug) {
        throw new Error("micro-app.list detail=\"full\" requires appSlug so the full manifest dump stays scoped.");
      }

      const inspection = await service.inspectApps(request.scope.agentKey);
      const apps = input.appSlug
        ? inspection.apps.filter((app) => app.slug === input.appSlug)
        : inspection.apps;
      const brokenApps = input.appSlug
        ? inspection.brokenApps.filter((app) => app.appSlug === input.appSlug)
        : inspection.brokenApps;

      if (input.appSlug && apps.length === 0 && brokenApps.length === 0) {
        throw new Error(`No installed micro-app found for slug ${input.appSlug}.`);
      }

      const detail = input.detail ?? "summary";
      const output = requireCommandJsonObject({
        detail,
        apps: apps.map((app) => detail === "full" ? serializeAppDetails(app, options) : serializeAppSummary(app)),
        brokenApps: brokenApps.map((app) => detail === "full" ? serializeBrokenAppDetails(app) : serializeBrokenAppSummary(app)),
      }, "micro-app.list result");

      return {
        ok: true,
        command: APP_LIST_COMMAND_NAME,
        output,
        summary: input.appSlug ? `Listed app ${input.appSlug}.` : "Listed installed apps.",
      };
    },
  };
}

export function createAppViewCommand(service: AgentAppCommandService): RegisteredCommand {
  return {
    descriptor: appViewCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseAppViewInput(request.input);
      const result = await service.executeView(request.scope.agentKey, input.appSlug, input.viewName, {
        identityId: request.scope.identityId,
        params: input.params,
        pageSize: input.pageSize,
        offset: input.offset,
        sessionId: request.scope.sessionId,
      });
      const output = requireCommandJsonObject({
        appSlug: input.appSlug,
        viewName: input.viewName,
        ...result,
      }, "micro-app.view result");

      return {
        ok: true,
        command: APP_VIEW_COMMAND_NAME,
        output,
        summary: `Ran app view ${input.appSlug}.${input.viewName}.`,
      };
    },
  };
}

export function createAppActionCommand(service: AgentAppCommandService): RegisteredCommand {
  return {
    descriptor: appActionCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseAppActionInput(request.input);
      const result = await service.executeAction(request.scope.agentKey, input.appSlug, input.actionName, {
        identityId: request.scope.identityId,
        input: input.input,
        sessionId: request.scope.sessionId,
      });
      const output = requireCommandJsonObject({
        appSlug: input.appSlug,
        actionName: input.actionName,
        ...result,
      }, "micro-app.action result");

      return {
        ok: true,
        command: APP_ACTION_COMMAND_NAME,
        output,
        summary: `Ran app action ${input.appSlug}.${input.actionName}.`,
      };
    },
  };
}
