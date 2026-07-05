import {Command} from "commander";

import {writeCommandDescriptorHelp} from "../../domain/commands/cli.js";
import {imageGenerateCommandDescriptor} from "./image-generate-command.js";

interface ImageGenerateCliOptions {
  help?: boolean;
  json?: boolean | string;
}

export function registerImageCommandHelpCommands(program: Command): void {
  const image = program
    .command("image")
    .description("Use agent-facing image commands");

  image
    .command("generate")
    .description(imageGenerateCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: ImageGenerateCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(imageGenerateCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda image generate execution requires the agent command shim transport; use --help for the command contract.",
      );
    });
}
