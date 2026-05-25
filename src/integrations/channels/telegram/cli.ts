import process from "node:process";

import {Command, InvalidArgumentError} from "commander";
import {Bot} from "grammy";

import {DB_URL_OPTION_DESCRIPTION} from "../../../lib/cli.js";
import {trimToUndefined} from "../../../lib/strings.js";
import {resolveMediaDir} from "../../../lib/data-dir.js";
import {PostgresIdentityStore} from "../../../domain/identity/postgres.js";
import {parseIdentityHandle} from "../../../domain/identity/cli.js";
import {ensureSchemas, withPostgresPool} from "../../../lib/postgres-bootstrap.js";
import {requireTelegramBotToken, TELEGRAM_SOURCE} from "./config.js";
import {TelegramService} from "./service.js";
import {readActivePandaRunContext, submitActivePandaRunRuntimeRequest} from "../../../app/runtime/active-run-command-client.js";
import type {TelegramReactCommandTarget} from "../../../domain/threads/requests/types.js";

interface TelegramIdentityCliOptions {
  dbUrl?: string;
}

type TelegramRunCliOptions = TelegramIdentityCliOptions;

interface TelegramReactCliOptions extends TelegramIdentityCliOptions {
  remove?: boolean;
  messageId?: string;
  connectorKey?: string;
  conversationId?: string;
}

interface TelegramReactCommandResult {
  ok?: boolean;
  connectorKey?: string;
  conversationId?: string;
  messageId?: string;
  added?: string;
  removed?: boolean;
  queued?: boolean;
}

interface TelegramReactCommandDependencies {
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<typeof process.stdout, "write">;
  submitRuntimeRequest?: typeof submitActivePandaRunRuntimeRequest;
}

interface TelegramPairCliOptions extends TelegramIdentityCliOptions {
  identity: string;
  actor: string;
}

interface TelegramUnpairCliOptions extends TelegramIdentityCliOptions {
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
    dataDir: resolveMediaDir(),
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

  await withTelegramIdentityStore(options, async (store) => {
    const identity = await store.getIdentityByHandle(options.identity);
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

export async function telegramUnpairCommand(options: TelegramUnpairCliOptions): Promise<void> {
  const botIdentity = await resolveTelegramBotIdentity();

  await withTelegramIdentityStore(options, async (store) => {
    const deleted = await store.deleteIdentityBinding({
      source: TELEGRAM_SOURCE,
      connectorKey: botIdentity.connectorKey,
      externalActorId: options.actor,
    });

    process.stdout.write(
      [
        deleted
          ? `Unpaired Telegram actor ${options.actor}.`
          : `No Telegram pairing found for actor ${options.actor}.`,
        `connector ${botIdentity.connectorKey}`,
      ].join("\n") + "\n",
    );
  });
}

function resolveTelegramReactTarget(options: TelegramReactCliOptions): TelegramReactCommandTarget | undefined {
  const connectorKey = trimToUndefined(options.connectorKey);
  const conversationId = trimToUndefined(options.conversationId);
  if (!connectorKey && !conversationId) {
    return undefined;
  }

  if (!connectorKey || !conversationId) {
    throw new Error("panda telegram react explicit targets require both --connector-key and --conversation-id.");
  }

  return {
    connectorKey,
    conversationId,
  };
}

function formatTelegramReactCommandResult(result: TelegramReactCommandResult): string {
  const messageId = result.messageId ?? "unknown";
  const conversationId = result.conversationId ?? "unknown";
  if (result.removed === true) {
    return `Queued Telegram reaction removal for message ${messageId} in conversation ${conversationId}.\n`;
  }

  return `Queued Telegram reaction ${result.added ?? ""} for message ${messageId} in conversation ${conversationId}.\n`;
}

export async function telegramReactCommand(
  emoji: string | undefined,
  options: TelegramReactCliOptions,
  dependencies: TelegramReactCommandDependencies = {},
): Promise<void> {
  const activeRun = readActivePandaRunContext(dependencies.env ?? process.env);
  const remove = options.remove === true;
  const emojiValue = trimToUndefined(emoji);
  if (!remove && !emojiValue) {
    throw new Error("panda telegram react requires an emoji unless --remove is set.");
  }

  const messageId = trimToUndefined(options.messageId);
  const target = resolveTelegramReactTarget(options);
  const submitRuntimeRequest = dependencies.submitRuntimeRequest ?? submitActivePandaRunRuntimeRequest;
  const result = await submitRuntimeRequest<TelegramReactCommandResult>({
    kind: "telegram_react_command",
    payload: {
      ...activeRun,
      ...(emojiValue ? {emoji: emojiValue} : {}),
      ...(remove ? {remove} : {}),
      ...(messageId ? {messageId} : {}),
      ...(target ? {target} : {}),
    },
  }, {
    dbUrl: options.dbUrl,
  });

  (dependencies.stdout ?? process.stdout).write(formatTelegramReactCommandResult(result));
}

async function telegramRunCommand(options: TelegramRunCliOptions): Promise<void> {
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
    .command("unpair")
    .description("Remove a Telegram user identity pairing")
    .requiredOption("--actor <telegramUserId>", "Telegram user id to unpair", parseTelegramActorId)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelegramUnpairCliOptions) => {
      return telegramUnpairCommand(options);
    });

  telegramProgram
    .command("react")
    .description("Add or remove a Telegram reaction through the active Panda runtime context")
    .argument("[emoji]", "Telegram reaction emoji")
    .option("--remove", "Remove the reaction from the target message")
    .option("--message-id <id>", "Telegram message id to react to")
    .option("--connector-key <key>", "Telegram connector key for an explicit target")
    .option("--conversation-id <id>", "Telegram conversation id for an explicit target")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((emoji: string | undefined, options: TelegramReactCliOptions) => {
      return telegramReactCommand(emoji, options);
    });

  telegramProgram
    .command("run")
    .description("Run the Telegram ingress worker")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelegramRunCliOptions) => {
      return telegramRunCommand(options);
    });
}
