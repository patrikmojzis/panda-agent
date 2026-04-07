#!/usr/bin/env node

import { Command } from "commander";
import { runChatCli } from "./features/cli/index.js";

const program = new Command();

program
  .name("panda")
  .description("Panda AI assistant")
  .version("0.1.0");

program
  .option(
    "-p, --provider <provider>",
    "LLM provider to use (`openai`, `openai-codex`, `anthropic`, or `anthropic-oauth`)",
  )
  .option("-m, --model <model>", "Model name override")
  .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
  .option("-i, --instructions <instructions>", "Append custom Panda instructions")
  .action(async (options) => {
    await runChatCli({
      provider: options.provider,
      model: options.model,
      cwd: options.cwd,
      instructions: options.instructions,
    });
  });

program
  .command("chat")
  .description("Launch the Panda chat TUI")
  .option(
    "-p, --provider <provider>",
    "LLM provider to use (`openai`, `openai-codex`, `anthropic`, or `anthropic-oauth`)",
  )
  .option("-m, --model <model>", "Model name override")
  .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
  .option("-i, --instructions <instructions>", "Append custom Panda instructions")
  .action(async (options) => {
    await runChatCli({
      provider: options.provider,
      model: options.model,
      cwd: options.cwd,
      instructions: options.instructions,
    });
  });

await program.parseAsync(process.argv);
