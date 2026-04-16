import path from "node:path";

import {describe, expect, it} from "vitest";

import {
    requireSmokeDatabaseUrl,
    resolveSmokeArtifactDirectory,
    resolveSmokeDatabaseUrl,
    resolveSmokeModelSelector,
} from "../src/app/smoke/config.js";
import {looksLikeDisposableDatabaseName, resolveSmokeDatabaseTarget,} from "../src/app/smoke/database.js";

describe("smoke config", () => {
  it("resolves TEST_DATABASE_URL without falling back to PANDA_DATABASE_URL", () => {
    expect(resolveSmokeDatabaseUrl(undefined, {
      PANDA_DATABASE_URL: "postgres://ignored/panda",
      TEST_DATABASE_URL: "postgres://live/smoke_db",
    })).toBe("postgres://live/smoke_db");
  });

  it("prefers an explicit smoke database url", () => {
    expect(resolveSmokeDatabaseUrl("postgres://explicit/smoke_db", {
      TEST_DATABASE_URL: "postgres://env/smoke_db",
    })).toBe("postgres://explicit/smoke_db");
  });

  it("fails fast when no smoke database url is configured", () => {
    expect(() => requireSmokeDatabaseUrl(undefined, {
      PANDA_DATABASE_URL: "postgres://ignored/panda",
    })).toThrow("Live smoke requires Postgres");
  });

  it("prefers TEST_MODEL unless an explicit model override is provided", () => {
    expect(resolveSmokeModelSelector(undefined, {
      TEST_MODEL: "openai/gpt-5.4-mini",
    })).toBe("openai/gpt-5.4-mini");
    expect(resolveSmokeModelSelector("anthropic/claude-sonnet", {
      TEST_MODEL: "openai/gpt-5.4-mini",
    })).toBe("anthropic/claude-sonnet");
  });

  it("builds a timestamped artifact directory when one is not provided", () => {
    const resolved = resolveSmokeArtifactDirectory({
      agentKey: "Panda Agent",
      cwd: "/workspace/panda",
      now: new Date("2026-04-16T12:00:01.234Z"),
    });

    expect(resolved).toBe(path.resolve(
      "/workspace/panda",
      ".temp/panda-smoke/2026-04-16T12-00-01-234Z-panda-agent",
    ));
  });
});

describe("smoke database reset", () => {
  it("parses the target database and companion postgres admin url", () => {
    expect(resolveSmokeDatabaseTarget(
      "postgres://panda:secret@localhost:5432/panda_smoke?sslmode=disable",
    )).toEqual({
      adminConnectionString: "postgres://panda:secret@localhost:5432/postgres?sslmode=disable",
      connectionString: "postgres://panda:secret@localhost:5432/panda_smoke?sslmode=disable",
      databaseName: "panda_smoke",
    });
  });

  it("only treats disposable-looking names as safe by default", () => {
    expect(looksLikeDisposableDatabaseName("panda_smoke")).toBe(true);
    expect(looksLikeDisposableDatabaseName("panda_test")).toBe(true);
    expect(looksLikeDisposableDatabaseName("panda_tmp")).toBe(true);
    expect(looksLikeDisposableDatabaseName("panda")).toBe(false);
  });
});
