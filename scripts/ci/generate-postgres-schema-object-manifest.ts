#!/usr/bin/env tsx
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {createPostgresPool} from "../../src/lib/postgres-database.js";
import {readPandaSchemaObjectCatalog} from "../../src/app/database/schema-object-catalog.js";
import {looksLikeDisposableDatabaseName, resolveSmokeDatabaseTarget} from "../../src/app/smoke/database.js";
import {createPandaSchemaVerifier} from "../../src/integrations/postgres/schema-version.js";

function requireDisposableDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) throw new Error("Schema manifest generation requires TEST_DATABASE_URL.");
  const target = resolveSmokeDatabaseTarget(value);
  if (!looksLikeDisposableDatabaseName(target.databaseName)) {
    throw new Error(`Refusing to generate a schema manifest from non-disposable database ${target.databaseName}.`);
  }
  return value;
}

function tuple(row: readonly string[]): string {
  return `  ${JSON.stringify(row)},`;
}

async function main(): Promise<void> {
  const pool = createPostgresPool({
    connectionString: requireDisposableDatabaseUrl(),
    applicationName: "panda/schema-object-manifest",
    max: 1,
  });
  try {
    await createPandaSchemaVerifier(pool).assertCurrent();
    const catalog = await readPandaSchemaObjectCatalog(pool);

    const source = [
      "// Generated from a current disposable PostgreSQL database.",
      "// Run `pnpm ci:postgres-schema-manifest:update` after adding a migration.",
      "export const PANDA_EXPECTED_RELATIONS = Object.freeze([",
      ...catalog.relations.map(tuple),
      "] as const);",
      "",
      "export const PANDA_EXPECTED_CONSTRAINTS = Object.freeze([",
      ...catalog.constraints.map(tuple),
      "] as const);",
      "",
      "export const PANDA_EXPECTED_COLUMNS = Object.freeze([",
      ...catalog.columns.map(tuple),
      "] as const);",
      "",
    ].join("\n");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    await writeFile(path.join(repoRoot, "src/app/database/schema-object-manifest.ts"), source, "utf8");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
