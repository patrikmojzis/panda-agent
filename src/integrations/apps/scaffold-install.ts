import path from "node:path";
import {mkdir, rm, writeFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";

import {normalizeAgentAppSlug, type AgentAppDefinition} from "../../domain/apps/types.js";
import {pathExists} from "../../lib/fs.js";
import type {FileSystemAgentAppRegistry} from "./fs-registry.js";
import {buildBlankAgentAppScaffold} from "./scaffold.js";
import {assertSqlStaysInAppDatabase} from "./sqlite-runtime.js";

export interface CreateBlankAgentAppOptions {
  slug: string;
  name: string;
  description?: string;
  identityScoped?: boolean;
  schemaSql?: string;
}

export interface CreateBlankAgentAppResult {
  actionPath: string;
  app: AgentAppDefinition;
  manifestPath: string;
  readmePath: string;
  schemaApplied: boolean;
  schemaPath: string;
  viewPath: string;
}

function normalizeAppName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error("App name must not be empty.");
  }

  return normalized;
}

function normalizeOptionalDescription(description: string | undefined): string | undefined {
  const normalized = description?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Installs a blank filesystem-backed micro-app scaffold and rolls back the
 * directory if any file write or schema bootstrap fails.
 */
export async function createBlankAgentApp(input: {
  agentKey: string;
  options: CreateBlankAgentAppOptions;
  registry: Pick<FileSystemAgentAppRegistry, "getApp" | "resolveAppsDir">;
}): Promise<CreateBlankAgentAppResult> {
  const appSlug = normalizeAgentAppSlug(input.options.slug);
  const appName = normalizeAppName(input.options.name);
  const description = normalizeOptionalDescription(input.options.description);
  const identityScoped = input.options.identityScoped ?? false;
  const appsDir = input.registry.resolveAppsDir(input.agentKey);
  const appDir = path.join(appsDir, appSlug);
  const manifestPath = path.join(appDir, "manifest.json");
  const viewPath = path.join(appDir, "views.json");
  const actionPath = path.join(appDir, "actions.json");
  const schemaPath = path.join(appDir, "schema.sql");
  const readmePath = path.join(appDir, "README.md");
  const publicDir = path.join(appDir, "public");
  const dataDir = path.join(appDir, "data");
  const dbPath = path.join(dataDir, "app.sqlite");
  const scaffold = buildBlankAgentAppScaffold({
    appName,
    description,
    identityScoped,
    schemaSql: input.options.schemaSql,
  });

  if (await pathExists(appDir)) {
    throw new Error(`App ${appSlug} already exists for ${input.agentKey}.`);
  }

  await mkdir(appDir, {recursive: true});
  try {
    await mkdir(publicDir, {recursive: true});
    await mkdir(dataDir, {recursive: true});

    await writeFile(manifestPath, scaffold.manifestJson);
    await writeFile(viewPath, scaffold.viewJson);
    await writeFile(actionPath, scaffold.actionJson);
    await writeFile(schemaPath, scaffold.schemaSql);
    await writeFile(path.join(publicDir, "index.html"), scaffold.indexHtml);
    await writeFile(path.join(publicDir, "app.js"), scaffold.appJs);
    await writeFile(path.join(publicDir, "app.css"), scaffold.appCss);

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      if (scaffold.schemaApplied) {
        assertSqlStaysInAppDatabase(scaffold.schemaSql);
        db.exec(scaffold.schemaSql);
      }
    } finally {
      db.close();
    }

    await writeFile(readmePath, scaffold.readme);
  } catch (error) {
    await rm(appDir, {recursive: true, force: true});
    throw error;
  }

  const app = await input.registry.getApp(input.agentKey, appSlug);
  return {
    app,
    manifestPath,
    viewPath,
    actionPath,
    schemaPath,
    readmePath,
    schemaApplied: scaffold.schemaApplied,
  };
}
