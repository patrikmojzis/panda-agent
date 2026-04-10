#!/usr/bin/env node

import process from "node:process";
import path from "node:path";

import {Command, InvalidArgumentError} from "commander";
import {formatProviderNameList, parseProviderName} from "./features/agent-core/index.js";
import {parseAgentKey, registerAgentCommands} from "./features/agents/cli.js";
import {parseIdentityHandle, registerIdentityCommands} from "./features/identity/cli.js";
import {createPandaDaemon} from "./features/panda/index.js";
import {summarizeMessageText} from "./features/panda/message-preview.js";
import {registerTelegramCommands} from "./features/telegram/cli.js";
import {type ChatCliOptions, runChatCli} from "./features/tui/index.js";
import {renderResumeHint} from "./features/tui/exit-hint.js";
import {createChatRuntime} from "./features/tui/runtime.js";
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

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }

  return parsed;
}

interface PandaRunCliOptions {
  provider?: ReturnType<typeof parseProviderName>;
  model?: string;
  cwd?: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
  daemonKey?: string;
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
    provider: options.provider ?? undefined,
    model: options.model,
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    daemonKey: options.daemonKey,
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

async function withCliRuntime<T>(
  options: Pick<ChatCliOptions, "provider" | "model" | "identity" | "agent" | "dbUrl">,
  fn: (runtime: Awaited<ReturnType<typeof createChatRuntime>>) => Promise<T>,
): Promise<T> {
  const runtime = await createChatRuntime({
    provider: options.provider,
    model: options.model,
    identity: options.identity,
    agent: options.agent,
    dbUrl: options.dbUrl,
  });

  try {
    return await fn(runtime);
  } finally {
    await runtime.close();
  }
}

async function listThreadsCommand(
  options: Pick<ChatCliOptions, "provider" | "model" | "identity" | "agent" | "dbUrl"> & { limit?: number },
): Promise<void> {
  await withCliRuntime(options, async (runtime) => {
    const summaries = await runtime.listThreadSummaries(options.limit ?? 20);

    if (summaries.length === 0) {
      process.stdout.write("No stored threads yet.\n");
      return;
    }

    for (const summary of summaries) {
      const last = summary.lastMessage
        ? summarizeMessageText(summary.lastMessage.message) || summary.lastMessage.source
        : "no messages yet";
      process.stdout.write(
        [
          summary.thread.id,
          `  provider ${summary.thread.provider ?? "default"} · model ${summary.thread.model ?? "default"} · updated ${new Date(summary.thread.updatedAt).toISOString()}`,
          `  messages ${summary.messageCount} · pending ${summary.pendingInputCount}`,
          `  last ${last.replace(/\s+/g, " ").trim()}`,
        ].join("\n") + "\n\n",
      );
    }
  });
}

async function inspectThreadCommand(
  threadId: string,
  options: Pick<ChatCliOptions, "provider" | "model" | "identity" | "agent" | "dbUrl">,
): Promise<void> {
  await withCliRuntime(options, async (runtime) => {
    const thread = await runtime.getThread(threadId);
    const transcript = await runtime.store.loadTranscript(threadId);

    process.stdout.write(
      [
        `identity ${runtime.identity.handle}`,
        `thread ${thread.id}`,
        `agent ${thread.agentKey}`,
        `provider ${thread.provider ?? "default"}`,
        `model ${thread.model ?? "default"}`,
        `created ${new Date(thread.createdAt).toISOString()}`,
        `updated ${new Date(thread.updatedAt).toISOString()}`,
        "",
      ].join("\n"),
    );

    if (transcript.length === 0) {
      process.stdout.write("No transcript messages yet.\n");
      return;
    }

    for (const entry of transcript.slice(-20)) {
      const summary = summarizeMessageText(entry.message) || entry.source;
      process.stdout.write(
        `[${entry.sequence}] ${entry.source} ${entry.message.role}: ${summary.replace(/\s+/g, " ").trim()}\n`,
      );
    }
  });
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
  .option(
    "-p, --provider <provider>",
    "LLM provider to use (`openai`, `openai-codex`, `anthropic`, or `anthropic-oauth`)",
    parseCliProvider,
  )
  .option("-m, --model <model>", "Model name override")
  .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
  .option("--db-url <url>", "Postgres connection string for thread persistence")
  .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
  .option("--daemon-key <key>", "Daemon lease key override")
  .action((options: PandaRunCliOptions) => {
    return runPandaCommand(options);
  });

program
  .command("threads")
  .description("List recent stored Panda chat threads")
  .option("--limit <count>", "How many threads to show", parsePositiveInt)
  .option("-p, --provider <provider>", "LLM provider to use", parseCliProvider)
  .option("-m, --model <model>", "Model name override")
  .option("--identity <handle>", "Identity handle to use", parseIdentityHandle)
  .option("--agent <agentKey>", "Agent key to use", parseAgentKey)
  .option("--db-url <url>", "Postgres connection string for thread persistence")
  .action((options) => {
    return listThreadsCommand(options);
  });

program
  .command("thread")
  .description("Show a stored thread and its recent transcript")
  .argument("<threadId>", "Thread id to inspect")
  .option("-p, --provider <provider>", "LLM provider to use", parseCliProvider)
  .option("-m, --model <model>", "Model name override")
  .option("--identity <handle>", "Identity handle to use", parseIdentityHandle)
  .option("--agent <agentKey>", "Agent key to use", parseAgentKey)
  .option("--db-url <url>", "Postgres connection string for thread persistence")
  .action((threadId: string, options) => {
    return inspectThreadCommand(threadId, options);
  });

registerAgentCommands(program);
registerIdentityCommands(program);
registerTelegramCommands(program);
registerWhatsAppCommands(program);

await program.parseAsync(process.argv);
