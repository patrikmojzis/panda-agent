import os from "node:os";
import path from "node:path";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";

import {resolveAgentDir} from "../../src/app/runtime/data-dir.js";

export interface AgentAppFixtureOptions {
  actions?: Record<string, unknown>;
  agentKey?: string;
  appSlug?: string;
  dataDir?: string;
  description?: string;
  entryHtml?: string;
  identityScoped?: boolean;
  name?: string;
  publicFiles?: Record<string, string>;
  seedSql?: readonly string[];
  views?: Record<string, unknown>;
}

export interface AgentAppFixture {
  actionNames: readonly string[];
  agentKey: string;
  appDir: string;
  appSlug: string;
  dataDir: string;
  dbPath: string;
  manifestPath: string;
  viewNames: readonly string[];
  cleanup(): Promise<void>;
}

export async function createAgentAppFixture(options: AgentAppFixtureOptions = {}): Promise<AgentAppFixture> {
  const dataDir = options.dataDir ?? await mkdtemp(path.join(os.tmpdir(), "panda-app-fixture-"));
  const agentKey = options.agentKey ?? "panda";
  const appSlug = options.appSlug ?? "counter";
  const appDir = path.join(resolveAgentDir(agentKey, {...process.env, DATA_DIR: dataDir}), "apps", appSlug);
  const dbPath = path.join(appDir, "data", "app.sqlite");
  const manifestPath = path.join(appDir, "manifest.json");
  const publicFiles = options.publicFiles ?? {
    "index.html": "<!doctype html><html><head><title>Counter</title></head><body><h1>Counter</h1><script src=\"/panda-app-sdk.js\"></script></body></html>",
    "app.js": "window.__counterLoaded = true;",
  };

  await mkdir(path.dirname(dbPath), {recursive: true});
  await mkdir(path.join(appDir, "public"), {recursive: true});
  await writeFile(manifestPath, JSON.stringify({
    name: options.name ?? "Counter",
    ...(options.description ? {description: options.description} : {}),
    ...(options.identityScoped ? {identityScoped: true} : {}),
    ...(options.entryHtml ? {entryHtml: options.entryHtml} : {}),
  }, null, 2));
  await writeFile(path.join(appDir, "views.json"), JSON.stringify(options.views ?? {
    summary: {
      sql: "select value as count from counter limit 1",
    },
  }, null, 2));
  await writeFile(path.join(appDir, "actions.json"), JSON.stringify(options.actions ?? {
    increment: {
      mode: "native",
      sql: "update counter set value = value + coalesce(:amount, 1)",
    },
  }, null, 2));

  for (const [relativePath, content] of Object.entries(publicFiles)) {
    const targetPath = path.join(appDir, "public", relativePath);
    await mkdir(path.dirname(targetPath), {recursive: true});
    await writeFile(targetPath, content);
  }

  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of options.seedSql ?? [
      "create table if not exists counter (value integer not null)",
      "delete from counter",
      "insert into counter (value) values (1)",
    ]) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  return {
    actionNames: Object.keys(options.actions ?? {increment: true}),
    agentKey,
    appDir,
    appSlug,
    dataDir,
    dbPath,
    manifestPath,
    viewNames: Object.keys(options.views ?? {summary: true}),
    cleanup: async (): Promise<void> => {
      await rm(dataDir, {recursive: true, force: true});
    },
  };
}
