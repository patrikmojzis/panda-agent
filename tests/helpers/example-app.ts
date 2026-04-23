import os from "node:os";
import path from "node:path";
import {cp, mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";

import {resolveAgentDir} from "../../src/app/runtime/data-dir.js";

export interface ExampleAppFixtureInput {
  agentKey?: string;
  dataDir?: string;
  slug: string;
}

export interface ExampleAppFixture {
  agentKey: string;
  appDir: string;
  dataDir: string;
  dbPath: string;
  slug: string;
  cleanup(): Promise<void>;
}

export async function installExampleAppFixture(
  input: ExampleAppFixtureInput,
): Promise<ExampleAppFixture> {
  const dataDir = input.dataDir ?? await mkdtemp(path.join(os.tmpdir(), "panda-example-app-"));
  const agentKey = input.agentKey ?? "panda";
  const sourceDir = path.resolve(process.cwd(), "examples", "apps", input.slug);
  const appDir = path.join(resolveAgentDir(agentKey, {...process.env, DATA_DIR: dataDir}), "apps", input.slug);
  const dbPath = path.join(appDir, "data", "app.sqlite");

  await mkdir(path.dirname(appDir), {recursive: true});
  await cp(sourceDir, appDir, {recursive: true});
  await mkdir(path.dirname(dbPath), {recursive: true});

  const schemaSql = await readFile(path.join(appDir, "schema.sql"), "utf8");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(schemaSql);
  } finally {
    db.close();
  }

  return {
    agentKey,
    appDir,
    dataDir,
    dbPath,
    slug: input.slug,
    cleanup: async (): Promise<void> => {
      await rm(dataDir, {recursive: true, force: true});
    },
  };
}
