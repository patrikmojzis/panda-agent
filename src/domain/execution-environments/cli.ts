import {Command} from "commander";

import {writeCommandDescriptorHelp} from "../commands/cli.js";
import type {CommandDescriptor} from "../commands/types.js";
import {
  environmentCreateCommandDescriptor,
  environmentListCommandDescriptor,
  environmentLogsCommandDescriptor,
  environmentShowCommandDescriptor,
  environmentStopCommandDescriptor,
} from "./commands.js";

interface EnvironmentCommandCliOptions {
  help?: boolean;
  json?: boolean | string;
}

function registerJsonEnvironmentCommand(program: Command, subcommand: string, descriptor: CommandDescriptor): void {
  program
    .command(subcommand)
    .description(descriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: EnvironmentCommandCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(descriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        `panda environment ${subcommand} execution requires the agent command shim transport; use --help for the command contract.`,
      );
    });
}

export function registerEnvironmentCommandHelpCommands(program: Command): void {
  const environmentProgram = program
    .command("environment")
    .description("Manage disposable execution environments");

  registerJsonEnvironmentCommand(environmentProgram, "create", environmentCreateCommandDescriptor);
  registerJsonEnvironmentCommand(environmentProgram, "list", environmentListCommandDescriptor);
  registerJsonEnvironmentCommand(environmentProgram, "show", environmentShowCommandDescriptor);
  registerJsonEnvironmentCommand(environmentProgram, "stop", environmentStopCommandDescriptor);
  registerJsonEnvironmentCommand(environmentProgram, "logs", environmentLogsCommandDescriptor);
}
