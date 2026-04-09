#!/usr/bin/env node

import process from "node:process";
import path from "node:path";

import { Command, InvalidArgumentError } from "commander";
import { formatProviderNameList, parseProviderName } from "./features/agent-core/index.js";
import { parseIdentityHandle, registerIdentityCommands } from "./features/identity/cli.js";
import { summarizeMessageText } from "./features/panda/message-preview.js";
import { registerTelegramCommands } from "./features/telegram/cli.js";
import { runChatCli, type ChatCliOptions } from "./features/tui/index.js";
import { renderResumeHint } from "./features/tui/exit-hint.js";
import { createChatRuntime } from "./features/tui/runtime.js";
import { registerWhatsAppCommands } from "./features/whatsapp/cli.js";

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

async function runChatCommand(options: ChatCliOptions): Promise<void> {
  const result = await runChatCli({
    provider: options.provider,
    model: options.model,
    identity: options.identity,
    cwd: options.cwd,
    resume: options.resume,
    threadId: options.threadId,
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
  });

  if (result.threadId) {
    process.stdout.write(`\n${renderResumeHint(result.threadId, process.stdout.columns ?? 80)}\n`);
  }
}

async function withCliRuntime<T>(
  options: Pick<ChatCliOptions, "provider" | "model" | "identity" | "cwd" | "dbUrl" | "readOnlyDbUrl">,
  fn: (runtime: Awaited<ReturnType<typeof createChatRuntime>>) => Promise<T>,
): Promise<T> {
  const runtime = await createChatRuntime({
    cwd: path.resolve(options.cwd ?? process.cwd()),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    provider: options.provider,
    model: options.model,
    identity: options.identity,
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
  });

  try {
    return await fn(runtime);
  } finally {
    await runtime.close();
  }
}

async function listThreadsCommand(
  options: Pick<ChatCliOptions, "provider" | "model" | "identity" | "cwd" | "dbUrl" | "readOnlyDbUrl"> & { limit?: number },
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
  options: Pick<ChatCliOptions, "provider" | "model" | "identity" | "cwd" | "dbUrl" | "readOnlyDbUrl">,
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
    .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
    .option("--resume <threadId>", "Resume an existing thread by id")
    .option("--thread-id <threadId>", "Use an explicit thread id for a new or existing chat")
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool");
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
  .command("threads")
  .description("List recent stored Panda chat threads")
  .option("--limit <count>", "How many threads to show", parsePositiveInt)
  .option("-p, --provider <provider>", "LLM provider to use", parseCliProvider)
  .option("-m, --model <model>", "Model name override")
  .option("--identity <handle>", "Identity handle to use", parseIdentityHandle)
  .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
  .option("--db-url <url>", "Postgres connection string for thread persistence")
  .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
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
  .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
  .option("--db-url <url>", "Postgres connection string for thread persistence")
  .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
  .action((threadId: string, options) => {
    return inspectThreadCommand(threadId, options);
  });

registerIdentityCommands(program);
registerTelegramCommands(program, parseCliProvider);
registerWhatsAppCommands(program, parseCliProvider);

await program.parseAsync(process.argv);
