import process from "node:process";

import type {Command} from "commander";

import type {CommandDescriptor} from "../commands/types.js";
import {writeCommandDescriptorHelp} from "../commands/cli.js";
import {
  appActionCommandDescriptor,
  appCheckCommandDescriptor,
  appCreateCommandDescriptor,
  appLinkCreateCommandDescriptor,
  appListCommandDescriptor,
  appViewCommandDescriptor,
} from "./commands.js";

interface AppCliOptions {
  help?: boolean;
  json?: boolean | string;
}

function registerJsonAppCommand(root: Command, rootName: string, subcommand: string, descriptor: CommandDescriptor): void {
  root
    .command(subcommand)
    .description(descriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: AppCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(descriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        `panda ${rootName} ${subcommand} execution requires the agent command shim transport; use --help for the command contract.`,
      );
    });
}

export function registerAppCommandHelpCommands(program: Command): void {
  const microApp = program
    .command("micro-app")
    .description("Use agent-facing micro-app commands");

  registerJsonAppCommand(microApp, "micro-app", "check", appCheckCommandDescriptor);
  registerJsonAppCommand(microApp, "micro-app", "create", appCreateCommandDescriptor);
  registerJsonAppCommand(microApp, "micro-app", "list", appListCommandDescriptor);
  registerJsonAppCommand(microApp, "micro-app", "view", appViewCommandDescriptor);
  registerJsonAppCommand(microApp, "micro-app", "action", appActionCommandDescriptor);

  const microAppLink = microApp
    .command("link")
    .description("Use micro-app launch link commands");
  registerJsonAppCommand(microAppLink, "micro-app link", "create", appLinkCreateCommandDescriptor);

  microApp.configureOutput({
    outputError(str) {
      process.stderr.write(str);
    },
  });
}
