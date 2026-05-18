import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../lib/cli.js";
import {withPostgresPool} from "../../lib/postgres-bootstrap.js";
import {PostgresConnectorAccountStore} from "./postgres.js";
import {
  type ConnectorAccountRecord,
  type ConnectorAccountSecretSummary,
  normalizeConnectorAccountKey,
  normalizeConnectorSource,
} from "./types.js";

interface ConnectorAccountCliOptions {
  dbUrl?: string;
}

interface ConnectorAccountListCliOptions extends ConnectorAccountCliOptions {
  source?: string;
}

function parseConnectorCliValue(value: string, normalize: (raw: string) => string): string {
  try {
    return normalize(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidArgumentError(message);
  }
}

function parseConnectorSourceOption(value: string): string {
  return parseConnectorCliValue(value, normalizeConnectorSource);
}

function parseConnectorAccountKeyOption(value: string): string {
  return parseConnectorCliValue(value, normalizeConnectorAccountKey);
}

async function withConnectorAccountStore<T>(
  options: ConnectorAccountCliOptions,
  fn: (store: PostgresConnectorAccountStore) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const store = new PostgresConnectorAccountStore({pool});
    await store.ensureSchema();
    return fn(store);
  });
}

function formatOptional(value: string | undefined): string {
  return value ?? "-";
}

function formatPresence(present: boolean): string {
  return present ? "present" : "none";
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function formatOwner(account: ConnectorAccountRecord): string {
  if (account.ownerKind === "identity") {
    return `identity ${account.ownerIdentityId}`;
  }
  if (account.ownerKind === "agent") {
    return `agent ${account.ownerAgentKey}`;
  }

  return "system";
}

function formatSecretCount(secrets: readonly ConnectorAccountSecretSummary[]): string {
  return secrets.length === 0 ? "none" : `${secrets.length} present`;
}

function hasConfig(account: ConnectorAccountRecord): boolean {
  return Object.keys(account.config).length > 0;
}

function hasMetadata(account: ConnectorAccountRecord): boolean {
  return account.metadata !== undefined;
}

function renderAccountListEntry(
  account: ConnectorAccountRecord,
  secrets: readonly ConnectorAccountSecretSummary[],
): string {
  return [
    `${account.source}/${account.accountKey}`,
    `  connector ${account.connectorKey}`,
    `  status ${account.status}`,
    `  owner ${formatOwner(account)}`,
    `  display ${formatOptional(account.displayName)}`,
    `  external account ${formatOptional(account.externalAccountId)}`,
    `  external username ${formatOptional(account.externalUsername)}`,
    `  config ${formatPresence(hasConfig(account))}`,
    `  metadata ${formatPresence(hasMetadata(account))}`,
    `  secrets ${formatSecretCount(secrets)}`,
    `  updated ${formatTimestamp(account.updatedAt)}`,
  ].join("\n");
}

function renderSecretPresenceLines(secrets: readonly ConnectorAccountSecretSummary[]): string[] {
  return secrets.map((secret) => `  ${secret.secretKey} present · updated ${formatTimestamp(secret.updatedAt)}`);
}

function renderAccountInspect(
  account: ConnectorAccountRecord,
  secrets: readonly ConnectorAccountSecretSummary[],
): string {
  return [
    `Connector account ${account.source}/${account.accountKey}`,
    `id ${account.id}`,
    `connector ${account.connectorKey}`,
    `status ${account.status}`,
    `owner ${formatOwner(account)}`,
    `display ${formatOptional(account.displayName)}`,
    `external account ${formatOptional(account.externalAccountId)}`,
    `external username ${formatOptional(account.externalUsername)}`,
    `config ${formatPresence(hasConfig(account))}`,
    `metadata ${formatPresence(hasMetadata(account))}`,
    `created ${formatTimestamp(account.createdAt)}`,
    `updated ${formatTimestamp(account.updatedAt)}`,
    `secrets ${formatSecretCount(secrets)}`,
    ...renderSecretPresenceLines(secrets),
  ].join("\n");
}

function renderAccountStatusChange(
  verb: "Enabled" | "Disabled",
  account: ConnectorAccountRecord,
  secrets: readonly ConnectorAccountSecretSummary[],
): string {
  return [
    `${verb} connector account ${account.source}/${account.accountKey}.`,
    `connector ${account.connectorKey}`,
    `status ${account.status}`,
    `secrets ${formatSecretCount(secrets)}`,
  ].join("\n");
}

async function listConnectorAccountsCommand(options: ConnectorAccountListCliOptions): Promise<void> {
  await withConnectorAccountStore(options, async (store) => {
    const accounts = await store.listAccounts({
      ...(options.source !== undefined ? {source: options.source} : {}),
    });

    if (accounts.length === 0) {
      process.stdout.write(options.source
        ? `No connector accounts for ${options.source}.\n`
        : "No connector accounts.\n");
      return;
    }

    const rendered: string[] = [];
    for (const account of accounts) {
      rendered.push(renderAccountListEntry(account, await store.listSecretKeys(account.id)));
    }

    process.stdout.write(rendered.join("\n\n") + "\n");
  });
}

async function inspectConnectorAccountCommand(
  source: string,
  accountKey: string,
  options: ConnectorAccountCliOptions,
): Promise<void> {
  await withConnectorAccountStore(options, async (store) => {
    const account = await store.getAccountByKey(source, accountKey);
    if (!account) {
      throw new Error(`Unknown connector account ${source}/${accountKey}.`);
    }

    process.stdout.write(renderAccountInspect(account, await store.listSecretKeys(account.id)) + "\n");
  });
}

async function setConnectorAccountEnabledCommand(
  source: string,
  accountKey: string,
  enabled: boolean,
  options: ConnectorAccountCliOptions,
): Promise<void> {
  await withConnectorAccountStore(options, async (store) => {
    const account = enabled
      ? await store.enableAccount(source, accountKey)
      : await store.disableAccount(source, accountKey);
    const secrets = await store.listSecretKeys(account.id);

    process.stdout.write(renderAccountStatusChange(enabled ? "Enabled" : "Disabled", account, secrets) + "\n");
  });
}

export function registerConnectorCommands(program: Command): void {
  const connectorProgram = program
    .command("connector")
    .description("Manage generic connector resources");

  const accountProgram = connectorProgram
    .command("account")
    .description("Manage generic connector accounts");

  accountProgram
    .command("list")
    .description("List connector accounts")
    .option("--source <source>", "Filter by connector source", parseConnectorSourceOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: ConnectorAccountListCliOptions) => {
      return listConnectorAccountsCommand(options);
    });

  accountProgram
    .command("inspect")
    .description("Inspect one connector account")
    .argument("<source>", "Connector source", parseConnectorSourceOption)
    .argument("<accountKey>", "Connector account key", parseConnectorAccountKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((source: string, accountKey: string, options: ConnectorAccountCliOptions) => {
      return inspectConnectorAccountCommand(source, accountKey, options);
    });

  accountProgram
    .command("enable")
    .description("Enable one connector account")
    .argument("<source>", "Connector source", parseConnectorSourceOption)
    .argument("<accountKey>", "Connector account key", parseConnectorAccountKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((source: string, accountKey: string, options: ConnectorAccountCliOptions) => {
      return setConnectorAccountEnabledCommand(source, accountKey, true, options);
    });

  accountProgram
    .command("disable")
    .description("Disable one connector account")
    .argument("<source>", "Connector source", parseConnectorSourceOption)
    .argument("<accountKey>", "Connector account key", parseConnectorAccountKeyOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((source: string, accountKey: string, options: ConnectorAccountCliOptions) => {
      return setConnectorAccountEnabledCommand(source, accountKey, false, options);
    });
}
