import {Command} from "commander";
import {describe, expect, it} from "vitest";

import {commandUsesDatabase} from "../src/app/cli-shared.js";

describe("CLI database schema gate", () => {
  it("does not inherit the root chat database option into DB-free servers", () => {
    const program = new Command().option("--db-url <url>");
    const browserRunner = program.command("browser-runner");
    const bashServer = program.command("bash-server");
    const environmentManager = program.command("environment-manager");

    expect(commandUsesDatabase(browserRunner, program)).toBe(false);
    expect(commandUsesDatabase(bashServer, program)).toBe(false);
    expect(commandUsesDatabase(environmentManager, program)).toBe(false);
  });

  it("keeps the schema gate on root, direct, and grouped database commands", () => {
    const program = new Command().option("--db-url <url>");
    const run = program.command("run").option("--db-url <url>");
    const sessions = program.command("session").option("--db-url <url>");
    const listSessions = sessions.command("list");

    expect(commandUsesDatabase(program, program)).toBe(true);
    expect(commandUsesDatabase(run, program)).toBe(true);
    expect(commandUsesDatabase(listSessions, program)).toBe(true);
  });
});
