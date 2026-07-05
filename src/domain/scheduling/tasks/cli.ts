import process from "node:process";

import type {Command} from "commander";

import {writeCommandDescriptorHelp} from "../../commands/cli.js";
import type {CommandDescriptor} from "../../commands/types.js";
import {
    scheduleCancelCommandDescriptor,
    scheduleCreateCommandDescriptor,
    scheduleListCommandDescriptor,
    scheduleRunsCommandDescriptor,
    scheduleShowCommandDescriptor,
    scheduleUpdateCommandDescriptor,
} from "./commands.js";

interface ScheduleCliOptions {
  help?: boolean;
  json?: boolean | string;
}

function registerJsonScheduleCommand(schedule: Command, subcommand: string, descriptor: CommandDescriptor): void {
  schedule
    .command(subcommand)
    .description(descriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: ScheduleCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(descriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        `panda schedule ${subcommand} execution requires the agent command shim transport; use --help for the command contract.`,
      );
    });
}

export function registerScheduleCommandHelpCommands(program: Command): void {
  const schedule = program
    .command("schedule")
    .description("Use agent-facing scheduled task commands");

  registerJsonScheduleCommand(schedule, "list", scheduleListCommandDescriptor);
  registerJsonScheduleCommand(schedule, "show", scheduleShowCommandDescriptor);
  registerJsonScheduleCommand(schedule, "runs", scheduleRunsCommandDescriptor);
  registerJsonScheduleCommand(schedule, "create", scheduleCreateCommandDescriptor);
  registerJsonScheduleCommand(schedule, "update", scheduleUpdateCommandDescriptor);
  registerJsonScheduleCommand(schedule, "cancel", scheduleCancelCommandDescriptor);

  schedule.configureOutput({
    outputError(str) {
      process.stderr.write(str);
    },
  });
}
