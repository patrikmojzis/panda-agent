#!/usr/bin/env node

import process from "node:process";
import path from "node:path";

import {Command, InvalidArgumentError} from "commander";
import {formatProviderNameList, parseProviderName} from "./features/agent-core/index.js";
import {parseAgentKey, registerAgentCommands} from "./features/agents/cli.js";
import {parseIdentityHandle, registerIdentityCommands} from "./features/identity/cli.js";
import {createPandaDaemon} from "./features/panda/index.js";
import {registerTelegramCommands} from "./features/telegram/cli.js";
import {type ChatCliOptions, runChatCli} from "./features/tui/index.js";
import {renderResumeHint} from "./features/tui/exit-hint.js";
import {registerWhatsAppCommands} from "./features/whatsapp/cli.js";

(process as NodeJS.Process & { loadEnvFile?: (path?: string) => void }).loadEnvFile?.();

const program = new Command();
program.enablePositionalOptions();

function parseCliProvider(value: string) {
  const provider = parseProviderName(value);
  if (provider) {
    return provider;
  }

  throw new InvalidArgumentError(`Provider must be one of ${formatProviderNameList()}.`);
}

interface PandaRunCliOptions {
  cwd?: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
}

async function runChatCommand(options: ChatCliOptions): Promise<void> {
  const result = await runChatCli({
    provider: options.provider,
    model: options.model,
    identity: options.identity,
    agent: options.agent,
    resume: options.resume,
    threadId: options.threadId,
    dbUrl: options.dbUrl,
  });

  if (result.threadId) {
    process.stdout.write(`\n${renderResumeHint(result.threadId, process.stdout.columns ?? 80)}\n`);
  }
}

async function runPandaCommand(options: PandaRunCliOptions): Promise<void> {
  const daemon = await createPandaDaemon({
    cwd: path.resolve(options.cwd ?? process.cwd()),
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
  });

  const shutdown = async () => {
    await daemon.stop();
  };

  const handleSigint = () => {
    void shutdown();
  };
  const handleSigterm = () => {
    void shutdown();
  };

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    await daemon.run();
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    await daemon.stop();
  }
}

function configureChatOptions(command: Command): Command {
  return command
    .option(
      "-p, --provider <provider>",
      "LLM provider to use (`openai`, `openai-codex`, `anthropic`, or `anthropic-oauth`)",
      parseCliProvider,
    )
    .option("-m, --model <model>", "Model name override")
    .option("--identity <handle>", "Identity handle to use for thread ownership", parseIdentityHandle)
    .option("--agent <agentKey>", "Agent key to use", parseAgentKey)
    .option("--resume <threadId>", "Resume an existing thread by id")
    .option("--thread-id <threadId>", "Use an explicit thread id for a new or existing chat")
    .option("--db-url <url>", "Postgres connection string for thread persistence");
}

function configureChatCommand(command: Command): Command {
  return configureChatOptions(command)
    .action((...args) => {
      const commandInstance = args.at(-1) as Command;
      return runChatCommand(commandInstance.opts<ChatCliOptions>());
    });
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

program
  .command("run")
  .description("Run the singular Panda runtime daemon")
  .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
  .option("--db-url <url>", "Postgres connection string for thread persistence")
  .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
  .action((options: PandaRunCliOptions) => {
    return runPandaCommand(options);
  });

registerAgentCommands(program);
registerIdentityCommands(program);
registerTelegramCommands(program);
registerWhatsAppCommands(program);

await program.parseAsync(process.argv);
