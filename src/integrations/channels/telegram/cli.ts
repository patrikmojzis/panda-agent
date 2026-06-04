import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../../lib/cli.js";
import {resolveMediaDir} from "../../../lib/data-dir.js";
import {PostgresConnectorAccountStore} from "../../../domain/connectors/postgres.js";
import {normalizeConnectorAccountKey} from "../../../domain/connectors/types.js";
import {resolveCredentialCrypto} from "../../../domain/credentials/crypto.js";
import {PostgresIdentityStore} from "../../../domain/identity/postgres.js";
import {parseIdentityHandle} from "../../../domain/identity/cli.js";
import {trimToUndefined} from "../../../lib/strings.js";
import {ensureSchemas, withPostgresPool} from "../../../lib/postgres-bootstrap.js";
import {requireTelegramBotToken, TELEGRAM_SOURCE} from "./config.js";
import {
  createTelegramBotIdentityClient,
  disableTelegramBotAccount,
  setTelegramBotAccount,
  validateStoredTelegramBotAccount,
  type TelegramBotIdentityClient,
} from "./account.js";
import {TelegramService} from "./service.js";

interface TelegramIdentityCliOptions {
  dbUrl?: string;
}

interface TelegramRunCliOptions extends TelegramIdentityCliOptions {}

interface TelegramAccountCliOptions extends TelegramIdentityCliOptions {}

interface TelegramAccountSetCliOptions extends TelegramAccountCliOptions {
  botTokenStdin?: boolean;
}

interface TelegramAccountImportEnvCliOptions extends TelegramAccountCliOptions {
  envKey: string;
}

interface TelegramPairCliOptions extends TelegramIdentityCliOptions {
  identity: string;
  actor: string;
  account?: string;
}

interface TelegramUnpairCliOptions extends TelegramIdentityCliOptions {
  actor: string;
  account?: string;
}

export interface TelegramRunServiceOptions {
  accountKey?: string;
  dataDir: string;
  dbUrl?: string;
  expectedConnectorKey?: string;
  token: string;
}

export interface TelegramRunService {
  run(): Promise<void>;
  stop(): Promise<void>;
}

export interface TelegramCliDependencies {
  createBotIdentityClient?: () => TelegramBotIdentityClient;
  createRunService?: (options: TelegramRunServiceOptions) => TelegramRunService;
  env?: NodeJS.ProcessEnv;
  readBotTokenFromStdin?: () => Promise<string>;
}


function parseCliValue(value: string, normalize: (raw: string) => string): string {
  try {
    return normalize(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidArgumentError(message);
  }
}

function parseTelegramAccountKey(value: string): string {
  return parseCliValue(value, normalizeConnectorAccountKey);
}

function parseEnvKey(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new InvalidArgumentError("Environment variable name must start with a letter or underscore and contain only letters, numbers, and underscores.");
  }
  return trimmed;
}

function parseTelegramActorId(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidArgumentError("Telegram actor id must be a positive integer string.");
  }

  return trimmed;
}

async function readTelegramBotTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const token = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (trimToUndefined(token) === undefined) {
    throw new Error("stdin did not provide a Telegram bot token.");
  }
  return token;
}

function readTelegramBotTokenFromEnv(envKey: string, env: NodeJS.ProcessEnv): string {
  const token = trimToUndefined(env[envKey]);
  if (token === undefined) {
    throw new Error("Telegram bot token environment variable is not set or empty.");
  }
  return token;
}

function resolveTelegramAccountCrypto() {
  const crypto = resolveCredentialCrypto();
  if (!crypto) {
    throw new Error("CREDENTIALS_MASTER_KEY is required for Telegram account commands.");
  }
  return crypto;
}

function createTelegramClient(dependencies: TelegramCliDependencies): TelegramBotIdentityClient {
  return dependencies.createBotIdentityClient?.() ?? createTelegramBotIdentityClient();
}

function createTelegramRunService(options: TelegramRunServiceOptions, dependencies: TelegramCliDependencies = {}): TelegramRunService {
  return dependencies.createRunService?.(options) ?? new TelegramService(options);
}

async function resolveTelegramBotIdentity(options: TelegramIdentityCliOptions & {account?: string}, dependencies: TelegramCliDependencies = {}): Promise<{
  connectorKey: string;
  id: string;
  username?: string;
  token?: string;
  accountKey?: string;
  status?: string;
}> {
  if (options.account) {
    return withPostgresPool(options.dbUrl, async (pool) => {
      const store = new PostgresConnectorAccountStore({pool});
      await store.ensureSchema();
      const result = await validateStoredTelegramBotAccount({
        accountKey: options.account!,
        client: createTelegramClient(dependencies),
        crypto: resolveTelegramAccountCrypto(),
        store,
      });
      return {
        connectorKey: result.account.connectorKey,
        id: result.bot.id,
        username: result.bot.username,
        token: result.botToken,
        accountKey: result.account.accountKey,
        status: result.account.status,
      };
    });
  }

  const token = requireTelegramBotToken(dependencies.env ?? process.env);
  const me = await createTelegramClient(dependencies).getBotIdentity(token);
  return {
    connectorKey: me.id,
    id: me.id,
    username: me.username,
    token,
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

export async function telegramWhoamiCommand(options: TelegramIdentityCliOptions & {account?: string} = {}, dependencies: TelegramCliDependencies = {}): Promise<void> {
  const me = await resolveTelegramBotIdentity(options, dependencies);
  process.stdout.write(
    [
      `Telegram bot ${me.username ?? me.id}`,
      `id ${me.id}`,
      `connector ${me.connectorKey}`,
    ].join("\n") + "\n",
  );
}

function requireEnabledStoredTelegramAccount(identity: {accountKey?: string; status?: string}): void {
  if (identity.accountKey && identity.status !== "enabled") {
    throw new Error(`Telegram account ${identity.accountKey} is not enabled.`);
  }
}

export async function telegramPairCommand(options: TelegramPairCliOptions, dependencies: TelegramCliDependencies = {}): Promise<void> {
  const botIdentity = await resolveTelegramBotIdentity(options, dependencies);
  requireEnabledStoredTelegramAccount(botIdentity);

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

export async function telegramUnpairCommand(options: TelegramUnpairCliOptions, dependencies: TelegramCliDependencies = {}): Promise<void> {
  const botIdentity = await resolveTelegramBotIdentity(options, dependencies);
  requireEnabledStoredTelegramAccount(botIdentity);

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

export async function telegramRunCommand(accountKey: string | undefined, options: TelegramRunCliOptions, dependencies: TelegramCliDependencies = {}): Promise<void> {
  const identity = await resolveTelegramBotIdentity({dbUrl: options.dbUrl, account: accountKey}, dependencies);
  requireEnabledStoredTelegramAccount(identity);
  const service = createTelegramRunService({
    accountKey: identity.accountKey,
    dataDir: resolveMediaDir(),
    dbUrl: options.dbUrl,
    expectedConnectorKey: identity.connectorKey,
    token: identity.token!,
  }, dependencies);

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

export async function telegramAccountSetCommand(accountKey: string, options: TelegramAccountSetCliOptions, dependencies: TelegramCliDependencies = {}): Promise<void> {
  if (!options.botTokenStdin) {
    throw new Error("Pass --bot-token-stdin to read the Telegram bot token from stdin.");
  }
  const token = await (dependencies.readBotTokenFromStdin ?? readTelegramBotTokenFromStdin)();
  await withPostgresPool(options.dbUrl, async (pool) => {
    const store = new PostgresConnectorAccountStore({pool});
    await store.ensureSchema();
    const result = await setTelegramBotAccount({
      accountKey,
      botToken: token,
      client: createTelegramClient(dependencies),
      crypto: resolveTelegramAccountCrypto(),
      store,
    });
    process.stdout.write([
      `Stored Telegram account ${result.account.accountKey}.`,
      `id ${result.bot.id}`,
      `connector ${result.account.connectorKey}`,
    ].join("\n") + "\n");
  });
}

export async function telegramAccountImportEnvCommand(accountKey: string, options: TelegramAccountImportEnvCliOptions, dependencies: TelegramCliDependencies = {}): Promise<void> {
  const token = readTelegramBotTokenFromEnv(options.envKey, dependencies.env ?? process.env);
  await withPostgresPool(options.dbUrl, async (pool) => {
    const store = new PostgresConnectorAccountStore({pool});
    await store.ensureSchema();
    const result = await setTelegramBotAccount({
      accountKey,
      botToken: token,
      client: createTelegramClient(dependencies),
      crypto: resolveTelegramAccountCrypto(),
      store,
    });
    process.stdout.write([
      `Imported Telegram account ${result.account.accountKey}.`,
      `id ${result.bot.id}`,
      `connector ${result.account.connectorKey}`,
    ].join("\n") + "\n");
  });
}

export async function telegramAccountWhoamiCommand(accountKey: string, options: TelegramAccountCliOptions, dependencies: TelegramCliDependencies = {}): Promise<void> {
  const me = await resolveTelegramBotIdentity({dbUrl: options.dbUrl, account: accountKey}, dependencies);
  process.stdout.write([
    `Telegram account ${accountKey}.`,
    `bot ${me.username ?? me.id}`,
    `id ${me.id}`,
    `connector ${me.connectorKey}`,
  ].join("\n") + "\n");
}

export async function telegramAccountDisableCommand(accountKey: string, options: TelegramAccountCliOptions): Promise<void> {
  await withPostgresPool(options.dbUrl, async (pool) => {
    const store = new PostgresConnectorAccountStore({pool});
    await store.ensureSchema();
    const result = await disableTelegramBotAccount({accountKey, store});
    process.stdout.write([
      `Disabled Telegram account ${result.account.accountKey}.`,
      `status ${result.account.status}`,
      `connector ${result.account.connectorKey}`,
    ].join("\n") + "\n");
  });
}

export function registerTelegramCommands(program: Command, dependencies: TelegramCliDependencies = {}): void {
  const telegramProgram = program
    .command("telegram")
    .description("Run and manage the Telegram channel");

  telegramProgram
    .command("whoami")
    .description("Show the Telegram bot identity and connector key")
    .option("--account <accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelegramIdentityCliOptions & {account?: string}) => {
      return telegramWhoamiCommand(options, dependencies);
    });

  telegramProgram
    .command("pair")
    .description("Pair a Telegram user id to a Panda identity")
    .requiredOption("--identity <handle>", "Identity handle to pair", parseIdentityHandle)
    .requiredOption("--actor <telegramUserId>", "Telegram user id to pair", parseTelegramActorId)
    .option("--account <accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelegramPairCliOptions) => {
      return telegramPairCommand(options, dependencies);
    });

  telegramProgram
    .command("unpair")
    .description("Remove a Telegram user identity pairing")
    .requiredOption("--actor <telegramUserId>", "Telegram user id to unpair", parseTelegramActorId)
    .option("--account <accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelegramUnpairCliOptions) => {
      return telegramUnpairCommand(options, dependencies);
    });

  telegramProgram
    .command("run")
    .description("Run the Telegram ingress worker")
    .argument("[accountKey]", "Telegram connector account key", parseTelegramAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string | undefined, options: TelegramRunCliOptions) => {
      return telegramRunCommand(accountKey, options, dependencies);
    });

  const accountProgram = telegramProgram
    .command("account")
    .description("Manage Telegram connector accounts");

  accountProgram
    .command("set")
    .description("Store a Telegram bot token from stdin after validation")
    .argument("<accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .requiredOption("--bot-token-stdin", "Read the Telegram bot token from stdin")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: TelegramAccountSetCliOptions) => {
      return telegramAccountSetCommand(accountKey, options, dependencies);
    });

  accountProgram
    .command("import-env")
    .description("Import a Telegram bot token from an environment variable after validation")
    .argument("<accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .requiredOption("--env-key <ENV_VAR_NAME>", "Environment variable containing the Telegram bot token", parseEnvKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: TelegramAccountImportEnvCliOptions) => {
      return telegramAccountImportEnvCommand(accountKey, options, dependencies);
    });

  accountProgram
    .command("whoami")
    .description("Validate and show the Telegram bot identity for an account")
    .argument("<accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: TelegramAccountCliOptions) => {
      return telegramAccountWhoamiCommand(accountKey, options, dependencies);
    });

  accountProgram
    .command("disable")
    .description("Disable a Telegram connector account")
    .argument("<accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: TelegramAccountCliOptions) => {
      return telegramAccountDisableCommand(accountKey, options);
    });
}
