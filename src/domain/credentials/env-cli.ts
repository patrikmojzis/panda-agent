import process from "node:process";

import type {Command} from "commander";

import type {CommandDescriptor} from "../commands/types.js";
import {writeCommandDescriptorHelp} from "../commands/cli.js";
import {
  envClearCommandDescriptor,
  envListCommandDescriptor,
  envSetCommandDescriptor,
} from "./commands.js";

interface EnvCliOptions {
  help?: boolean;
  json?: boolean | string;
}

function registerEnvHelpCommand(
  env: Command,
  subcommand: string,
  descriptor: CommandDescriptor,
  options: {prefixFilter?: boolean; secretInput?: boolean} = {},
): void {
  const command = env
    .command(subcommand)
    .description(descriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired");

  if (options.secretInput) {
    command
      .option("--stdin", "Read secret input from stdin when supported by the command")
      .option("--from-file <path>", "Read secret input from a file when supported by the command");
  }
  if (options.prefixFilter) {
    command.option("--prefix <prefix>", "Filter env keys by prefix when supported by the command");
  }

  command
    .action((cliOptions: EnvCliOptions) => {
      if (cliOptions.help) {
        writeCommandDescriptorHelp(descriptor, Boolean(cliOptions.json));
        return;
      }

      throw new Error(
        `panda env ${subcommand} execution requires the agent command shim transport; use --help for the command contract.`,
      );
    });
}

export function registerEnvCommandHelpCommands(program: Command): void {
  const env = program
    .command("env")
    .description("Use agent-facing env secret commands");

  registerEnvHelpCommand(env, "list", envListCommandDescriptor, {prefixFilter: true});
  registerEnvHelpCommand(env, "set", envSetCommandDescriptor, {secretInput: true});
  registerEnvHelpCommand(env, "clear", envClearCommandDescriptor);

  env.configureOutput({
    outputError(str) {
      process.stderr.write(str);
    },
  });
}
