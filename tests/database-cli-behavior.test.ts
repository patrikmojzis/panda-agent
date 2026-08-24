import process from "node:process";

import {Command} from "commander";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const databaseCliMocks = vi.hoisted(() => ({
  createMigrator: vi.fn(),
  end: vi.fn<() => Promise<void>>(),
  migrate: vi.fn(),
}));

vi.mock("../src/lib/postgres-database.js", () => ({
  createPostgresPool: () => ({end: databaseCliMocks.end}),
  requireDatabaseUrl: (value?: string) => value ?? "postgresql://example/panda",
}));

vi.mock("../src/app/database/migration-catalog.js", () => ({
  createPandaSchemaMigrator: databaseCliMocks.createMigrator,
}));

import {registerDatabaseCommands} from "../src/app/database/cli.js";

const CURRENT_STATUS = {
  applied: [],
  pending: [],
  unknownApplied: [],
  nonPrefixApplied: [],
  changedApplied: [],
  current: true,
};

async function runMigrate(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  program.configureOutput({writeOut: () => {}, writeErr: () => {}});
  registerDatabaseCommands(program);
  await program.parseAsync(["node", "panda", "db", "migrate", ...args]);
}

describe("database CLI migration safety", () => {
  const originalReadonlyUrl = process.env.READONLY_DATABASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.READONLY_DATABASE_URL;
    databaseCliMocks.end.mockResolvedValue();
    databaseCliMocks.migrate.mockResolvedValue(CURRENT_STATUS);
    databaseCliMocks.createMigrator.mockReturnValue({migrate: databaseCliMocks.migrate});
  });

  afterEach(() => {
    if (originalReadonlyUrl === undefined) delete process.env.READONLY_DATABASE_URL;
    else process.env.READONLY_DATABASE_URL = originalReadonlyUrl;
  });

  it("preserves read-only role configuration when no role input is supplied", async () => {
    await runMigrate("--writers-stopped", "--json");

    expect(databaseCliMocks.createMigrator).toHaveBeenCalledWith(expect.objectContaining({
      readonlyRole: undefined,
    }));
  });

  it("refuses migration without writer-quiescence acknowledgement", async () => {
    await expect(runMigrate("--json")).rejects.toEqual(expect.objectContaining({
      code: "commander.missingMandatoryOptionValue",
    }));

    expect(databaseCliMocks.createMigrator).not.toHaveBeenCalled();
  });

  it("requires an explicit flag to clear the configured read-only role", async () => {
    process.env.READONLY_DATABASE_URL = "postgresql://old_reader:secret@example/panda";

    await runMigrate("--writers-stopped", "--clear-read-only-role", "--json");

    expect(databaseCliMocks.createMigrator).toHaveBeenCalledWith(expect.objectContaining({
      readonlyRole: null,
    }));
  });

  it("rejects conflicting read-only role instructions", async () => {
    await expect(runMigrate(
      "--writers-stopped",
      "--clear-read-only-role",
      "--read-only-db-url",
      "postgresql://new_reader:secret@example/panda",
      "--json",
    )).rejects.toThrow("cannot be combined");

    expect(databaseCliMocks.migrate).not.toHaveBeenCalled();
    expect(databaseCliMocks.end).toHaveBeenCalledOnce();
  });
});
