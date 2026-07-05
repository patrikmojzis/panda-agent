import process from "node:process";

import type {Command} from "commander";

import {writeCommandDescriptorHelp} from "../commands/cli.js";
import type {CommandDescriptor} from "../commands/types.js";
import {
  todoAddCommandDescriptor,
  todoBlockCommandDescriptor,
  todoClearCommandDescriptor,
  todoDoneCommandDescriptor,
  todoListCommandDescriptor,
  todoShowCommandDescriptor,
} from "./todo-commands.js";

interface TodoCliOptions {
  help?: boolean;
  json?: boolean | string;
}

export function registerTodoCommandHelpCommands(program: Command): void {
  const todo = program
    .command("todo")
    .description("Use agent-facing session todo commands");

  const registerTodoCommand = (subcommand: string, descriptor: CommandDescriptor): void => {
    todo
      .command(subcommand)
      .description(descriptor.summary)
      .helpOption(false)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .option("--help", "Show command help")
      .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
      .action((options: TodoCliOptions) => {
        if (options.help) {
          writeCommandDescriptorHelp(descriptor, Boolean(options.json));
          return;
        }

        throw new Error(
          `panda todo ${subcommand} execution requires the agent command shim transport; use --help for the command contract.`,
        );
      });
  };

  registerTodoCommand("add", todoAddCommandDescriptor);
  registerTodoCommand("list", todoListCommandDescriptor);
  registerTodoCommand("show", todoShowCommandDescriptor);
  registerTodoCommand("done", todoDoneCommandDescriptor);
  registerTodoCommand("block", todoBlockCommandDescriptor);
  registerTodoCommand("clear", todoClearCommandDescriptor);

  todo.configureOutput({
    outputError(str) {
      process.stderr.write(str);
    },
  });
}
