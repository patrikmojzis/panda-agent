#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";
import { formatProviderNameList, parseProviderName } from "./features/agent-core/index.js";
import { runChatCli, type ChatCliOptions } from "./features/cli/index.js";

const program = new Command();

function parseCliProvider(value: string) {
  const provider = parseProviderName(value);
  if (provider) {
    return provider;
  }

  throw new InvalidArgumentError(`Provider must be one of ${formatProviderNameList()}.`);
}

async function runChatCommand(options: ChatCliOptions): Promise<void> {
  await runChatCli({
    provider: options.provider,
    model: options.model,
    cwd: options.cwd,
    instructions: options.instructions,
  });
}

function configureChatCommand(command: Command): Command {
  return command
    .option(
      "-p, --provider <provider>",
      "LLM provider to use (`openai`, `openai-codex`, `anthropic`, or `anthropic-oauth`)",
      parseCliProvider,
    )
    .option("-m, --model <model>", "Model name override")
    .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
    .option("-i, --instructions <instructions>", "Append custom Panda instructions")
    .action(runChatCommand);
}

program
  .name("panda")
  .description("Panda AI assistant")
  .version("0.1.0");

configureChatCommand(program);

configureChatCommand(
  program
    .command("chat")
    .description("Launch the Panda chat TUI"),
);

await program.parseAsync(process.argv);
