import process from "node:process";

import type {Command} from "commander";

import {writeCommandDescriptorHelp} from "../../domain/commands/cli.js";
import {ventSendCommandDescriptor} from "./vent-commands.js";

interface VentCliOptions {
  help?: boolean;
  json?: boolean | string;
  message?: string;
  stdin?: boolean;
}

export function registerVentCommandHelpCommands(program: Command): void {
  program
    .command("vent")
    .description(ventSendCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--message <text>", "Vent note text; use @file or @- for longer text")
    .option("--stdin", "Read vent note from stdin")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: VentCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(ventSendCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda vent execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  program.configureOutput({
    outputError(str) {
      process.stderr.write(str);
    },
  });
}
