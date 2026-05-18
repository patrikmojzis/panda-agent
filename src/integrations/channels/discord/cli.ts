import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {PostgresAgentStore} from "../../../domain/agents/postgres.js";
import {normalizeAgentKey} from "../../../domain/agents/types.js";
import {PostgresConnectorAccountStore} from "../../../domain/connectors/postgres.js";
import {ConversationRepo} from "../../../domain/sessions/conversations/repo.js";
import type {ConversationBinding} from "../../../domain/sessions/conversations/types.js";
import {PostgresSessionStore} from "../../../domain/sessions/postgres.js";
import {normalizeConnectorAccountKey, type ConnectorAccountOwnerInput, type ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import {resolveCredentialCrypto, type CredentialCrypto} from "../../../domain/credentials/crypto.js";
import {PostgresIdentityStore} from "../../../domain/identity/postgres.js";
import {normalizeIdentityHandle} from "../../../domain/identity/types.js";
import {DB_URL_OPTION_DESCRIPTION, parseRequiredOptionValue, parseSessionIdOption} from "../../../lib/cli.js";
import {withPostgresPool} from "../../../lib/postgres-bootstrap.js";
import {trimToUndefined} from "../../../lib/strings.js";
import {
  disableDiscordBotAccount,
  type DiscordBotAccountResult,
  setDiscordBotAccount,
  validateStoredDiscordBotAccount,
} from "./account.js";
import {createDiscordRestClient, type DiscordCurrentUser, type DiscordRestClient} from "./api.js";
import {DISCORD_SOURCE} from "./config.js";
import {DiscordService} from "./service.js";

interface DiscordAccountCliOptions {
  dbUrl?: string;
}

type DiscordRunCliOptions = DiscordAccountCliOptions;

interface DiscordBindChannelCliOptions extends DiscordAccountCliOptions {
  account: string;
  channel: string;
  force?: boolean;
  session: string;
}

interface DiscordChannelBindingCliOptions extends DiscordAccountCliOptions {
  account: string;
  channel: string;
}

interface DiscordBindingListCliOptions extends DiscordAccountCliOptions {
  account: string;
}

export interface DiscordRunServiceOptions {
  accountKey: string;
  dbUrl?: string;
}

export interface DiscordRunService {
  run(): Promise<void>;
  stop(): Promise<void>;
}

interface DiscordAccountOwnerCliOptions extends DiscordAccountCliOptions {
  ownerAgent?: string;
  ownerIdentity?: string;
}

interface DiscordAccountSetCliOptions extends DiscordAccountOwnerCliOptions {
  botTokenStdin?: boolean;
}

interface DiscordAccountImportEnvCliOptions extends DiscordAccountOwnerCliOptions {
  envKey: string;
}

export interface DiscordAccountCliDependencies {
  createRestClient?: () => DiscordRestClient;
  env?: NodeJS.ProcessEnv;
  readBotTokenFromStdin?: () => Promise<string>;
}

export interface DiscordCliDependencies extends DiscordAccountCliDependencies {
  createRunService?: (options: DiscordRunServiceOptions) => DiscordRunService;
}

interface DiscordAccountStores {
  agentStore: PostgresAgentStore;
  connectorStore: PostgresConnectorAccountStore;
  identityStore: PostgresIdentityStore;
}

interface DiscordBindingStores {
  connectorStore: PostgresConnectorAccountStore;
  conversations: ConversationRepo;
  sessionStore: PostgresSessionStore;
}

function parseCliValue(value: string, normalize: (raw: string) => string): string {
  try {
    return normalize(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidArgumentError(message);
  }
}

function parseDiscordAccountKey(value: string): string {
  return parseCliValue(value, normalizeConnectorAccountKey);
}

function parseDiscordChannelId(value: string): string {
  return parseRequiredOptionValue(value, "Discord channel id");
}

function parseDiscordSessionId(value: string): string {
  return parseSessionIdOption(value);
}

function parseDiscordOwnerIdentity(value: string): string {
  return parseCliValue(value, normalizeIdentityHandle);
}

function parseDiscordOwnerAgent(value: string): string {
  return parseCliValue(value, normalizeAgentKey);
}

function parseEnvKey(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new InvalidArgumentError("Environment variable name must start with a letter or underscore and contain only letters, numbers, and underscores.");
  }

  return trimmed;
}

async function readDiscordBotTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const token = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (trimToUndefined(token) === undefined) {
    throw new Error("stdin did not provide a Discord bot token.");
  }

  return token;
}

function readDiscordBotTokenFromEnv(envKey: string, env: NodeJS.ProcessEnv): string {
  const token = trimToUndefined(env[envKey]);
  if (token === undefined) {
    throw new Error("Discord bot token environment variable is not set or empty.");
  }

  return token;
}

function resolveDiscordAccountCrypto(): CredentialCrypto {
  const crypto = resolveCredentialCrypto();
  if (!crypto) {
    throw new Error("CREDENTIALS_MASTER_KEY is required for Discord account commands.");
  }

  return crypto;
}

function createDiscordClient(dependencies: DiscordAccountCliDependencies): DiscordRestClient {
  return dependencies.createRestClient?.() ?? createDiscordRestClient();
}

function createDiscordRunService(
  options: DiscordRunServiceOptions,
  dependencies: DiscordCliDependencies,
): DiscordRunService {
  return dependencies.createRunService?.(options) ?? new DiscordService(options);
}

async function withDiscordAccountStores<T>(
  options: DiscordAccountCliOptions,
  fn: (stores: DiscordAccountStores) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores: DiscordAccountStores = {
      agentStore: new PostgresAgentStore({pool}),
      connectorStore: new PostgresConnectorAccountStore({pool}),
      identityStore: new PostgresIdentityStore({pool}),
    };
    await stores.connectorStore.ensureSchema();
    return fn(stores);
  });
}

async function withDiscordBindingStores<T>(
  options: DiscordAccountCliOptions,
  fn: (stores: DiscordBindingStores) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores: DiscordBindingStores = {
      connectorStore: new PostgresConnectorAccountStore({pool}),
      conversations: new ConversationRepo({pool}),
      sessionStore: new PostgresSessionStore({pool}),
    };
    await stores.connectorStore.ensureSchema();
    await stores.sessionStore.ensureSchema();
    await stores.conversations.ensureSchema();
    return fn(stores);
  });
}

function assertDiscordOwnerFlagsExclusive(options: DiscordAccountOwnerCliOptions): void {
  if (options.ownerIdentity && options.ownerAgent) {
    throw new Error("Choose only one Discord account owner: --owner-identity or --owner-agent.");
  }
}

async function resolveDiscordAccountOwner(
  options: DiscordAccountOwnerCliOptions,
  stores: Pick<DiscordAccountStores, "agentStore" | "identityStore">,
): Promise<ConnectorAccountOwnerInput> {
  assertDiscordOwnerFlagsExclusive(options);

  if (options.ownerIdentity) {
    const identity = await stores.identityStore.getIdentityByHandle(options.ownerIdentity);
    return {ownerIdentityId: identity.id};
  }

  if (options.ownerAgent) {
    const agent = await stores.agentStore.getAgent(options.ownerAgent);
    return {ownerAgentKey: agent.agentKey};
  }

  return {};
}

function formatOptional(value: string | undefined): string {
  return value ?? "-";
}

function renderDiscordAccount(
  headline: string,
  account: ConnectorAccountRecord,
  botUser?: DiscordCurrentUser,
): string {
  return [
    headline,
    `source ${account.source}`,
    `accountKey ${account.accountKey}`,
    `connectorKey ${account.connectorKey}`,
    `externalAccountId ${formatOptional(account.externalAccountId ?? botUser?.id)}`,
    `username ${formatOptional(botUser?.username ?? account.externalUsername)}`,
    `displayName ${formatOptional(botUser?.displayName ?? account.displayName)}`,
    `globalName ${formatOptional(botUser?.globalName)}`,
    `status ${account.status}`,
  ].join("\n");
}

function renderDiscordBotAccountResult(headline: string, result: DiscordBotAccountResult): string {
  return renderDiscordAccount(headline, result.account, result.botUser);
}

function buildDiscordChannelLookup(account: ConnectorAccountRecord, channelId: string) {
  return {
    source: DISCORD_SOURCE,
    connectorKey: account.connectorKey,
    externalConversationId: channelId,
  };
}

function buildDiscordBindingMetadata(account: ConnectorAccountRecord, channelId: string) {
  return {
    boundVia: "discord-cli",
    accountKey: account.accountKey,
    channelId,
  };
}

function readSafeBindingMetadataValue(binding: ConversationBinding, key: string): string | undefined {
  const metadata = binding.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }

  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function renderSafeBindingMetadataLines(binding: ConversationBinding): string[] {
  return ["boundVia", "accountKey", "channelId"]
    .flatMap((key) => {
      const value = readSafeBindingMetadataValue(binding, key);
      return value === undefined ? [] : [`  metadata ${key} ${value}`];
    });
}

function renderDiscordBindingSummary(
  headline: string,
  account: ConnectorAccountRecord,
  binding: ConversationBinding,
  extraLines: readonly string[] = [],
): string {
  return [
    headline,
    `accountKey ${account.accountKey}`,
    `connectorKey ${binding.connectorKey}`,
    `channelId ${binding.externalConversationId}`,
    ...extraLines,
    `sessionId ${binding.sessionId}`,
  ].join("\n");
}

function renderDiscordBindingListEntry(
  account: ConnectorAccountRecord,
  binding: ConversationBinding,
): string {
  return [
    `${DISCORD_SOURCE}/${account.accountKey}/${binding.externalConversationId}`,
    `  accountKey ${account.accountKey}`,
    `  connectorKey ${binding.connectorKey}`,
    `  channelId ${binding.externalConversationId}`,
    `  sessionId ${binding.sessionId}`,
    ...renderSafeBindingMetadataLines(binding),
  ].join("\n");
}

function renderDiscordUnbindResult(
  deleted: boolean,
  account: ConnectorAccountRecord,
  channelId: string,
): string {
  return [
    deleted
      ? `Unbound Discord channel ${channelId}.`
      : `No Discord channel binding for ${channelId}.`,
    `accountKey ${account.accountKey}`,
    `connectorKey ${account.connectorKey}`,
    `channelId ${channelId}`,
  ].join("\n");
}

async function resolveDiscordBindingAccount(
  stores: Pick<DiscordBindingStores, "connectorStore">,
  accountKey: string,
  options: {requireEnabled: boolean},
): Promise<ConnectorAccountRecord> {
  const account = await stores.connectorStore.getAccountByKey(DISCORD_SOURCE, accountKey);
  if (!account) {
    throw new Error(`Unknown Discord account ${accountKey}.`);
  }
  if (account.source !== DISCORD_SOURCE) {
    throw new Error(`Discord account ${accountKey} resolved to unsupported source ${account.source}.`);
  }
  if (options.requireEnabled && account.status !== "enabled") {
    throw new Error(`Discord account ${account.accountKey} is ${account.status}; enable it before binding channels.`);
  }

  return account;
}

export async function discordBindChannelCommand(options: DiscordBindChannelCliOptions): Promise<void> {
  await withDiscordBindingStores(options, async ({connectorStore, conversations, sessionStore}) => {
    const account = await resolveDiscordBindingAccount({connectorStore}, options.account, {
      requireEnabled: true,
    });
    await sessionStore.getSession(options.session);

    const lookup = buildDiscordChannelLookup(account, options.channel);
    const input = {
      ...lookup,
      sessionId: options.session,
      metadata: buildDiscordBindingMetadata(account, options.channel),
    };

    let existing = await conversations.getConversationBinding(lookup);
    if (!existing) {
      const created = await conversations.createConversationBinding(input);
      if (created) {
        process.stdout.write(renderDiscordBindingSummary(
          `Bound Discord channel ${options.channel} to session ${created.sessionId}.`,
          account,
          created,
        ) + "\n");
        return;
      }

      existing = await conversations.getConversationBinding(lookup);
      if (!existing) {
        throw new Error("Failed to create Discord channel binding after conflict.");
      }
    }

    if (existing.sessionId === options.session) {
      process.stdout.write(renderDiscordBindingSummary(
        `Discord channel ${options.channel} already bound to session ${existing.sessionId}.`,
        account,
        existing,
      ) + "\n");
      return;
    }

    if (!options.force) {
      throw new Error(
        `already_bound: Discord channel ${options.channel} for account ${account.accountKey} `
        + `is already bound to session ${existing.sessionId}. Use --force to rebind.`,
      );
    }

    const rebound = await conversations.bindConversation(input);
    process.stdout.write(renderDiscordBindingSummary(
      `Rebound Discord channel ${options.channel} to session ${rebound.binding.sessionId}.`,
      account,
      rebound.binding,
      [`previousSessionId ${rebound.previousSessionId ?? existing.sessionId}`],
    ) + "\n");
  });
}

export async function discordUnbindChannelCommand(options: DiscordChannelBindingCliOptions): Promise<void> {
  await withDiscordBindingStores(options, async ({connectorStore, conversations}) => {
    const account = await resolveDiscordBindingAccount({connectorStore}, options.account, {
      requireEnabled: false,
    });
    const deleted = await conversations.deleteConversationBinding(
      buildDiscordChannelLookup(account, options.channel),
    );

    process.stdout.write(renderDiscordUnbindResult(deleted, account, options.channel) + "\n");
  });
}

export async function discordListBindingsCommand(options: DiscordBindingListCliOptions): Promise<void> {
  await withDiscordBindingStores(options, async ({connectorStore, conversations}) => {
    const account = await resolveDiscordBindingAccount({connectorStore}, options.account, {
      requireEnabled: false,
    });
    const bindings = await conversations.listConversationBindings({
      source: DISCORD_SOURCE,
      connectorKey: account.connectorKey,
    });

    if (bindings.length === 0) {
      process.stdout.write(`No Discord channel bindings for account ${account.accountKey}.\n`);
      return;
    }

    process.stdout.write(bindings
      .map((binding) => renderDiscordBindingListEntry(account, binding))
      .join("\n\n") + "\n");
  });
}

export async function discordAccountSetCommand(
  accountKey: string,
  options: DiscordAccountSetCliOptions,
  dependencies: DiscordAccountCliDependencies = {},
): Promise<void> {
  if (!options.botTokenStdin) {
    throw new Error("Pass --bot-token-stdin to read the Discord bot token from stdin.");
  }
  assertDiscordOwnerFlagsExclusive(options);

  const crypto = resolveDiscordAccountCrypto();
  const readToken = dependencies.readBotTokenFromStdin ?? readDiscordBotTokenFromStdin;
  const botToken = await readToken();
  const client = createDiscordClient(dependencies);

  await withDiscordAccountStores(options, async (stores) => {
    const owner = await resolveDiscordAccountOwner(options, stores);
    const result = await setDiscordBotAccount({
      ...owner,
      accountKey,
      botToken,
      client,
      crypto,
      store: stores.connectorStore,
    });

    process.stdout.write(renderDiscordBotAccountResult(`Stored Discord account ${result.account.accountKey}.`, result) + "\n");
  });
}

export async function discordAccountImportEnvCommand(
  accountKey: string,
  options: DiscordAccountImportEnvCliOptions,
  dependencies: DiscordAccountCliDependencies = {},
): Promise<void> {
  assertDiscordOwnerFlagsExclusive(options);
  const crypto = resolveDiscordAccountCrypto();
  const botToken = readDiscordBotTokenFromEnv(options.envKey, dependencies.env ?? process.env);
  const client = createDiscordClient(dependencies);

  await withDiscordAccountStores(options, async (stores) => {
    const owner = await resolveDiscordAccountOwner(options, stores);
    const result = await setDiscordBotAccount({
      ...owner,
      accountKey,
      botToken,
      client,
      crypto,
      store: stores.connectorStore,
    });

    process.stdout.write(renderDiscordBotAccountResult(`Imported Discord account ${result.account.accountKey}.`, result) + "\n");
  });
}

export async function discordAccountWhoamiCommand(
  accountKey: string,
  options: DiscordAccountCliOptions,
  dependencies: DiscordAccountCliDependencies = {},
): Promise<void> {
  const crypto = resolveDiscordAccountCrypto();
  const client = createDiscordClient(dependencies);

  await withDiscordAccountStores(options, async (stores) => {
    const result = await validateStoredDiscordBotAccount({
      accountKey,
      client,
      crypto,
      store: stores.connectorStore,
    });

    process.stdout.write(renderDiscordBotAccountResult(`Discord account ${result.account.accountKey}.`, result) + "\n");
  });
}

export async function discordAccountDisableCommand(
  accountKey: string,
  options: DiscordAccountCliOptions,
): Promise<void> {
  await withDiscordAccountStores(options, async (stores) => {
    const result = await disableDiscordBotAccount({
      accountKey,
      store: stores.connectorStore,
    });

    process.stdout.write(renderDiscordAccount(`Disabled Discord account ${result.account.accountKey}.`, result.account) + "\n");
  });
}

export async function discordRunCommand(
  accountKey: string,
  options: DiscordRunCliOptions,
  dependencies: DiscordCliDependencies = {},
): Promise<void> {
  const service = createDiscordRunService({
    accountKey,
    dbUrl: options.dbUrl,
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

export function registerDiscordCommands(
  program: Command,
  dependencies: DiscordCliDependencies = {},
): void {
  const discordProgram = program
    .command("discord")
    .description("Run and manage the Discord channel");

  discordProgram
    .command("run")
    .description("Run one stored Discord connector account worker")
    .argument("<accountKey>", "Discord connector account key", parseDiscordAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: DiscordRunCliOptions) => {
      return discordRunCommand(accountKey, options, dependencies);
    });

  discordProgram
    .command("bind-channel")
    .description("Bind a Discord channel to a Panda session")
    .requiredOption("--account <accountKey>", "Discord connector account key", parseDiscordAccountKey)
    .requiredOption("--channel <discordChannelId>", "Discord channel id", parseDiscordChannelId)
    .requiredOption("--session <sessionId>", "Panda session id", parseDiscordSessionId)
    .option("--force", "Rebind when the channel is already bound to another session")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: DiscordBindChannelCliOptions) => {
      return discordBindChannelCommand(options);
    });

  discordProgram
    .command("unbind-channel")
    .description("Remove a Discord channel binding for an account")
    .requiredOption("--account <accountKey>", "Discord connector account key", parseDiscordAccountKey)
    .requiredOption("--channel <discordChannelId>", "Discord channel id", parseDiscordChannelId)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: DiscordChannelBindingCliOptions) => {
      return discordUnbindChannelCommand(options);
    });

  const bindingsProgram = discordProgram
    .command("bindings")
    .description("Manage Discord channel bindings");

  bindingsProgram
    .command("list")
    .description("List Discord channel bindings for an account")
    .requiredOption("--account <accountKey>", "Discord connector account key", parseDiscordAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: DiscordBindingListCliOptions) => {
      return discordListBindingsCommand(options);
    });

  const accountProgram = discordProgram
    .command("account")
    .description("Manage Discord connector accounts");

  accountProgram
    .command("set")
    .description("Store a Discord bot token from stdin after validation")
    .argument("<accountKey>", "Discord connector account key", parseDiscordAccountKey)
    .requiredOption("--bot-token-stdin", "Read the Discord bot token from stdin")
    .option("--owner-identity <handle>", "Panda identity handle that owns this account", parseDiscordOwnerIdentity)
    .option("--owner-agent <agentKey>", "Panda agent key that owns this account", parseDiscordOwnerAgent)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: DiscordAccountSetCliOptions) => {
      return discordAccountSetCommand(accountKey, options, dependencies);
    });

  accountProgram
    .command("import-env")
    .description("Import a Discord bot token from an environment variable after validation")
    .argument("<accountKey>", "Discord connector account key", parseDiscordAccountKey)
    .requiredOption("--env-key <ENV_VAR_NAME>", "Environment variable containing the Discord bot token", parseEnvKey)
    .option("--owner-identity <handle>", "Panda identity handle that owns this account", parseDiscordOwnerIdentity)
    .option("--owner-agent <agentKey>", "Panda agent key that owns this account", parseDiscordOwnerAgent)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: DiscordAccountImportEnvCliOptions) => {
      return discordAccountImportEnvCommand(accountKey, options, dependencies);
    });

  accountProgram
    .command("whoami")
    .description("Validate and show the Discord bot identity for an account")
    .argument("<accountKey>", "Discord connector account key", parseDiscordAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: DiscordAccountCliOptions) => {
      return discordAccountWhoamiCommand(accountKey, options, dependencies);
    });

  accountProgram
    .command("disable")
    .description("Disable a Discord connector account")
    .argument("<accountKey>", "Discord connector account key", parseDiscordAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: DiscordAccountCliOptions) => {
      return discordAccountDisableCommand(accountKey, options);
    });
}
