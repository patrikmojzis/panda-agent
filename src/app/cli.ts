#!/usr/bin/env node

import {randomBytes} from "node:crypto";
import process from "node:process";
import path from "node:path";

import {Command} from "commander";
import {DB_URL_OPTION_DESCRIPTION} from "./cli-shared.js";
import {parsePortOption} from "../lib/cli.js";
import {ensureSchemas, withPostgresPool} from "../lib/postgres-bootstrap.js";
import {createDaemon} from "./runtime/daemon.js";
import {registerA2ACommands} from "../domain/a2a/cli.js";
import {registerCommandCatalogCommands, registerCommandRouteHelpCommands} from "../domain/commands/cli.js";
import {buildCommandRouteTree} from "../domain/commands/route-tree.js";
import {registerAppCommandHelpCommands} from "../domain/apps/cli.js";
import {PostgresAgentStore} from "../domain/agents/postgres.js";
import {parseAgentKey, registerAgentCommands} from "../domain/agents/cli.js";
import {registerSkillCommandHelpCommands} from "../domain/agents/skill-cli.js";
import {registerCredentialCommands} from "../domain/credentials/cli.js";
import {registerEnvCommandHelpCommands} from "../domain/credentials/env-cli.js";
import {registerConnectorCommands} from "../domain/connectors/cli.js";
import {registerControlCommands} from "../domain/control/cli.js";
import {PostgresExecutionEnvironmentStore} from "../domain/execution-environments/postgres.js";
import {normalizeExecutionEnvironmentAlias} from "../domain/execution-environments/types.js";
import {registerEnvironmentCommandHelpCommands} from "../domain/execution-environments/cli.js";
import {registerEmailCommands} from "../domain/email/cli.js";
import {registerGatewayCommands} from "./gateway/cli.js";
import {parseIdentityHandle, registerIdentityCommands} from "../domain/identity/cli.js";
import {PostgresIdentityStore} from "../domain/identity/postgres.js";
import {registerSessionCommands} from "./sessions/cli.js";
import {PostgresSessionStore} from "../domain/sessions/postgres.js";
import {registerTodoCommandHelpCommands} from "../domain/sessions/todo-cli.js";
import {registerTimeCommandHelpCommands} from "../domain/time/cli.js";
import {registerScheduleCommandHelpCommands} from "../domain/scheduling/tasks/cli.js";
import {registerWikiCommands} from "../domain/wiki/cli.js";
import {registerWatchCommandHelpCommands} from "../domain/watches/cli.js";
import {registerWhisperCommandHelpCommands} from "../integrations/audio/cli.js";
import {registerTelegramCommands} from "../integrations/channels/telegram/cli.js";
import {registerDiscordCommands} from "../integrations/channels/discord/cli.js";
import {registerVentCommandHelpCommands} from "../integrations/panda-trace/vent-cli.js";
import {registerPostgresCommandHelpCommands} from "../integrations/postgres/cli.js";
import {registerWebCommandHelpCommands} from "../integrations/web/cli.js";
import {type ChatCliOptions, runChatCli} from "../ui/tui/chat.js";
import {renderResumeHint} from "../ui/tui/exit-hint.js";
import {registerWhatsAppCommands} from "../integrations/channels/whatsapp/cli.js";
import {resolveBrowserRunnerOptions, startBrowserRunner} from "../integrations/browser/runner.js";
import {resolveBashRunnerOptions, startBashRunner} from "../integrations/shell/bash-runner.js";
import {resolveWorkspaceCommandExecutorFromEnv} from "../integrations/shell/workspace-command-executor.js";
import {
    resolveExecutionEnvironmentManagerServerOptions,
    startExecutionEnvironmentManager,
} from "../integrations/shell/docker-execution-environment-manager.js";
import {registerObserveCommand} from "../ui/observe/cli.js";
import {registerSmokeCommand} from "./smoke/cli.js";
import {registerSubagentCommands} from "./subagents/cli.js";
import {registerSubagentCommandHelpCommands} from "../domain/subagents/cli.js";
import {DEFAULT_AGENT_COMMAND_DESCRIPTORS} from "../panda/commands/agent-command-descriptors.js";
import {DEFAULT_AGENT_COMMAND_CATALOG} from "../panda/commands/agent-command-modules.js";
import {registerImageCommandHelpCommands} from "../panda/commands/image-cli.js";

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

interface RunnerAttachCliOptions {
  agent?: string;
  dbUrl?: string;
  runnerUrl?: string;
  runnerCwd?: string;
  allowTools?: string;
  sharedSecret?: string;
  environmentId?: string;
  default?: boolean;
}

interface BrowserRunnerCliOptions {
  host?: string;
  port?: number;
  dataDirectory?: string;
}

interface EnvironmentManagerCliOptions {
  host?: string;
  port?: number;
  token?: string;
  dockerHost?: string;
  image?: string;
  network?: string;
  runnerCwd?: string;
  runnerPublicHost?: string;
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
    ...(options.agent ? { BASH_SERVER_AGENT_KEY: options.agent } : {}),
    ...(options.port !== undefined ? { BASH_SERVER_PORT: String(options.port) } : {}),
    ...(options.host ? { BASH_SERVER_HOST: options.host } : {}),
  });
  const commandExecutor = resolveWorkspaceCommandExecutorFromEnv(process.env);
  const runner = await startBashRunner({
    ...resolved,
    ...(options.agent ? { agentKey: options.agent } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.outputDirectory ? { outputDirectory: path.resolve(options.outputDirectory) } : {}),
    ...(commandExecutor ? { commandExecutor } : {}),
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
      `Panda bash server for ${runner.agentKey} listening on http://${runner.host}:${runner.port}\n`,
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

function parseRunnerAttachAllowedTools(value: string | undefined): string[] {
  const allowedTools = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowedTools.length === 0) {
    throw new Error("runner attach requires --allow-tools so selected targets fail closed.");
  }
  return [...new Set(allowedTools)];
}

function runnerAttachEnvironmentId(sessionId: string, alias: string): string {
  return `persistent_agent_runner:${sessionId}:${alias}`;
}

function runnerAttachPort(runnerUrl: string): string {
  try {
    const url = new URL(runnerUrl);
    if (url.port) return url.port;
    return url.protocol === "https:" ? "443" : "8080";
  } catch {
    return "8080";
  }
}

async function runRunnerAttachCommand(
  sessionRef: string,
  aliasInput: string,
  options: RunnerAttachCliOptions,
): Promise<void> {
  const runnerUrl = options.runnerUrl?.trim();
  if (!runnerUrl) {
    throw new Error("runner attach requires --runner-url <url>.");
  }
  const alias = normalizeExecutionEnvironmentAlias(aliasInput);
  const allowedTools = parseRunnerAttachAllowedTools(options.allowTools);
  const sharedSecret = options.sharedSecret?.trim() || randomBytes(32).toString("base64url");

  await withPostgresPool(options.dbUrl, async (pool) => {
    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const sessionStore = new PostgresSessionStore({pool});
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    await ensureSchemas([identityStore, agentStore, sessionStore, environmentStore]);

    const session = await sessionStore.resolveSessionRef({
      sessionRef,
      agentKey: options.agent,
    });
    const environmentId = options.environmentId?.trim() || runnerAttachEnvironmentId(session.id, alias);
    const environment = await environmentStore.createEnvironment({
      id: environmentId,
      agentKey: session.agentKey,
      kind: "persistent_agent_runner",
      state: "ready",
      runnerUrl,
      runnerCwd: options.runnerCwd?.trim() || undefined,
    });
    const binding = await environmentStore.bindSession({
      sessionId: session.id,
      environmentId: environment.id,
      alias,
      isDefault: options.default === true,
      toolPolicy: {allowedTools},
    });

    const runnerCwd = environment.runnerCwd ?? options.runnerCwd?.trim() ?? "/root/.panda/agents/" + session.agentKey;
    process.stdout.write([
      `Attached runner target ${binding.alias} to session ${session.id}.`,
      `environment ${binding.environmentId}`,
      `default ${binding.isDefault ? "yes" : "no"}`,
      `allowedTools ${allowedTools.join(",")}`,
      "",
      "Core env (set on panda-core before using the target):",
      `export BASH_SERVER_SHARED_SECRET=${sharedSecret}`,
      "",
      "Runner env (set on the personal PC/Mac runner):",
      `export BASH_SERVER_AGENT_KEY=${session.agentKey}`,
      `export BASH_SERVER_PORT=${runnerAttachPort(runnerUrl)}`,
      `export BASH_SERVER_SHARED_SECRET=${sharedSecret}`,
      `export BASH_SERVER_ALLOWED_ROOTS=${runnerCwd}`,
      "panda bash-server",
    ].join("\n") + "\n");
  });
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

async function runEnvironmentManagerCommand(options: EnvironmentManagerCliOptions): Promise<void> {
  const resolved = resolveExecutionEnvironmentManagerServerOptions({
    ...process.env,
    ...(options.host ? {PANDA_EXECUTION_ENVIRONMENT_MANAGER_HOST: options.host} : {}),
    ...(options.port !== undefined ? {PANDA_EXECUTION_ENVIRONMENT_MANAGER_PORT: String(options.port)} : {}),
    ...(options.token ? {PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN: options.token} : {}),
    ...(options.dockerHost ? {PANDA_DOCKER_HOST: options.dockerHost} : {}),
    ...(options.image ? {PANDA_DISPOSABLE_RUNNER_IMAGE: options.image} : {}),
    ...(options.network ? {PANDA_DISPOSABLE_RUNNER_NETWORK: options.network} : {}),
    ...(options.runnerCwd ? {PANDA_DISPOSABLE_RUNNER_CWD: options.runnerCwd} : {}),
    ...(options.runnerPublicHost ? {PANDA_DISPOSABLE_RUNNER_PUBLIC_HOST: options.runnerPublicHost} : {}),
  });
  const manager = await startExecutionEnvironmentManager(resolved);

  const shutdown = async () => {
    await manager.close();
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
    process.stdout.write(`Panda execution environment manager listening on http://${manager.host}:${manager.port}\n`);
    await new Promise<void>((resolve, reject) => {
      manager.server.once("close", resolve);
      manager.server.once("error", reject);
    });
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    await manager.close().catch(() => {});
  }
}

function configureChatOptions(command: Command): Command {
  return command
    .option("--identity <handle>", "Identity handle to use as the active participant (required)", parseIdentityHandle)
    .option("--agent <agentKey>", "Agent key to use", parseAgentKey)
    .option("--session <sessionRef>", "Open a chat on an existing session id, or alias with --agent")
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
registerSubagentCommands(program);
registerSubagentCommandHelpCommands(program);

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
  .option("--apps-port <port>", "Port to bind the local micro-app server", parsePortOption)
  .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
  .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
  .action((options: RunCliOptions) => {
    return runRuntimeCommand(options);
  });

function registerBashServerCommand(command: Command, description: string, options: {includeAttach?: boolean} = {}): void {
  command
    .description(description)
    .option("--agent <agentKey>", "Agent key this bash server serves", parseAgentKey)
    .option("--host <host>", "Host to bind the bash server")
    .option("--port <port>", "Port to bind the bash server", parsePortOption)
    .option("--output-directory <path>", "Directory used for temporary bash server output capture")
    .action((runnerOptions: RunnerCliOptions) => {
      return runRunnerCommand(runnerOptions);
    });

  if (options.includeAttach) {
    command
      .command("attach")
      .description("Register and bind a personal PC/Mac runner target to a session")
      .argument("<sessionRef>", "Session id, or alias with --agent")
      .argument("<alias>", "Target alias, for example mac")
      .option("--agent <agentKey>", "Agent key for alias lookup", parseAgentKey)
      .option("--runner-url <url>", "Reachable runner base URL")
      .option("--runner-cwd <path>", "Initial cwd inside the personal runner")
      .option("--allow-tools <csv>", "Comma-separated tools allowed on this target")
      .option("--shared-secret <secret>", "Shared secret for core-to-runner POST requests; generated if omitted")
      .option("--environment-id <id>", "Existing or desired execution environment id")
      .option("--default", "Make this binding the session default target")
      .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
      .action((sessionRef: string, alias: string, attachOptions: RunnerAttachCliOptions) => {
        return runRunnerAttachCommand(sessionRef, alias, attachOptions);
      });
  }
}

registerBashServerCommand(
  program.command("bash-server"),
  "Run a per-agent remote bash server",
);

registerBashServerCommand(
  program.command("runner"),
  "Compatibility alias for bash-server; run a per-agent remote bash server",
  {includeAttach: true},
);

program
  .command("browser-runner")
  .description("Run the isolated browser runner")
  .option("--host <host>", "Host to bind the browser runner server")
  .option("--port <port>", "Port to bind the browser runner server", parsePortOption)
  .option("--data-directory <path>", "Directory for browser runner session state and scratch artifacts")
  .action((options: BrowserRunnerCliOptions) => {
    return runBrowserRunnerCommand(options);
  });

program
  .command("environment-manager")
  .description("Run the disposable execution environment manager")
  .option("--host <host>", "Host to bind the environment manager server")
  .option("--port <port>", "Port to bind the environment manager server", parsePortOption)
  .option("--token <token>", "Bearer token required by panda-core")
  .option("--docker-host <host>", "Docker Engine host, for example unix:///var/run/docker.sock")
  .option("--image <image>", "Docker image used for disposable bash runners")
  .option("--network <network>", "Docker network for disposable runner containers")
  .option("--runner-cwd <path>", "Initial cwd inside disposable runner containers")
  .option("--runner-public-host <host>", "Host panda-core should use for published disposable runner ports")
  .action((options: EnvironmentManagerCliOptions) => {
    return runEnvironmentManagerCommand(options);
  });

registerAgentCommands(program);
registerA2ACommands(program);
registerCredentialCommands(program);
registerConnectorCommands(program);
registerControlCommands(program);
registerCommandCatalogCommands(program, DEFAULT_AGENT_COMMAND_DESCRIPTORS);
registerEmailCommands(program);
registerGatewayCommands(program);
registerIdentityCommands(program);
registerAppCommandHelpCommands(program);
registerEnvironmentCommandHelpCommands(program);
registerEnvCommandHelpCommands(program);
registerVentCommandHelpCommands(program);
registerPostgresCommandHelpCommands(program);
registerWebCommandHelpCommands(program);
registerImageCommandHelpCommands(program);
registerWhisperCommandHelpCommands(program);
registerScheduleCommandHelpCommands(program);
registerSessionCommands(program);
registerTimeCommandHelpCommands(program);
registerSkillCommandHelpCommands(program);
registerTodoCommandHelpCommands(program);
registerWatchCommandHelpCommands(program);
registerWikiCommands(program);
registerTelegramCommands(program);
registerDiscordCommands(program);
registerWhatsAppCommands(program);
registerCommandRouteHelpCommands(program, buildCommandRouteTree({
  routes: DEFAULT_AGENT_COMMAND_CATALOG.routes(),
  descriptors: DEFAULT_AGENT_COMMAND_DESCRIPTORS,
}));

await program.parseAsync(process.argv);
