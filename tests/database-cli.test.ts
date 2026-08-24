import {Command} from "commander";
import {describe, expect, it} from "vitest";

import {registerDatabaseCommands} from "../src/app/database/cli.js";

describe("database CLI", () => {
  it("keeps migration operations on an operator-only command group", () => {
    const program = new Command();

    registerDatabaseCommands(program);

    const database = program.commands.find((command) => command.name() === "db");
    expect(database?.commands.map((command) => command.name())).toEqual([
      "status",
      "migrate",
      "check",
    ]);
    const migrate = database?.commands.find((command) => command.name() === "migrate");
    expect(migrate?.options.map((option) => option.long)).toEqual([
      "--db-url",
      "--json",
      "--read-only-db-url",
      "--clear-read-only-role",
      "--writers-stopped",
    ]);
    expect(migrate?.options.find((option) => option.long === "--writers-stopped")?.mandatory).toBe(true);
  });
});
