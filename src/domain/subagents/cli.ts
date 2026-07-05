import process from "node:process";

import type {Command} from "commander";

import {writeCommandDescriptorHelp} from "../commands/cli.js";
import {
  subagentProfileDisableCommandDescriptor,
  subagentProfileEnableCommandDescriptor,
  subagentProfileListCommandDescriptor,
  subagentProfileShowCommandDescriptor,
  subagentProfileUpsertCommandDescriptor,
  subagentSpawnCommandDescriptor,
} from "./commands.js";

interface SubagentCommandCliOptions {
  help?: boolean;
  json?: boolean | string;
}

export function registerSubagentCommandHelpCommands(program: Command): void {
  const subagent = program
    .command("subagent")
    .description("Use agent-facing subagent profile commands");

  subagent
    .command("spawn")
    .description(subagentSpawnCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: SubagentCommandCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(subagentSpawnCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda subagent spawn execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  const profile = subagent
    .command("profile")
    .description("Use custom subagent profile commands");

  profile
    .command("list")
    .description(subagentProfileListCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: SubagentCommandCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(subagentProfileListCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda subagent profile list execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  profile
    .command("show")
    .description(subagentProfileShowCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: SubagentCommandCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(subagentProfileShowCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda subagent profile show execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  profile
    .command("upsert")
    .description(subagentProfileUpsertCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: SubagentCommandCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(subagentProfileUpsertCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda subagent profile upsert execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  profile
    .command("enable")
    .description(subagentProfileEnableCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: SubagentCommandCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(subagentProfileEnableCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda subagent profile enable execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  profile
    .command("disable")
    .description(subagentProfileDisableCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: SubagentCommandCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(subagentProfileDisableCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda subagent profile disable execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  subagent.configureOutput({
    outputError(str) {
      process.stderr.write(str);
    },
  });
}
