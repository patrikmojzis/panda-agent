import path from "node:path";

import type {
    AgentAppActionResult,
    AgentAppActionExecutionOptions,
    AgentAppCheckResult,
    AgentAppDefinition,
    AgentAppDiagnosticIssue,
    AgentAppInspectionResult,
    AgentAppViewExecutionOptions,
    AgentAppViewResult,
} from "../../domain/apps/types.js";
import {normalizeAgentAppSlug} from "../../domain/apps/types.js";
import {pathExists} from "../../lib/fs.js";
import {
    AgentAppDefinitionError,
    FileSystemAgentAppRegistry,
    type FileSystemAgentAppRegistryOptions,
} from "./fs-registry.js";
import {
    createBlankAgentApp,
    type CreateBlankAgentAppOptions,
    type CreateBlankAgentAppResult,
} from "./scaffold-install.js";
import {
    executeAgentAppAction,
    executeAgentAppView,
} from "./sqlite-execution.js";
import {
    openAppDatabase,
    prepareStatement,
    readActionStatements,
} from "./sqlite-runtime.js";

interface AgentAppServiceOptions extends FileSystemAgentAppRegistryOptions {
  registry?: FileSystemAgentAppRegistry;
}

async function inspectSingleApp(input: {
  agentKey: string;
  appSlug: string;
  registry: Pick<FileSystemAgentAppRegistry, "getApp" | "resolveAppsDir">;
}): Promise<AgentAppInspectionResult> {
  const normalizedSlug = normalizeAgentAppSlug(input.appSlug);
  const appDir = path.join(input.registry.resolveAppsDir(input.agentKey), normalizedSlug);
  try {
    const app = await input.registry.getApp(input.agentKey, normalizedSlug);
    return {
      apps: [app],
      brokenApps: [],
    };
  } catch (error) {
    return {
      apps: [],
      brokenApps: [{
        appSlug: normalizedSlug,
        appDir,
        ok: false,
        errors: error instanceof AgentAppDefinitionError
          ? error.issues
          : [{
            file: appDir,
            message: error instanceof Error ? error.message : String(error),
          }],
        warnings: [],
      }],
    };
  }
}

async function checkLoadedAgentApp(app: AgentAppDefinition): Promise<AgentAppCheckResult> {
  const errors: AgentAppDiagnosticIssue[] = [];
  const warnings: AgentAppDiagnosticIssue[] = [];
  const schemaPath = path.join(app.appDir, "schema.sql");
  if (!await pathExists(schemaPath)) {
    warnings.push({
      file: schemaPath,
      message: "schema.sql is missing.",
    });
  }

  if (!await pathExists(app.dbPath)) {
    warnings.push({
      file: app.dbPath,
      message: "data/app.sqlite is missing, so SQL prepare checks were skipped.",
    });
    return {
      appSlug: app.slug,
      appDir: app.appDir,
      ok: errors.length === 0,
      errors,
      warnings,
    };
  }

  const db = openAppDatabase(app);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const [viewName, definition] of Object.entries(app.views)) {
      try {
        if (definition.pagination?.mode === "offset") {
          prepareStatement(db, `SELECT * FROM (${definition.sql}) AS app_view LIMIT :limit_plus_one OFFSET :offset`);
        } else {
          prepareStatement(db, definition.sql);
        }
      } catch (error) {
        errors.push({
          file: app.viewsPath,
          path: `${viewName}.sql`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const [actionName, definition] of Object.entries(app.actions)) {
      const statements = readActionStatements(definition);
      for (const [index, statement] of statements.entries()) {
        try {
          prepareStatement(db, statement);
        } catch (error) {
          errors.push({
            file: app.actionsPath,
            path: statements.length === 1 ? `${actionName}.sql` : `${actionName}.sql[${index}]`,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  } finally {
    db.close();
  }

  return {
    appSlug: app.slug,
    appDir: app.appDir,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

async function checkAgentApps(input: {
  agentKey: string;
  appSlug?: string;
  registry: Pick<FileSystemAgentAppRegistry, "getApp" | "inspectApps" | "resolveAppsDir">;
}): Promise<readonly AgentAppCheckResult[]> {
  const inspection = input.appSlug
    ? await inspectSingleApp({
      agentKey: input.agentKey,
      appSlug: input.appSlug,
      registry: input.registry,
    })
    : await input.registry.inspectApps(input.agentKey);
  const loadedChecks = await Promise.all(inspection.apps.map((app) => checkLoadedAgentApp(app)));
  const checks = [
    ...loadedChecks,
    ...inspection.brokenApps,
  ];

  return checks.sort((left, right) => left.appSlug.localeCompare(right.appSlug));
}

export class AgentAppService {
  readonly registry: FileSystemAgentAppRegistry;

  constructor(options: AgentAppServiceOptions = {}) {
    this.registry = options.registry ?? new FileSystemAgentAppRegistry(options);
  }

  async listApps(agentKey: string): Promise<readonly AgentAppDefinition[]> {
    return this.registry.listApps(agentKey);
  }

  async inspectApps(agentKey: string): Promise<AgentAppInspectionResult> {
    return this.registry.inspectApps(agentKey);
  }

  async checkApps(
    agentKey: string,
    options: {
      appSlug?: string;
    } = {},
  ): Promise<readonly AgentAppCheckResult[]> {
    return checkAgentApps({
      agentKey,
      appSlug: options.appSlug,
      registry: this.registry,
    });
  }

  async getApp(agentKey: string, appSlug: string): Promise<AgentAppDefinition> {
    return this.registry.getApp(agentKey, appSlug);
  }

  async createBlankApp(
    agentKey: string,
    options: CreateBlankAgentAppOptions,
  ): Promise<CreateBlankAgentAppResult> {
    return createBlankAgentApp({
      agentKey,
      options,
      registry: this.registry,
    });
  }

  async executeView(
    agentKey: string,
    appSlug: string,
    viewName: string,
    options: AgentAppViewExecutionOptions = {},
  ): Promise<AgentAppViewResult> {
    return executeAgentAppView({
      agentKey,
      appSlug,
      viewName,
      options,
      registry: this.registry,
    });
  }

  async executeAction(
    agentKey: string,
    appSlug: string,
    actionName: string,
    options: AgentAppActionExecutionOptions = {},
  ): Promise<AgentAppActionResult> {
    return executeAgentAppAction({
      agentKey,
      appSlug,
      actionName,
      options,
      registry: this.registry,
    });
  }
}
