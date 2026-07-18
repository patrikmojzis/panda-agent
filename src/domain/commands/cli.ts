import process from "node:process";

import {Option, type Command} from "commander";

import {commandDescriptorToJson, formatCommandHelp} from "./help.js";
import type {CommandRouteTree} from "./route-tree.js";
import type {CommandDescriptor} from "./types.js";

interface CommandCatalogCliOptions {
  output: "keys" | "json" | "table";
}

interface CommandRouteHelpOptions {
  help?: boolean;
  json?: boolean | string;
}

export function writeCommandDescriptorHelp(descriptor: CommandDescriptor, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(commandDescriptorToJson(descriptor, {
      includeSchemaCatalog: true,
    }), null, 2)}\n`);
    return;
  }

  process.stdout.write(formatCommandHelp(descriptor));
}

export function registerCommandCatalogCommands(
  program: Command,
  descriptors: readonly CommandDescriptor[],
): void {
  program
    .command("commands")
    .description("List agent-facing Panda commands available through the command seam")
    .addOption(new Option("--output <format>", "Output format")
      .choices(["keys", "json", "table"])
      .default("keys"))
    .action((options: CommandCatalogCliOptions) => {
      if (options.output === "json") {
        process.stdout.write(`${JSON.stringify({
          commands: descriptors.map((descriptor) => commandDescriptorToJson(descriptor)),
        }, null, 2)}\n`);
        return;
      }

      if (options.output === "table") {
        const rows = [
          ["COMMAND", "SUMMARY", "INPUT MODES", "OUTPUT MODES"],
          ...descriptors.map((descriptor) => [
            descriptor.name,
            descriptor.summary.replaceAll("\t", "\\t").replaceAll("\n", "\\n"),
            descriptor.inputModes.join(","),
            descriptor.outputModes.join(","),
          ]),
        ];
        process.stdout.write(`${rows.map((row) => row.join("\t")).join("\n")}\n`);
        return;
      }

      process.stdout.write(`${descriptors.map((descriptor) => descriptor.name).join("\n")}\n`);
    });
}

function findSubcommand(parent: Command, name: string): Command | undefined {
  return parent.commands.find((command) => command.name() === name);
}

function findCommandPath(parent: Command, argv: readonly string[]): Command | undefined {
  let current: Command | undefined = parent;
  for (const segment of argv) {
    current = current ? findSubcommand(current, segment) : undefined;
    if (!current) {
      return undefined;
    }
  }

  return current;
}

function ensureCommandGroup(parent: Command, argv: readonly string[]): Command {
  let current = parent;
  for (const [index, segment] of argv.entries()) {
    current = findSubcommand(current, segment)
      ?? current.command(segment).description(`Use agent-facing ${argv.slice(0, index + 1).join(" ")} commands`);
  }

  return current;
}

function registerCommandRouteHelp(
  parent: Command,
  route: CommandRouteTree["commands"][number],
): void {
  const leafName = route.argv.at(-1);
  if (!leafName) {
    return;
  }
  if (findCommandPath(parent, route.argv)) {
    return;
  }

  const group = ensureCommandGroup(parent, route.argv.slice(0, -1));
  group
    .command(leafName)
    .description(route.descriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: CommandRouteHelpOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(route.descriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        `panda ${route.argv.join(" ")} execution requires the agent command shim transport; use --help for the command contract.`,
      );
    });
}

export function registerCommandRouteHelpCommands(program: Command, routeTree: CommandRouteTree): void {
  for (const route of routeTree.commands) {
    registerCommandRouteHelp(program, route);
  }
}
