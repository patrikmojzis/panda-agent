import {Command} from "commander";

import {writeCommandDescriptorHelp} from "../../domain/commands/cli.js";
import {postgresReadonlyQueryCommandDescriptor} from "./readonly-query-command.js";

interface PostgresReadonlyQueryCliOptions {
  help?: boolean;
  json?: boolean | string;
}

export function registerPostgresCommandHelpCommands(program: Command): void {
  const postgres = program
    .command("postgres")
    .description("Use agent-facing Postgres commands");
  const readonly = postgres
    .command("readonly")
    .description("Use scoped readonly Postgres commands");

  readonly
    .command("query")
    .description(postgresReadonlyQueryCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--sql <text>", "SQL text, @file, or @- when supported by the command")
    .option("--max-rows <n>", "Maximum result rows when supported by the command")
    .option("--schema-help", "Ask for schema guidance when supported by the command")
    .action((options: PostgresReadonlyQueryCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(postgresReadonlyQueryCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda postgres readonly query execution requires the agent command shim transport; use --help for the command contract.",
      );
    });
}
