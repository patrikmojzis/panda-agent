import {readFileSync} from "node:fs";

import {describe, expect, it} from "vitest";
import * as domainAgents from "../src/domain/agents/index.js";
import * as domainWatches from "../src/domain/watches/index.js";

const architectureDoc = readFileSync(
  new URL("../docs/developers/architecture.md", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  exports: Record<string, { types: string; import: string }>;
};

function codeBulletsAfter(marker: string): string[] {
  const markerIndex = architectureDoc.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Architecture doc is missing marker: ${marker}`);
  }

  const entries: string[] = [];
  for (const line of architectureDoc.slice(markerIndex + marker.length).split(/\r?\n/)) {
    const match = line.match(/^- `([^`]+)`$/);
    if (match) {
      entries.push(match[1]);
      continue;
    }
    if (entries.length > 0 && line.trim() === "") {
      break;
    }
  }

  return entries;
}

function sourcePathForPackageEntrypoint(entrypoint: string): string {
  if (entrypoint === "panda") {
    return "src/index.ts";
  }
  if (!entrypoint.startsWith("panda/")) {
    throw new Error(`Unsupported package entrypoint in architecture doc: ${entrypoint}`);
  }

  return `src/${entrypoint.slice("panda/".length)}/index.ts`;
}

function packageExportKey(entrypoint: string): string {
  return entrypoint === "panda" ? "." : `./${entrypoint.slice("panda/".length)}`;
}

function packageExportValue(entrypoint: string): {types: string; import: string} {
  const distPath = sourcePathForPackageEntrypoint(entrypoint)
    .replace(/^src\//, "./dist/")
    .replace(/\.ts$/, "");
  return {
    types: `${distPath}.d.ts`,
    import: `${distPath}.js`,
  };
}

const DOCUMENTED_SOURCE_BARRELS = codeBulletsAfter("These are the source barrels that still deserve to exist:");
const DOCUMENTED_PACKAGE_ENTRYPOINTS = codeBulletsAfter("The supported package entrypoints are:");
const EXPECTED_EXPORTS = Object.fromEntries(
  DOCUMENTED_PACKAGE_ENTRYPOINTS.map((entrypoint) => [
    packageExportKey(entrypoint),
    packageExportValue(entrypoint),
  ]),
);

describe("package exports", () => {
  it("keeps the supported entrypoint docs aligned with package exports", () => {
    expect(new Set(DOCUMENTED_SOURCE_BARRELS)).toEqual(new Set([
      ...DOCUMENTED_PACKAGE_ENTRYPOINTS.map(sourcePathForPackageEntrypoint),
      "src/domain/sessions/index.ts",
    ]));
  });

  it("matches the intentional root and subpath entrypoints", () => {
    expect(packageJson.exports).toEqual(EXPECTED_EXPORTS);
  });

  it("keeps domain subpath barrels slim", () => {
    expect(domainAgents).not.toHaveProperty("discoverLegacyAgentSourceDirs");
    expect(domainAgents).not.toHaveProperty("importLegacyAgent");
    expect(domainAgents).not.toHaveProperty("planLegacyAgentImport");

    expect(domainWatches).not.toHaveProperty("defaultWatchSourceResolvers");
    expect(domainWatches).not.toHaveProperty("evaluateWatch");
    expect(domainWatches).not.toHaveProperty("validateReadOnlySqlQuery");
    expect(domainWatches).toHaveProperty("PostgresWatchStore");
    expect(domainWatches).toHaveProperty("WatchRunner");
  });
});
