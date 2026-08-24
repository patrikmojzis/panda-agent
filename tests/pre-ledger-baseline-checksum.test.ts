import {createHash} from "node:crypto";
import path from "node:path";

import {build} from "esbuild";
import {describe, expect, it} from "vitest";

import {
  PANDA_SCHEMA_MIGRATIONS,
  PANDA_SCHEMA_MIGRATION_SOURCES,
} from "../src/app/database/migration-catalog.js";
import {PANDA_SCHEMA_VERSION} from "../src/integrations/postgres/schema-version.js";

describe("Postgres migration checksums", () => {
  it("keeps the runtime verifier manifest identical to the executable catalog", () => {
    expect(PANDA_SCHEMA_MIGRATIONS.map(({id, description, checksum}) => ({
      id,
      description,
      checksum,
    }))).toEqual(PANDA_SCHEMA_VERSION);
  });

  it("pins every bundled executable migration body", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    expect(Object.keys(PANDA_SCHEMA_MIGRATION_SOURCES).toSorted())
      .toEqual(PANDA_SCHEMA_MIGRATIONS.map((migration) => migration.id).toSorted());

    for (const migration of PANDA_SCHEMA_MIGRATIONS) {
      const entryPoint = PANDA_SCHEMA_MIGRATION_SOURCES[migration.id];
      if (!entryPoint) throw new Error(`Migration ${migration.id} has no checksum source.`);
      const result = await build({
        absWorkingDir: repoRoot,
        entryPoints: [entryPoint],
        bundle: true,
        charset: "utf8",
        format: "esm",
        legalComments: "none",
        minifySyntax: true,
        minifyWhitespace: true,
        packages: "external",
        platform: "node",
        target: "node24",
        treeShaking: true,
        write: false,
      });
      const bundled = result.outputFiles[0]?.text;
      if (!bundled) throw new Error(`Migration ${migration.id} checksum build produced no output.`);
      expect(bundled).toContain(migration.checksum);
      const normalized = bundled.replaceAll(migration.checksum, "<migration-checksum>");
      const checksum = createHash("sha256").update(normalized).digest("hex");

      expect(checksum, migration.id).toBe(migration.checksum);
    }
  });
});
