#!/usr/bin/env node

import process from "node:process";
import path from "node:path";

import {Command, InvalidArgumentError} from "commander";
import {parseAgentKey, registerAgentCommands} from "./features/agents/cli.js";
import {parseIdentityHandle, registerIdentityCommands} from "./features/identity/cli.js";
import {createPandaDaemon, resolvePandaBashRunnerOptions, startPandaBashRunner} from "./features/panda/index.js";
import {registerTelegramCommands} from "./features/telegram/cli.js";
import {type ChatCliOptions, runChatCli} from "./features/tui/index.js";
import {renderResumeHint} from "./features/tui/exit-hint.js";
import {registerWhatsAppCommands} from "./features/whatsapp/cli.js";

try {
  (process as NodeJS.Process & { loadEnvFile?: (path?: string) => void }).loadEnvFile?.();
} catch (error) {
  if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
    throw error;
  }
}

const program = new Command();
program.enablePositionalOptions();

interface PandaRunCliOptions {
  cwd?: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
}

interface PandaRunnerCliOptions {
  agent?: string;
  host?: string;
  outputDirectory?: string;
  port?: number;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new InvalidArgumentError("Port must be an integer between 1 and 65535.");
  }

  return parsed;
}

async function runChatCommand(options: ChatCliOptions): Promise<void> {
  const result = await runChatCli({
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

async function runRunnerCommand(options: PandaRunnerCliOptions): Promise<void> {
  const resolved = resolvePandaBashRunnerOptions({
    ...process.env,
    ...(options.agent ? { PANDA_RUNNER_AGENT_KEY: options.agent } : {}),
    ...(options.port !== undefined ? { PANDA_RUNNER_PORT: String(options.port) } : {}),
    ...(options.host ? { PANDA_RUNNER_HOST: options.host } : {}),
  });
  const runner = await startPandaBashRunner({
    ...resolved,
    ...(options.agent ? { agentKey: options.agent } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.outputDirectory ? { outputDirectory: path.resolve(options.outputDirectory) } : {}),
  });

  const shutdown = async () => {
    await runner.close();
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
    process.stdout.write(
      `Panda bash runner for ${runner.agentKey} listening on http://${runner.host}:${runner.port}\n`,
    );
    await new Promise<void>((resolve, reject) => {
      runner.server.once("close", resolve);
      runner.server.once("error", reject);
    });
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    await runner.close().catch(() => {});
  }
}

function configureChatOptions(command: Command): Command {
  return command
    .option("-m, --model <selector-or-alias>", "Model selector override")
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

program
  .command("runner")
  .description("Run a per-agent remote bash runner")
  .option("--agent <agentKey>", "Agent key this runner serves", parseAgentKey)
  .option("--host <host>", "Host to bind the runner server")
  .option("--port <port>", "Port to bind the runner server", parsePort)
  .option("--output-directory <path>", "Directory used for temporary runner output capture")
  .action((options: PandaRunnerCliOptions) => {
    return runRunnerCommand(options);
  });

registerAgentCommands(program);
registerIdentityCommands(program);
registerTelegramCommands(program);
registerWhatsAppCommands(program);

await program.parseAsync(process.argv);
