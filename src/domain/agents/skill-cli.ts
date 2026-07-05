import process from "node:process";

import type {Command} from "commander";

import {writeCommandDescriptorHelp} from "../commands/cli.js";
import type {CommandDescriptor} from "../commands/types.js";
import {
  skillDeleteCommandDescriptor,
  skillListCommandDescriptor,
  skillLoadCommandDescriptor,
  skillPatchCommandDescriptor,
  skillSetCommandDescriptor,
  skillShowCommandDescriptor,
} from "./skill-commands.js";

interface SkillCommandCliOptions {
  help?: boolean;
  json?: boolean | string;
}

function registerSkillHelpCommand(
  skill: Command,
  name: "list" | "show" | "load" | "set" | "patch" | "delete",
  descriptor: CommandDescriptor,
): void {
  skill
    .command(name)
    .description(descriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: SkillCommandCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(descriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        `panda skill ${name} execution requires the agent command shim transport; use --help for the command contract.`,
      );
    });
}

export function registerSkillCommandHelpCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description("Use agent-facing skill commands");

  registerSkillHelpCommand(skill, "list", skillListCommandDescriptor);
  registerSkillHelpCommand(skill, "show", skillShowCommandDescriptor);
  registerSkillHelpCommand(skill, "load", skillLoadCommandDescriptor);
  registerSkillHelpCommand(skill, "set", skillSetCommandDescriptor);
  registerSkillHelpCommand(skill, "patch", skillPatchCommandDescriptor);
  registerSkillHelpCommand(skill, "delete", skillDeleteCommandDescriptor);

  skill.configureOutput({
    outputError(str) {
      process.stderr.write(str);
    },
  });
}
