import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../../lib/cli.js";
import {resolveMediaDir} from "../../../lib/data-dir.js";
import {PostgresAgentStore} from "../../../domain/agents/postgres.js";
import {normalizeAgentKey} from "../../../domain/agents/types.js";
import {PostgresConnectorAccountStore} from "../../../domain/connectors/postgres.js";
import {normalizeConnectorAccountKey, type ConnectorAccountOwnerInput, type ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import {resolveSecretCrypto} from "../../../domain/secrets/crypto.js";
import {PostgresIdentityStore} from "../../../domain/identity/postgres.js";
import {parseIdentityHandle} from "../../../domain/identity/cli.js";
import {trimToUndefined} from "../../../lib/strings.js";
import {runCleanupSteps} from "../../../lib/cleanup.js";
import {type HealthServer, type HealthSnapshot, resolveOptionalHealthServerBinding, startHealthServer} from "../../../lib/health-server.js";
import {withPostgresPool} from "../../../lib/postgres-database.js";
import {TELEGRAM_SOURCE} from "./config.js";
import {
  createTelegramBotIdentityClient,
  disableTelegramBotAccount,
  loadStoredTelegramBotAccount,
  setTelegramBotAccount,
  validateStoredTelegramBotAccount,
  type TelegramBotIdentityClient,
} from "./account.js";
import {TelegramService} from "./service.js";
import {ConnectorAccountSupervisor} from "../account-supervisor.js";
import {
  startConnectorDaemonRuntime,
  type ConnectorDaemonRuntimeHandle,
} from "../worker-runtime.js";

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
  disableHealthServer?: boolean;
  expectedConnectorKey?: string;
  runtime: ConnectorDaemonRuntimeHandle;
  token: string;
}

export interface TelegramRunService {
  run(): Promise<void>;
  start?(): Promise<void>;
  stop(): Promise<void>;
}

interface TelegramAccountStores {
  agentStore: PostgresAgentStore;
  connectorStore: PostgresConnectorAccountStore;
}

export interface TelegramCliDependencies {
  createBotIdentityClient?: () => TelegramBotIdentityClient;
  createDaemonRuntime?: (options: {dbUrl?: string}) => Promise<ConnectorDaemonRuntimeHandle>;
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
  const crypto = resolveSecretCrypto();
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
    return resolveTelegramBotIdentityFromStore(options.account!, store, dependencies);
  });
}

async function resolveTelegramBotIdentityFromStore(
  accountKey: string,
  store: PostgresConnectorAccountStore,
  dependencies: TelegramCliDependencies,
): Promise<{
  connectorKey: string;
  id: string;
  username?: string;
  token: string;
  accountKey: string;
  status: string;
}> {
  const result = await validateStoredTelegramBotAccount({
    accountKey,
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
}

async function resolveTelegramRunAccountFromStore(
  accountKey: string,
  store: PostgresConnectorAccountStore,
): Promise<{
  accountKey: string;
  connectorKey: string;
  status: string;
  token: string;
}> {
  const result = await loadStoredTelegramBotAccount({
    accountKey,
    crypto: resolveTelegramAccountCrypto(),
    store,
  });
  return {
    accountKey: result.account.accountKey,
    connectorKey: result.account.connectorKey,
    status: result.account.status,
    token: result.botToken,
  };
}

async function withTelegramIdentityStore<T>(
  options: TelegramIdentityCliOptions,
  fn: (store: PostgresIdentityStore) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const store = new PostgresIdentityStore({pool});
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

function logTelegramRunEvent(event: string, payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    source: TELEGRAM_SOURCE,
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  })}\n`);
}

async function startTelegramDaemonRuntime(
  options: TelegramRunCliOptions,
  dependencies: TelegramCliDependencies,
): Promise<ConnectorDaemonRuntimeHandle> {
  if (dependencies.createDaemonRuntime) return dependencies.createDaemonRuntime({dbUrl: options.dbUrl});
  return startConnectorDaemonRuntime({
    source: TELEGRAM_SOURCE,
    dbUrl: options.dbUrl,
    poolMaxEnvKey: "PANDA_TELEGRAM_DB_POOL_MAX",
    log: logTelegramRunEvent,
  });
}

async function listEnabledTelegramAccounts(
  store: PostgresConnectorAccountStore,
): Promise<readonly ConnectorAccountRecord[]> {
  return store.listAccounts({source: TELEGRAM_SOURCE, status: "enabled"});
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
  const runtime = await startTelegramDaemonRuntime(options, dependencies);
  const connectorStore = new PostgresConnectorAccountStore({pool: runtime.pool});
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | null = null;
  let resolveStopWaiter: (() => void) | null = null;
  const stopWaiter = new Promise<void>((resolve) => {
    resolveStopWaiter = resolve;
  });
  const supervisor = new ConnectorAccountSupervisor<ConnectorAccountRecord, TelegramRunService>({
    listEnabledAccounts: () => listEnabledTelegramAccounts(connectorStore),
    createWorker: async (account) => {
      const identity = await resolveTelegramRunAccountFromStore(account.accountKey, connectorStore);
      requireEnabledStoredTelegramAccount(identity);
      return createTelegramRunService({
        accountKey: identity.accountKey,
        dataDir: resolveMediaDir(),
        disableHealthServer: true,
        expectedConnectorKey: identity.connectorKey,
        runtime,
        token: identity.token,
      }, dependencies);
    },
    log: logTelegramRunEvent,
  });
  let healthServer: HealthServer | null = null;
  const createHealthServer = () => startTelegramSupervisorHealthServer(() => {
    const workers = supervisor.snapshot();
    const listener = runtime.getNotificationSnapshot();
    return {
      ok: !shutdownRequested,
      ...workers,
      listenerStatus: listener.status,
      listenerLastErrorAt: listener.lastErrorAt,
      listenerLastError: listener.lastError,
    };
  });

  const shutdown = () => shutdownPromise ??= (async () => {
    shutdownRequested = true;
    await supervisor.stop();
    resolveStopWaiter?.();
  })();
  const unregisterShutdown = registerTelegramRunShutdown(shutdown);

  try {
    healthServer = await createHealthServer();
    await supervisor.start();
    if (!shutdownRequested) {
      logTelegramRunEvent("worker_supervisor_started", {
        ...supervisor.snapshot(),
        poolMax: runtime.poolConfig.max,
      });
    }
    await stopWaiter;
  } finally {
    unregisterShutdown();
    await shutdown();
    await runtime.close();
    await healthServer?.close();
  }
}

async function telegramRunSingleAccountCommand(accountKey: string, options: TelegramRunCliOptions, dependencies: TelegramCliDependencies): Promise<void> {
  const runtime = await startTelegramDaemonRuntime(options, dependencies);
  let service: TelegramRunService | null = null;
  let stopPromise: Promise<void> | null = null;
  let unregisterShutdown: (() => void) | null = null;

  try {
    const store = new PostgresConnectorAccountStore({pool: runtime.pool});
    const identity = await resolveTelegramRunAccountFromStore(accountKey, store);
    requireEnabledStoredTelegramAccount(identity);
    service = createTelegramRunService({
      accountKey: identity.accountKey,
      dataDir: resolveMediaDir(),
      expectedConnectorKey: identity.connectorKey,
      runtime,
      token: identity.token,
    }, dependencies);
    const stopService = () => stopPromise ??= service!.stop();
    unregisterShutdown = registerTelegramRunShutdown(stopService);
    await service.run();
  } finally {
    unregisterShutdown?.();
    await runCleanupSteps([
      {label: "telegram-service", run: async () => {
        if (service) await (stopPromise ??= service.stop());
      }},
      {label: "telegram-daemon-runtime", run: async () => runtime.close()},
    ]);
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
    .command("chat")
    .description("Inspect Telegram chats");

  const stickerProgram = telegramProgram
    .command("sticker")
    .description("Inspect, save, browse, and send Telegram stickers");

  stickerProgram
    .command("set")
    .description("Inspect and import Telegram sticker sets");

  telegramProgram
    .command("media")
    .description("Telegram media commands");

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
