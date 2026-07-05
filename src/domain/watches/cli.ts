import process from "node:process";

import type {Command} from "commander";

import type {CommandDescriptor} from "../commands/types.js";
import {writeCommandDescriptorHelp} from "../commands/cli.js";
import {
    watchCreateCommandDescriptor,
    watchDisableCommandDescriptor,
    watchListCommandDescriptor,
    watchRunsCommandDescriptor,
    watchShowCommandDescriptor,
    watchUpdateCommandDescriptor,
} from "./commands.js";

interface WatchCreateCliOptions {
  help?: boolean;
  json?: boolean | string;
}

function registerJsonWatchCommand(watch: Command, subcommand: string, descriptor: CommandDescriptor): void {
  watch
    .command(subcommand)
    .description(descriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: WatchCreateCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(descriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        `panda watch ${subcommand} execution requires the agent command shim transport; use --help for the command contract.`,
      );
    });
}

export function registerWatchCommandHelpCommands(program: Command): void {
  const watch = program
    .command("watch")
    .description("Use agent-facing watch commands");

  registerJsonWatchCommand(watch, "list", watchListCommandDescriptor);
  registerJsonWatchCommand(watch, "show", watchShowCommandDescriptor);
  registerJsonWatchCommand(watch, "runs", watchRunsCommandDescriptor);
  registerJsonWatchCommand(watch, "create", watchCreateCommandDescriptor);
  registerJsonWatchCommand(watch, "update", watchUpdateCommandDescriptor);
  registerJsonWatchCommand(watch, "disable", watchDisableCommandDescriptor);

  watch.configureOutput({
    outputError(str) {
      process.stderr.write(str);
    },
  });
}
