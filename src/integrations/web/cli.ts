import {Command} from "commander";

import {writeCommandDescriptorHelp} from "../../domain/commands/cli.js";
import type {CommandDescriptor} from "../../domain/commands/types.js";
import {
  braveImageSearchCommandDescriptor,
  braveLlmContextCommandDescriptor,
  braveNewsSearchCommandDescriptor,
  bravePlaceDescriptionCommandDescriptor,
  bravePlacePoiCommandDescriptor,
  bravePlaceSearchCommandDescriptor,
  braveVideoSearchCommandDescriptor,
  braveWebSearchCommandDescriptor,
  openAIWebResearchCommandDescriptor,
  webFetchCommandDescriptor,
  webReadCommandDescriptor,
} from "./commands.js";

interface WebCommandHelpOptions {
  help?: boolean;
  json?: boolean | string;
}

function registerHelpCommand(
  parent: Command,
  subcommand: string,
  descriptor: CommandDescriptor,
  executionPath: string,
): void {
  parent
    .command(subcommand)
    .description(descriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .action((options: WebCommandHelpOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(descriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        `panda ${executionPath} execution requires the agent command shim transport; use --help for the command contract.`,
      );
    });
}

export function registerWebCommandHelpCommands(program: Command): void {
  const web = program
    .command("web")
    .description("Use agent-facing web commands");
  registerHelpCommand(web, "fetch", webFetchCommandDescriptor, "web fetch");
  registerHelpCommand(web, "read", webReadCommandDescriptor, "web read");

  const brave = program
    .command("brave")
    .description("Use agent-facing Brave Search commands");
  registerHelpCommand(brave.command("web").description("Use Brave web search"), "search", braveWebSearchCommandDescriptor, "brave web search");
  registerHelpCommand(brave.command("news").description("Use Brave news search"), "search", braveNewsSearchCommandDescriptor, "brave news search");
  registerHelpCommand(brave.command("video").description("Use Brave video search"), "search", braveVideoSearchCommandDescriptor, "brave video search");
  registerHelpCommand(brave.command("image").description("Use Brave image search"), "search", braveImageSearchCommandDescriptor, "brave image search");
  registerHelpCommand(brave.command("llm").description("Use Brave LLM context search"), "context", braveLlmContextCommandDescriptor, "brave llm context");
  const bravePlace = brave
    .command("place")
    .description("Use Brave place search");
  registerHelpCommand(bravePlace, "search", bravePlaceSearchCommandDescriptor, "brave place search");
  registerHelpCommand(bravePlace, "poi", bravePlacePoiCommandDescriptor, "brave place poi");
  registerHelpCommand(bravePlace, "description", bravePlaceDescriptionCommandDescriptor, "brave place description");

  const openai = program
    .command("openai")
    .description("Use agent-facing OpenAI provider commands");
  registerHelpCommand(openai, "web-research", openAIWebResearchCommandDescriptor, "openai web-research");
}
