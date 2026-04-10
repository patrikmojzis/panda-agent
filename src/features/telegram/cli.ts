import process from "node:process";
import path from "node:path";

import {Command, InvalidArgumentError} from "commander";
import {Bot} from "grammy";

import type {ProviderName} from "../agent-core/types.js";
import {parseAgentKey} from "../agents/cli.js";
import {createDefaultIdentityInput, PostgresIdentityStore} from "../identity/index.js";
import {parseIdentityHandle} from "../identity/cli.js";
import {createPandaPool, requirePandaDatabaseUrl} from "../panda/runtime.js";
import {resolveDefaultPandaModel, resolveDefaultPandaProvider} from "../panda/provider-defaults.js";
import {requireTelegramBotToken, resolveTelegramMediaDir, TELEGRAM_SOURCE} from "./config.js";
import {TelegramService} from "./service.js";

interface TelegramIdentityCliOptions {
  dbUrl?: string;
}

interface TelegramRunCliOptions extends TelegramIdentityCliOptions {
  provider?: ProviderName;
  model?: string;
  agent?: string;
  cwd?: string;
  readOnlyDbUrl?: string;
}

interface TelegramPairCliOptions extends TelegramIdentityCliOptions {
  identity: string;
  actor: string;
}

function parseTelegramActorId(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidArgumentError("Telegram actor id must be a positive integer string.");
  }

  return trimmed;
}

async function resolveTelegramBotIdentity(): Promise<{
  connectorKey: string;
  id: string;
  username?: string;
}> {
  const bot = new Bot(requireTelegramBotToken());
  const me = await bot.api.getMe();
  const id = String(me.id);
  return {
    connectorKey: id,
    id,
    username: me.username ?? undefined,
  };
}

async function withTelegramIdentityStore<T>(
  options: TelegramIdentityCliOptions,
  fn: (store: PostgresIdentityStore) => Promise<T>,
): Promise<T> {
  const pool = createPandaPool(requirePandaDatabaseUrl(options.dbUrl));
  const store = new PostgresIdentityStore({
    pool,
  });

  try {
    await store.ensureSchema();
    return await fn(store);
  } finally {
    await pool.end();
  }
}

function createTelegramRunService(options: TelegramRunCliOptions = {}): TelegramService {
  const provider = options.provider ?? resolveDefaultPandaProvider();
  const model = options.model ?? resolveDefaultPandaModel(provider);

  return new TelegramService({
    token: requireTelegramBotToken(),
    dataDir: resolveTelegramMediaDir(),
    cwd: path.resolve(options.cwd ?? process.cwd()),
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    provider,
    model,
    agent: options.agent,
  });
}

export async function telegramWhoamiCommand(): Promise<void> {
  const me = await resolveTelegramBotIdentity();
  process.stdout.write(
    [
      `Telegram bot ${me.username ?? me.id}`,
      `id ${me.id}`,
      `connector ${me.connectorKey}`,
    ].join("\n") + "\n",
  );
}

export async function telegramPairCommand(options: TelegramPairCliOptions): Promise<void> {
  const botIdentity = await resolveTelegramBotIdentity();
  const defaultIdentity = createDefaultIdentityInput();

  await withTelegramIdentityStore(options, async (store) => {
    const identity = options.identity === defaultIdentity.handle
      ? await store.ensureIdentity(defaultIdentity)
      : await store.getIdentityByHandle(options.identity);
    const binding = await store.ensureIdentityBinding({
      source: TELEGRAM_SOURCE,
      connectorKey: botIdentity.connectorKey,
      externalActorId: options.actor,
      identityId: identity.id,
      metadata: {
        pairedVia: "telegram-cli",
      },
    });

    process.stdout.write(
      [
        `Paired Telegram actor ${binding.externalActorId}.`,
        `identity ${binding.identityId}`,
        `connector ${binding.connectorKey}`,
      ].join("\n") + "\n",
    );
  });
}

export async function telegramRunCommand(options: TelegramRunCliOptions): Promise<void> {
  const service = createTelegramRunService(options);

  const shutdown = async () => {
    await service.stop();
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
    await service.run();
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  }
}

export function registerTelegramCommands(program: Command, parseCliProvider: (value: string) => ProviderName): void {
  const telegramProgram = program
    .command("telegram")
    .description("Run and manage the Telegram channel");

  telegramProgram
    .command("whoami")
    .description("Show the Telegram bot identity and connector key")
    .action(() => {
      return telegramWhoamiCommand();
    });

  telegramProgram
    .command("pair")
    .description("Pair a Telegram user id to a Panda identity")
    .requiredOption("--identity <handle>", "Identity handle to pair", parseIdentityHandle)
    .requiredOption("--actor <telegramUserId>", "Telegram user id to pair", parseTelegramActorId)
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .action((options: TelegramPairCliOptions) => {
      return telegramPairCommand(options);
    });

  telegramProgram
    .command("run")
    .description("Run the Telegram ingress worker")
    .option(
      "-p, --provider <provider>",
      "LLM provider to use (`openai`, `openai-codex`, `anthropic`, or `anthropic-oauth`)",
      parseCliProvider,
    )
    .option("-m, --model <model>", "Model name override")
    .option("--agent <agentKey>", "Agent key to use", parseAgentKey)
    .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
    .action((options: TelegramRunCliOptions) => {
      return telegramRunCommand(options);
    });
}
