#!/usr/bin/env node

import process from "node:process";
import path from "node:path";

import {Command, InvalidArgumentError} from "commander";
import {DB_URL_OPTION_DESCRIPTION} from "./cli-shared.js";
import {createDaemon} from "./runtime/index.js";
import {registerA2ACommands} from "../domain/a2a/cli.js";
import {parseAgentKey, registerAgentCommands} from "../domain/agents/cli.js";
import {registerCredentialCommands} from "../domain/credentials/cli.js";
import {registerEmailCommands} from "../domain/email/cli.js";
import {registerGatewayCommands} from "../domain/gateway/cli.js";
import {parseIdentityHandle, registerIdentityCommands} from "../domain/identity/cli.js";
import {registerSidecarCommands} from "../domain/sidecars/cli.js";
import {registerSessionCommands} from "../domain/sessions/cli.js";
import {registerTelepathyCommands} from "../domain/telepathy/index.js";
import {registerWikiCommands} from "../domain/wiki/index.js";
import {registerTelegramCommands} from "../integrations/channels/telegram/cli.js";
import {type ChatCliOptions, runChatCli} from "../ui/tui/chat.js";
import {renderResumeHint} from "../ui/tui/exit-hint.js";
import {registerWhatsAppCommands} from "../integrations/channels/whatsapp/cli.js";
import {resolveBrowserRunnerOptions, startBrowserRunner} from "../integrations/browser/index.js";
import {resolveBashRunnerOptions, startBashRunner} from "../integrations/shell/index.js";
import {registerObserveCommand} from "../ui/observe/cli.js";
import {registerSmokeCommand} from "./smoke/cli.js";

try {
  (process as NodeJS.Process & { loadEnvFile?: (path?: string) => void }).loadEnvFile?.();
} catch (error) {
  if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
    throw error;
  }
}

const program = new Command();
program.enablePositionalOptions();

interface RunCliOptions {
  appsHost?: string;
  appsPort?: number;
  cwd?: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
}

interface RunnerCliOptions {
  agent?: string;
  host?: string;
  outputDirectory?: string;
  port?: number;
}

interface BrowserRunnerCliOptions {
  host?: string;
  port?: number;
  dataDirectory?: string;
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
    identity: options.identity,
    agent: options.agent,
    session: options.session,
    dbUrl: options.dbUrl,
  });

  if (result.sessionId) {
    process.stdout.write(`\n${renderResumeHint(result.sessionId, process.stdout.columns ?? 80)}\n`);
  }
}

async function runRuntimeCommand(options: RunCliOptions): Promise<void> {
  if (options.appsHost) {
    process.env.PANDA_APPS_HOST = options.appsHost;
  }
  if (options.appsPort !== undefined) {
    process.env.PANDA_APPS_PORT = String(options.appsPort);
  }

  const daemon = await createDaemon({
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

async function runRunnerCommand(options: RunnerCliOptions): Promise<void> {
  const resolved = resolveBashRunnerOptions({
    ...process.env,
    ...(options.agent ? { RUNNER_AGENT_KEY: options.agent } : {}),
    ...(options.port !== undefined ? { RUNNER_PORT: String(options.port) } : {}),
    ...(options.host ? { RUNNER_HOST: options.host } : {}),
  });
  const runner = await startBashRunner({
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

async function runBrowserRunnerCommand(options: BrowserRunnerCliOptions): Promise<void> {
  const resolved = resolveBrowserRunnerOptions({
    ...process.env,
    ...(options.port !== undefined ? { BROWSER_RUNNER_PORT: String(options.port) } : {}),
    ...(options.host ? { BROWSER_RUNNER_HOST: options.host } : {}),
    ...(options.dataDirectory ? { BROWSER_RUNNER_DATA_DIR: path.resolve(options.dataDirectory) } : {}),
  });
  const runner = await startBrowserRunner({
    ...resolved,
    ...(options.port !== undefined ? {port: options.port} : {}),
    ...(options.host ? {host: options.host} : {}),
    ...(options.dataDirectory ? {dataDir: path.resolve(options.dataDirectory)} : {}),
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
    process.stdout.write(`Panda browser runner listening on http://${runner.host}:${runner.port}\n`);
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
    .option("--identity <handle>", "Identity handle to use as the active participant (required)", parseIdentityHandle)
    .option("--agent <agentKey>", "Agent key to use", parseAgentKey)
    .option("--session <sessionId>", "Open a chat on an existing session id")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION);
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
registerSmokeCommand(program);

configureChatCommand(
  program
    .command("chat")
    .description("Launch the Panda chat TUI"),
);
registerObserveCommand(program);

program
  .command("run")
  .description("Run the singular Panda runtime daemon")
  .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
  .option("--apps-host <host>", "Host to bind the local micro-app server")
  .option("--apps-port <port>", "Port to bind the local micro-app server", parsePort)
  .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
  .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
  .action((options: RunCliOptions) => {
    return runRuntimeCommand(options);
  });

program
  .command("runner")
  .description("Run a per-agent remote bash runner")
  .option("--agent <agentKey>", "Agent key this runner serves", parseAgentKey)
  .option("--host <host>", "Host to bind the runner server")
  .option("--port <port>", "Port to bind the runner server", parsePort)
  .option("--output-directory <path>", "Directory used for temporary runner output capture")
  .action((options: RunnerCliOptions) => {
    return runRunnerCommand(options);
  });

program
  .command("browser-runner")
  .description("Run the isolated browser runner")
  .option("--host <host>", "Host to bind the browser runner server")
  .option("--port <port>", "Port to bind the browser runner server", parsePort)
  .option("--data-directory <path>", "Directory for browser runner session state and scratch artifacts")
  .action((options: BrowserRunnerCliOptions) => {
    return runBrowserRunnerCommand(options);
  });

registerAgentCommands(program);
registerA2ACommands(program);
registerCredentialCommands(program);
registerEmailCommands(program);
registerGatewayCommands(program);
registerIdentityCommands(program);
registerSidecarCommands(program);
registerSessionCommands(program);
registerTelepathyCommands(program);
registerWikiCommands(program);
registerTelegramCommands(program);
registerWhatsAppCommands(program);

await program.parseAsync(process.argv);
