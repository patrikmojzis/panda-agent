import process from "node:process";
import path from "node:path";

import { Command, InvalidArgumentError } from "commander";

import type { ProviderName } from "../agent-core/types.js";
import { parseIdentityHandle } from "../identity/cli.js";
import { resolveDefaultPandaModel, resolveDefaultPandaProvider } from "../panda/provider-defaults.js";
import { requireTelegramBotToken, resolveTelegramMediaDir } from "./config.js";
import { TelegramService } from "./service.js";

interface TelegramBaseCliOptions {
  provider?: ProviderName;
  model?: string;
  cwd?: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
}

interface TelegramPairCliOptions extends TelegramBaseCliOptions {
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

function createTelegramService(options: TelegramBaseCliOptions = {}): TelegramService {
  const provider = options.provider ?? resolveDefaultPandaProvider();
  const model = options.model ?? resolveDefaultPandaModel(provider);

  return new TelegramService({
    token: requireTelegramBotToken(),
    dataDir: resolveTelegramMediaDir(),
    cwd: path.resolve(options.cwd ?? process.cwd()),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    dbUrl: options.dbUrl,
    readOnlyDbUrl: options.readOnlyDbUrl,
    provider,
    model,
  });
}

export async function telegramWhoamiCommand(options: TelegramBaseCliOptions = {}): Promise<void> {
  const service = createTelegramService(options);

  try {
    const me = await service.whoami();
    process.stdout.write(
      [
        `Telegram bot ${me.username ?? me.id}`,
        `id ${me.id}`,
        `connector ${me.connectorKey}`,
      ].join("\n") + "\n",
    );
  } finally {
    await service.stop();
  }
}

export async function telegramPairCommand(options: TelegramPairCliOptions): Promise<void> {
  const service = createTelegramService(options);

  try {
    const binding = await service.pair(options.identity, options.actor);
    process.stdout.write(
      [
        `Paired Telegram actor ${binding.externalActorId}.`,
        `identity ${binding.identityId}`,
        `connector ${binding.connectorKey}`,
      ].join("\n") + "\n",
    );
  } finally {
    await service.stop();
  }
}

export async function telegramRunCommand(options: TelegramBaseCliOptions): Promise<void> {
  const service = createTelegramService(options);

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
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
    .action((options: TelegramBaseCliOptions) => {
      return telegramWhoamiCommand(options);
    });

  telegramProgram
    .command("pair")
    .description("Pair a Telegram user id to a Panda identity")
    .requiredOption("--identity <handle>", "Identity handle to pair", parseIdentityHandle)
    .requiredOption("--actor <telegramUserId>", "Telegram user id to pair", parseTelegramActorId)
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
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
    .option("--cwd <cwd>", "Working directory the bash tool should treat as the workspace")
    .option("--db-url <url>", "Postgres connection string for thread persistence")
    .option("--read-only-db-url <url>", "Read-only Postgres connection string for the raw SQL tool")
    .action((options: TelegramBaseCliOptions) => {
      return telegramRunCommand(options);
    });
}
