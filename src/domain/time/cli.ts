import {Command} from "commander";

import {writeCommandDescriptorHelp} from "../commands/cli.js";
import {timeNowCommandDescriptor} from "./commands.js";

interface TimeCommandCliOptions {
  help?: boolean;
  json?: boolean | string;
}

export function registerTimeCommandHelpCommands(program: Command): void {
  const timeProgram = program
    .command("time")
    .description("Read Panda runtime time");

  timeProgram
    .command("now")
    .description(timeNowCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass '{}' when execution transport is wired")
    .action((options: TimeCommandCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(timeNowCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda time now execution requires the agent command shim transport; use --help for the command contract.",
      );
    });
}
