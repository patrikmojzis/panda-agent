import {Command} from "commander";

import {writeCommandDescriptorHelp} from "../../domain/commands/cli.js";
import type {CommandDescriptor} from "../../domain/commands/types.js";
import {
  whisperTranscribeCommandDescriptor,
  whisperTranslateCommandDescriptor,
} from "./commands.js";

interface WhisperCommandCliOptions {
  help?: boolean;
  json?: boolean | string;
}

function registerWhisperHelpCommand(
  whisper: Command,
  subcommand: string,
  descriptor: CommandDescriptor,
): void {
  whisper
    .command(subcommand)
    .description(descriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: WhisperCommandCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(descriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        `panda whisper ${subcommand} execution requires the agent command shim transport; use --help for the command contract.`,
      );
    });
}

export function registerWhisperCommandHelpCommands(program: Command): void {
  const whisper = program
    .command("whisper")
    .description("Use agent-facing Whisper audio commands");

  registerWhisperHelpCommand(whisper, "transcribe", whisperTranscribeCommandDescriptor);
  registerWhisperHelpCommand(whisper, "translate", whisperTranslateCommandDescriptor);
}
