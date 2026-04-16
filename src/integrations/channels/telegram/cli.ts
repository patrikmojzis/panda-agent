import process from "node:process";

import {Command, InvalidArgumentError} from "commander";
import {Bot} from "grammy";

import {DB_URL_OPTION_DESCRIPTION} from "../../../app/cli-shared.js";
import {createDefaultIdentityInput, PostgresIdentityStore} from "../../../domain/identity/index.js";
import {parseIdentityHandle} from "../../../domain/identity/cli.js";
import {ensureSchemas, withPostgresPool} from "../../../app/runtime/postgres-bootstrap.js";
import {requireTelegramBotToken, resolveTelegramMediaDir, TELEGRAM_SOURCE} from "./config.js";
import {TelegramService} from "./service.js";

interface TelegramIdentityCliOptions {
  dbUrl?: string;
}

type TelegramRunCliOptions = TelegramIdentityCliOptions;

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
  return withPostgresPool(options.dbUrl, async (pool) => {
    const store = new PostgresIdentityStore({pool});
    await ensureSchemas([store]);
    return fn(store);
  });
}

function createTelegramRunService(options: TelegramRunCliOptions = {}): TelegramService {
  return new TelegramService({
    token: requireTelegramBotToken(),
    dataDir: resolveTelegramMediaDir(),
    dbUrl: options.dbUrl,
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

export function registerTelegramCommands(program: Command): void {
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
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelegramPairCliOptions) => {
      return telegramPairCommand(options);
    });

  telegramProgram
    .command("run")
    .description("Run the Telegram ingress worker")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelegramRunCliOptions) => {
      return telegramRunCommand(options);
    });
}
