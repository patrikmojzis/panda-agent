import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../../lib/cli.js";
import {writeCommandDescriptorHelp} from "../../../domain/commands/cli.js";
import {resolveMediaDir} from "../../../lib/data-dir.js";
import {PostgresAgentStore} from "../../../domain/agents/postgres.js";
import {normalizeAgentKey} from "../../../domain/agents/types.js";
import {PostgresConnectorAccountStore} from "../../../domain/connectors/postgres.js";
import {normalizeConnectorAccountKey, type ConnectorAccountOwnerInput} from "../../../domain/connectors/types.js";
import {resolveCredentialCrypto} from "../../../domain/credentials/crypto.js";
import {PostgresIdentityStore} from "../../../domain/identity/postgres.js";
import {parseIdentityHandle} from "../../../domain/identity/cli.js";
import {trimToUndefined} from "../../../lib/strings.js";
import {type HealthServer, type HealthSnapshot, resolveOptionalHealthServerBinding, startHealthServer} from "../../../lib/health-server.js";
import {ensureSchemas, withPostgresPool} from "../../../lib/postgres-bootstrap.js";
import {TELEGRAM_SOURCE} from "./config.js";
import {
  telegramChatListCommandDescriptor,
  telegramChatInfoCommandDescriptor,
  telegramDeleteCommandDescriptor,
  telegramEditCommandDescriptor,
  telegramHistoryCommandDescriptor,
  telegramMediaFetchCommandDescriptor,
  telegramPinCommandDescriptor,
  telegramReactCommandDescriptor,
  telegramSendCommandDescriptor,
  telegramStickerSendCommandDescriptor,
  telegramUnpinCommandDescriptor,
} from "./commands.js";
import {
  telegramStickerInspectCommandDescriptor,
  telegramStickerListCommandDescriptor,
  telegramStickerSaveCommandDescriptor,
  telegramStickerSetSaveCommandDescriptor,
  telegramStickerSetShowCommandDescriptor,
} from "./sticker-commands.js";
import {
  createTelegramBotIdentityClient,
  disableTelegramBotAccount,
  setTelegramBotAccount,
  validateStoredTelegramBotAccount,
  type TelegramBotIdentityClient,
} from "./account.js";
import {TelegramService} from "./service.js";

const TELEGRAM_ALL_ENABLED_POOL_MAX_FALLBACK = 2;
const TELEGRAM_ALL_ENABLED_RECONCILE_INTERVAL_MS = 30_000;

interface TelegramIdentityCliOptions {
  dbUrl?: string;
}

interface TelegramRunCliOptions extends TelegramIdentityCliOptions {
  allEnabled?: boolean;
}

interface TelegramAccountCliOptions extends TelegramIdentityCliOptions {}

interface TelegramAccountOwnerCliOptions extends TelegramAccountCliOptions {
  agent?: string;
}

interface TelegramAccountSetCliOptions extends TelegramAccountOwnerCliOptions {
  botTokenStdin?: boolean;
  replace?: boolean;
}

interface TelegramAccountImportEnvCliOptions extends TelegramAccountOwnerCliOptions {
  envKey: string;
  replace?: boolean;
}

interface TelegramReactCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramEditCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramDeleteCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramPinCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramUnpinCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramStickerSendCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramStickerCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramSendCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramChatListCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramChatInfoCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramHistoryCliOptions {
  help?: boolean;
  json?: boolean | string;
}

interface TelegramMediaFetchCliOptions {
  help?: boolean;
  json?: boolean | string;
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
  disableHealthServer?: boolean;
  expectedConnectorKey?: string;
  poolMaxFallback?: number;
  token: string;
}

export interface TelegramRunService {
  run(): Promise<void>;
  start?(): Promise<void>;
  stop(): Promise<void>;
}

interface StartedTelegramRunService {
  accountKey: string;
  runPromise: Promise<void>;
  service: TelegramRunService;
}

interface TelegramRunServiceRef {
  accountKey: string;
  service: TelegramRunService;
}

interface TelegramAccountStores {
  agentStore: PostgresAgentStore;
  connectorStore: PostgresConnectorAccountStore;
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

function parseTelegramOwnerAgent(value: string): string {
  return parseCliValue(value, normalizeAgentKey);
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

async function withTelegramAccountStores<T>(
  options: TelegramAccountCliOptions,
  fn: (stores: TelegramAccountStores) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores: TelegramAccountStores = {
      agentStore: new PostgresAgentStore({pool}),
      connectorStore: new PostgresConnectorAccountStore({pool}),
    };
    await stores.connectorStore.ensureSchema();
    return fn(stores);
  });
}

async function resolveTelegramAccountOwner(
  options: TelegramAccountOwnerCliOptions,
  stores: Pick<TelegramAccountStores, "agentStore">,
): Promise<ConnectorAccountOwnerInput> {
  if (!options.agent) {
    return {};
  }

  const agent = await stores.agentStore.getAgent(options.agent);
  return {ownerAgentKey: agent.agentKey};
}

async function resolveTelegramBotIdentity(options: TelegramIdentityCliOptions & {account?: string}, dependencies: TelegramCliDependencies = {}): Promise<{
  connectorKey: string;
  id: string;
  username?: string;
  token?: string;
  accountKey?: string;
  status?: string;
}> {
  if (!options.account) {
    throw new Error("Telegram connector account key is required. Use Control → agent → Connectors → Telegram setup, or run `panda telegram account set <accountKey> --agent <agentKey> --bot-token-stdin` first.");
  }

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

function registerTelegramRunShutdown(shutdown: () => Promise<void>): () => void {
  const handleSigint = () => {
    void shutdown();
  };
  const handleSigterm = () => {
    void shutdown();
  };

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  return () => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  };
}

function formatTelegramRunError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logTelegramRunEvent(event: string, payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    source: TELEGRAM_SOURCE,
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  })}\n`);
}

async function listEnabledTelegramAccountKeys(options: TelegramRunCliOptions): Promise<readonly string[]> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const store = new PostgresConnectorAccountStore({pool});
    await store.ensureSchema();
    const accounts = await store.listAccounts({
      source: TELEGRAM_SOURCE,
      status: "enabled",
    });

    return accounts.map((account) => account.accountKey);
  });
}

async function stopTelegramRunServices(services: readonly TelegramRunServiceRef[]): Promise<void> {
  await Promise.allSettled(services.map(async ({accountKey, service}) => {
    try {
      await service.stop();
    } catch (error) {
      logTelegramRunEvent("worker_stop_failed", {
        accountKey,
        message: formatTelegramRunError(error),
      });
    }
  }));
}

function startTelegramRunLoop(accountKey: string, service: TelegramRunService): Promise<void> {
  return service.run().catch((error) => {
    logTelegramRunEvent("worker_run_failed", {
      accountKey,
      message: formatTelegramRunError(error),
    });
  });
}

async function startTelegramSupervisorHealthServer(getSnapshot: () => HealthSnapshot): Promise<HealthServer | null> {
  const binding = resolveOptionalHealthServerBinding({
    hostEnvKey: "PANDA_TELEGRAM_HEALTH_HOST",
    portEnvKey: "PANDA_TELEGRAM_HEALTH_PORT",
  });
  if (!binding) {
    return null;
  }

  return startHealthServer({
    ...binding,
    getSnapshot: () => getSnapshot(),
  });
}

async function telegramRunAllEnabledCommand(
  options: TelegramRunCliOptions,
  dependencies: TelegramCliDependencies,
): Promise<void> {
  const started: StartedTelegramRunService[] = [];
  let starting: TelegramRunServiceRef | null = null;
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | null = null;
  let resolveStopWaiter: (() => void) | null = null;
  const stopWaiter = new Promise<void>((resolve) => {
    resolveStopWaiter = resolve;
  });
  const healthServer = await startTelegramSupervisorHealthServer(() => ({
    ok: started.length > 0 && !shutdownRequested,
    connectorCount: started.length,
    accountKeys: started.map((service) => service.accountKey),
    startingAccountKey: starting?.accountKey ?? null,
    stopping: shutdownRequested,
  }));

  const shutdown = async () => {
    shutdownRequested = true;
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        await stopTelegramRunServices([
          ...started,
          ...(starting ? [starting] : []),
        ]);
        await healthServer?.close();
        resolveStopWaiter?.();
      })();
    }

    await shutdownPromise;
  };
  const unregisterShutdown = registerTelegramRunShutdown(shutdown);

  async function startAccountWorker(accountKey: string): Promise<boolean> {
    if (started.some((service) => service.accountKey === accountKey) || shutdownRequested) return false;
    let service: TelegramRunService | null = null;
    try {
      const identity = await resolveTelegramBotIdentity({dbUrl: options.dbUrl, account: accountKey}, dependencies);
      requireEnabledStoredTelegramAccount(identity);
      service = createTelegramRunService({
        accountKey: identity.accountKey,
        dataDir: resolveMediaDir(),
        dbUrl: options.dbUrl,
        disableHealthServer: true,
        expectedConnectorKey: identity.connectorKey,
        poolMaxFallback: TELEGRAM_ALL_ENABLED_POOL_MAX_FALLBACK,
        token: identity.token!,
      }, dependencies);
      starting = {accountKey, service};
      if (!service.start) {
        throw new Error("Telegram run service does not support supervised startup.");
      }
      await service.start();
      if (shutdownRequested) {
        await service.stop();
        return false;
      }

      starting = null;
      started.push({
        accountKey,
        runPromise: startTelegramRunLoop(accountKey, service),
        service,
      });
      return true;
    } catch (error) {
      if (!shutdownRequested) {
        logTelegramRunEvent("worker_start_failed", {
          accountKey,
          message: formatTelegramRunError(error),
        });
      }
      await service?.stop().catch((stopError) => {
        logTelegramRunEvent("worker_stop_failed", {
          accountKey,
          message: formatTelegramRunError(stopError),
        });
      });
      return false;
    } finally {
      starting = null;
    }
  }

  async function reconcileEnabledAccounts(): Promise<void> {
    if (shutdownRequested) return;
    const accountKeys = await listEnabledTelegramAccountKeys(options);
    const enabled = new Set(accountKeys);
    for (let index = started.length - 1; index >= 0; index -= 1) {
      const service = started[index]!;
      if (enabled.has(service.accountKey)) continue;
      started.splice(index, 1);
      await service.service.stop();
      logTelegramRunEvent("worker_stopped_disabled_account", {accountKey: service.accountKey});
    }
    for (const accountKey of accountKeys) {
      const didStart = await startAccountWorker(accountKey);
      if (didStart) logTelegramRunEvent("worker_started_reconciled_account", {accountKey});
    }
  }

  let reconcileInFlight = false;
  const reconcileTimer = setInterval(() => {
    if (reconcileInFlight || shutdownRequested) return;
    reconcileInFlight = true;
    reconcileEnabledAccounts().catch((error) => {
      logTelegramRunEvent("worker_reconcile_failed", {message: formatTelegramRunError(error)});
    }).finally(() => {
      reconcileInFlight = false;
    });
  }, TELEGRAM_ALL_ENABLED_RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();

  try {
    const accountKeys = await listEnabledTelegramAccountKeys(options);
    if (shutdownRequested) {
      return;
    }
    if (accountKeys.length === 0) {
      throw new Error("No enabled Telegram accounts found. Use Control → agent → Connectors → Telegram setup to store and enable a bot account, or run `panda telegram account set <accountKey> --agent <agentKey> --bot-token-stdin`.");
    }

    for (const accountKey of accountKeys) {
      if (shutdownRequested) break;
      await startAccountWorker(accountKey);
    }

    if (started.length === 0) {
      if (shutdownRequested) {
        return;
      }
      throw new Error("No Telegram workers started. Every enabled Telegram account failed during startup.");
    }

    logTelegramRunEvent("worker_supervisor_started", {
      accountCount: started.length,
      accountKeys: started.map((service) => service.accountKey),
      poolMaxFallback: TELEGRAM_ALL_ENABLED_POOL_MAX_FALLBACK,
    });

    await Promise.race([
      stopWaiter,
      Promise.all(started.map((service) => service.runPromise)).then(() => undefined),
    ]);
  } finally {
    clearInterval(reconcileTimer);
    unregisterShutdown();
    await shutdown();
  }
}

async function telegramRunSingleAccountCommand(accountKey: string, options: TelegramRunCliOptions, dependencies: TelegramCliDependencies): Promise<void> {
  const identity = await resolveTelegramBotIdentity({dbUrl: options.dbUrl, account: accountKey}, dependencies);
  requireEnabledStoredTelegramAccount(identity);
  const service = createTelegramRunService({
    accountKey: identity.accountKey,
    dataDir: resolveMediaDir(),
    dbUrl: options.dbUrl,
    expectedConnectorKey: identity.connectorKey,
    token: identity.token!,
  }, dependencies);

  const unregisterShutdown = registerTelegramRunShutdown(async () => {
    await service.stop();
  });

  try {
    await service.run();
  } finally {
    unregisterShutdown();
  }
}

export async function telegramRunCommand(accountKey: string | undefined, options: TelegramRunCliOptions, dependencies: TelegramCliDependencies = {}): Promise<void> {
  if (options.allEnabled && accountKey !== undefined) {
    throw new Error("Choose either a Telegram account key or --all-enabled, not both.");
  }
  if (options.allEnabled) {
    await telegramRunAllEnabledCommand(options, dependencies);
    return;
  }
  if (accountKey === undefined) {
    throw new Error("Pass a Telegram account key or --all-enabled.");
  }

  await telegramRunSingleAccountCommand(accountKey, options, dependencies);
}

export async function telegramAccountSetCommand(accountKey: string, options: TelegramAccountSetCliOptions, dependencies: TelegramCliDependencies = {}): Promise<void> {
  if (!options.botTokenStdin) {
    throw new Error("Pass --bot-token-stdin to read the Telegram bot token from stdin.");
  }
  const token = await (dependencies.readBotTokenFromStdin ?? readTelegramBotTokenFromStdin)();
  await withTelegramAccountStores(options, async (stores) => {
    const owner = await resolveTelegramAccountOwner(options, stores);
    const result = await setTelegramBotAccount({
      ...owner,
      accountKey,
      botToken: token,
      replace: options.replace === true,
      client: createTelegramClient(dependencies),
      crypto: resolveTelegramAccountCrypto(),
      store: stores.connectorStore,
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
  await withTelegramAccountStores(options, async (stores) => {
    const owner = await resolveTelegramAccountOwner(options, stores);
    const result = await setTelegramBotAccount({
      ...owner,
      accountKey,
      botToken: token,
      replace: options.replace === true,
      client: createTelegramClient(dependencies),
      crypto: resolveTelegramAccountCrypto(),
      store: stores.connectorStore,
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

  const chatProgram = telegramProgram
    .command("chat")
    .description("Inspect Telegram chats");

  const stickerProgram = telegramProgram
    .command("sticker")
    .description("Inspect, save, browse, and send Telegram stickers");

  const stickerSetProgram = stickerProgram
    .command("set")
    .description("Inspect and import Telegram sticker sets");

  chatProgram
    .command("info")
    .description(telegramChatInfoCommandDescriptor.summary)
    .argument("[conversationId]", "Telegram conversation id")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--connector <connectorKey>", "Telegram connector key")
    .action((_conversationId: string | undefined, options: TelegramChatInfoCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramChatInfoCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram chat info execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  telegramProgram
    .command("history")
    .description(telegramHistoryCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .option("--direction <direction>", "History direction: inbound, outbound, or all")
    .option("--limit <n>", "Maximum number of history items")
    .action((options: TelegramHistoryCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramHistoryCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram history execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  const mediaProgram = telegramProgram
    .command("media")
    .description("Telegram media commands");

  mediaProgram
    .command("fetch")
    .description(telegramMediaFetchCommandDescriptor.summary)
    .argument("[mediaId]", "Telegram media id from telegram.history")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .option("--save <path>", "Workspace path to save the media")
    .option("--overwrite", "Replace an existing file at the save path")
    .action((_mediaId: string | undefined, options: TelegramMediaFetchCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramMediaFetchCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram media fetch execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  chatProgram
    .command("list")
    .description(telegramChatListCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--connector <connectorKey>", "Telegram connector key")
    .action((options: TelegramChatListCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramChatListCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram chat list execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  telegramProgram
    .command("send")
    .description(telegramSendCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .option("--text <text>", "Text message body")
    .option("--image <path>", "Repeatable image path")
    .option("--file <path>", "Repeatable file path")
    .option("--reply-to-message-id <messageId>", "Telegram message id to reply to")
    .action((options: TelegramSendCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramSendCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram send execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  stickerProgram
    .command("inspect")
    .description(telegramStickerInspectCommandDescriptor.summary)
    .argument("[stickerRef]", "Opaque inbound Telegram sticker reference")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .action((_stickerRef: string | undefined, options: TelegramStickerCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramStickerInspectCommandDescriptor, Boolean(options.json));
        return;
      }
      throw new Error("panda telegram sticker inspect execution requires the agent command shim transport.");
    });

  stickerProgram
    .command("save")
    .description(telegramStickerSaveCommandDescriptor.summary)
    .argument("[stickerRef]", "Opaque inbound Telegram sticker reference")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .option("--tag <tag>", "Repeatable library tag")
    .option("--description <text>", "Library description")
    .action((_stickerRef: string | undefined, options: TelegramStickerCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramStickerSaveCommandDescriptor, Boolean(options.json));
        return;
      }
      throw new Error("panda telegram sticker save execution requires the agent command shim transport.");
    });

  stickerProgram
    .command("list")
    .description(telegramStickerListCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output")
    .option("--query <text>", "Search description or pack metadata")
    .option("--emoji <emoji>", "Exact emoji filter")
    .option("--tag <tag>", "Exact tag filter")
    .option("--connector <connectorKey>", "Telegram connector key")
    .option("--limit <n>", "Maximum results")
    .action((options: TelegramStickerCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramStickerListCommandDescriptor, Boolean(options.json));
        return;
      }
      throw new Error("panda telegram sticker list execution requires the agent command shim transport.");
    });

  stickerSetProgram
    .command("show")
    .description(telegramStickerSetShowCommandDescriptor.summary)
    .argument("[setName]", "Telegram sticker set name")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output")
    .option("--connector <connectorKey>", "Telegram connector key")
    .action((_setName: string | undefined, options: TelegramStickerCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramStickerSetShowCommandDescriptor, Boolean(options.json));
        return;
      }
      throw new Error("panda telegram sticker set show execution requires the agent command shim transport.");
    });

  stickerSetProgram
    .command("save")
    .description(telegramStickerSetSaveCommandDescriptor.summary)
    .argument("[setName]", "Telegram sticker set name")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output")
    .option("--connector <connectorKey>", "Telegram connector key")
    .option("--all", "Import the complete set")
    .option("--sticker <stickerRef>", "Repeatable set-local sticker reference")
    .option("--tag <tag>", "Repeatable library tag")
    .option("--description <text>", "Library description")
    .action((_setName: string | undefined, options: TelegramStickerCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramStickerSetSaveCommandDescriptor, Boolean(options.json));
        return;
      }
      throw new Error("panda telegram sticker set save execution requires the agent command shim transport.");
    });

  stickerProgram
    .command("send")
    .description(telegramStickerSendCommandDescriptor.summary)
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .option("--file <path>", "Workspace sticker file path")
    .option("--file-id <id>", "Telegram sticker file id")
    .option("--ref <stickerRef>", "Agent-library sticker reference")
    .action((options: TelegramStickerSendCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramStickerSendCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram sticker send execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  telegramProgram
    .command("edit")
    .description(telegramEditCommandDescriptor.summary)
    .argument("[messageId]", "Telegram message id to edit")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--text <text>", "Replacement message text")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .action((_messageId: string | undefined, options: TelegramEditCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramEditCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram edit execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  telegramProgram
    .command("delete")
    .description(telegramDeleteCommandDescriptor.summary)
    .argument("[messageId]", "Telegram message id to delete")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .action((_messageId: string | undefined, options: TelegramDeleteCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramDeleteCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram delete execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  telegramProgram
    .command("pin")
    .description(telegramPinCommandDescriptor.summary)
    .argument("[messageId]", "Telegram message id to pin")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .option("--silent", "Pin without notifying chat members")
    .action((_messageId: string | undefined, options: TelegramPinCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramPinCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram pin execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  telegramProgram
    .command("unpin")
    .description(telegramUnpinCommandDescriptor.summary)
    .argument("[messageId]", "Telegram message id to unpin")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .action((_messageId: string | undefined, options: TelegramUnpinCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramUnpinCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram unpin execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  telegramProgram
    .command("react")
    .description(telegramReactCommandDescriptor.summary)
    .argument("[messageId]", "Telegram message id to react to")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--emoji <emoji>", "Reaction emoji to add")
    .option("--remove", "Remove the current reaction")
    .option("--chat <conversationId>", "Telegram conversation id")
    .option("--connector <connectorKey>", "Telegram connector key")
    .action((_messageId: string | undefined, options: TelegramReactCliOptions) => {
      if (options.help) {
        writeCommandDescriptorHelp(telegramReactCommandDescriptor, Boolean(options.json));
        return;
      }

      throw new Error(
        "panda telegram react execution requires the agent command shim transport; use --help for the command contract.",
      );
    });

  telegramProgram
    .command("whoami")
    .description("Show the Telegram bot identity and connector key")
    .requiredOption("--account <accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelegramIdentityCliOptions & {account?: string}) => {
      return telegramWhoamiCommand(options, dependencies);
    });

  telegramProgram
    .command("pair")
    .description("Pair a Telegram user id to a Panda identity")
    .requiredOption("--identity <handle>", "Identity handle to pair", parseIdentityHandle)
    .requiredOption("--actor <telegramUserId>", "Telegram user id to pair", parseTelegramActorId)
    .requiredOption("--account <accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelegramPairCliOptions) => {
      return telegramPairCommand(options, dependencies);
    });

  telegramProgram
    .command("unpair")
    .description("Remove a Telegram user identity pairing")
    .requiredOption("--actor <telegramUserId>", "Telegram user id to unpair", parseTelegramActorId)
    .requiredOption("--account <accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: TelegramUnpairCliOptions) => {
      return telegramUnpairCommand(options, dependencies);
    });

  telegramProgram
    .command("run")
    .description("Run one stored Telegram connector account worker, or all enabled accounts")
    .argument("[accountKey]", "Telegram connector account key", parseTelegramAccountKey)
    .option("--all-enabled", "Run every enabled Telegram connector account")
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
    .option("--replace", "Explicitly replace an existing Telegram account key")
    .option("--agent <agentKey>", "Panda agent key that owns this account", parseTelegramOwnerAgent)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: TelegramAccountSetCliOptions) => {
      return telegramAccountSetCommand(accountKey, options, dependencies);
    });

  accountProgram
    .command("import-env")
    .description("Import a Telegram bot token from an environment variable after validation")
    .argument("<accountKey>", "Telegram connector account key", parseTelegramAccountKey)
    .requiredOption("--env-key <ENV_VAR_NAME>", "Environment variable containing the Telegram bot token", parseEnvKey)
    .option("--replace", "Explicitly replace an existing Telegram account key")
    .option("--agent <agentKey>", "Panda agent key that owns this account", parseTelegramOwnerAgent)
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
