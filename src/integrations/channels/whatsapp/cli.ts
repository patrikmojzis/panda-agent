import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {PostgresAgentStore} from "../../../domain/agents/postgres.js";
import {normalizeAgentKey} from "../../../domain/agents/types.js";
import {writeCommandDescriptorHelp} from "../../../domain/commands/cli.js";
import {PostgresConnectorAccountStore} from "../../../domain/connectors/postgres.js";
import type {ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import {normalizeConnectorAccountKey} from "../../../domain/connectors/types.js";
import {resolveCredentialCrypto, type CredentialCrypto} from "../../../domain/credentials/crypto.js";
import {parseIdentityHandle} from "../../../domain/identity/cli.js";
import {PostgresIdentityStore} from "../../../domain/identity/postgres.js";
import {DB_URL_OPTION_DESCRIPTION} from "../../../lib/cli.js";
import {resolveMediaDir} from "../../../lib/data-dir.js";
import {type HealthServer, resolveOptionalHealthServerBinding, startHealthServer} from "../../../lib/health-server.js";
import {ensureSchemas, withPostgresPool} from "../../../lib/postgres-bootstrap.js";
import {PostgresWhatsAppAuthStore} from "./auth-store.js";
import {whatsappChatListCommandDescriptor, whatsappHistoryCommandDescriptor, whatsappSendCommandDescriptor} from "./commands.js";
import {WHATSAPP_SOURCE} from "./config.js";
import {
  createWhatsAppConnectorAccount,
  requireWhatsAppConnectorAccount,
  resetWhatsAppConnectorAccount,
} from "./connector-account.js";
import {WhatsAppService, type WhatsAppServiceOptions} from "./service.js";
import {WhatsAppAccountSupervisor, type WhatsAppRunService} from "./supervisor.js";

const WHATSAPP_ALL_ENABLED_POOL_MAX_FALLBACK = 2;

interface WhatsAppDatabaseOptions {
  dbUrl?: string;
}

interface WhatsAppRunCliOptions extends WhatsAppDatabaseOptions {
  allEnabled?: boolean;
}

interface WhatsAppAccountCreateCliOptions extends WhatsAppDatabaseOptions {
  agent: string;
  displayName?: string;
}

interface WhatsAppAccountLinkCliOptions extends WhatsAppDatabaseOptions {
  phone: string;
}

interface WhatsAppPairCliOptions extends WhatsAppDatabaseOptions {
  account: string;
  actor: string;
  identity: string;
}

interface WhatsAppUnpairCliOptions extends WhatsAppDatabaseOptions {
  account: string;
  actor: string;
}

interface CommandShimOptions {
  help?: boolean;
  json?: boolean | string;
}

interface WhatsAppAccountStores {
  accounts: PostgresConnectorAccountStore;
  agents: PostgresAgentStore;
  auth: PostgresWhatsAppAuthStore;
  identities: PostgresIdentityStore;
}

export interface WhatsAppCliDependencies {
  createRunService?: (options: WhatsAppServiceOptions) => WhatsAppRunService;
  crypto?: CredentialCrypto;
}

function parseCliValue(value: string, normalize: (raw: string) => string): string {
  try {
    return normalize(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function parseWhatsAppAccountKey(value: string): string {
  return parseCliValue(value, normalizeConnectorAccountKey);
}

function parseWhatsAppAgentKey(value: string): string {
  return parseCliValue(value, normalizeAgentKey);
}

function parseWhatsAppPhoneNumber(value: string): string {
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new InvalidArgumentError("WhatsApp phone number must contain 8-15 digits.");
  }
  return digits;
}

function parseWhatsAppActorId(value: string): string {
  const trimmed = value.trim();
  const jidMatch = trimmed.match(/^(\d{8,20})(?::\d+)?@(s\.whatsapp\.net|lid)$/i);
  if (jidMatch?.[1] && jidMatch[2]) return `${jidMatch[1]}@${jidMatch[2].toLowerCase()}`;
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new InvalidArgumentError("WhatsApp actor must be a phone number, @s.whatsapp.net JID, or @lid JID.");
  }
  return `${digits}@s.whatsapp.net`;
}

function requireWhatsAppCrypto(dependencies: WhatsAppCliDependencies = {}): CredentialCrypto {
  const crypto = dependencies.crypto ?? resolveCredentialCrypto();
  if (!crypto) throw new Error("CREDENTIALS_MASTER_KEY is required for WhatsApp accounts.");
  return crypto;
}

async function withWhatsAppAccountStores<T>(
  options: WhatsAppDatabaseOptions,
  dependencies: WhatsAppCliDependencies,
  fn: (stores: WhatsAppAccountStores) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const stores: WhatsAppAccountStores = {
      accounts: new PostgresConnectorAccountStore({pool}),
      agents: new PostgresAgentStore({pool}),
      auth: new PostgresWhatsAppAuthStore({pool, crypto: requireWhatsAppCrypto(dependencies)}),
      identities: new PostgresIdentityStore({pool}),
    };
    await ensureSchemas([stores.auth, stores.agents, stores.identities]);
    return fn(stores);
  });
}

function serviceOptions(
  account: ConnectorAccountRecord,
  options: WhatsAppDatabaseOptions,
  crypto: CredentialCrypto,
  overrides: Partial<Pick<WhatsAppServiceOptions, "disableHealthServer" | "poolMaxFallback">> = {},
): WhatsAppServiceOptions {
  return {
    accountId: account.id,
    accountKey: account.accountKey,
    connectorKey: account.connectorKey,
    crypto,
    dataDir: resolveMediaDir(),
    dbUrl: options.dbUrl,
    ...overrides,
  };
}

function createRunService(options: WhatsAppServiceOptions, dependencies: WhatsAppCliDependencies): WhatsAppRunService {
  return dependencies.createRunService?.(options) ?? new WhatsAppService(options);
}

export async function whatsappAccountCreateCommand(
  accountKey: string,
  options: WhatsAppAccountCreateCliOptions,
  dependencies: WhatsAppCliDependencies = {},
): Promise<void> {
  await withWhatsAppAccountStores(options, dependencies, async (stores) => {
    await stores.agents.getAgent(options.agent);
    const account = await createWhatsAppConnectorAccount({
      accountKey,
      agentKey: options.agent,
      displayName: options.displayName,
      accounts: stores.accounts,
      auth: stores.auth,
    });
    process.stdout.write(`Created disabled WhatsApp account ${account.accountKey}.\nconnector ${account.connectorKey}\n`);
  });
}

export async function whatsappAccountWhoamiCommand(
  accountKey: string,
  options: WhatsAppDatabaseOptions,
  dependencies: WhatsAppCliDependencies = {},
): Promise<void> {
  await withWhatsAppAccountStores(options, dependencies, async (stores) => {
    const account = await requireWhatsAppConnectorAccount({accountKey, accounts: stores.accounts});
    const service = createRunService(serviceOptions(account, options, requireWhatsAppCrypto(dependencies)), dependencies) as WhatsAppService;
    try {
      const whoami = await service.whoami();
      process.stdout.write([
        `WhatsApp account ${account.accountKey}`,
        `status ${account.status}`,
        `registered ${whoami.registered ? "yes" : "no"}`,
        `provider ${whoami.accountId ?? "unlinked"}`,
        `connector ${account.connectorKey}`,
        `name ${whoami.name ?? "-"}`,
      ].join("\n") + "\n");
    } finally {
      await service.stop();
    }
  });
}

export async function whatsappAccountLinkCommand(
  accountKey: string,
  options: WhatsAppAccountLinkCliOptions,
  dependencies: WhatsAppCliDependencies = {},
): Promise<void> {
  await withWhatsAppAccountStores(options, dependencies, async (stores) => {
    const account = await requireWhatsAppConnectorAccount({accountKey, accounts: stores.accounts});
    if (account.status === "enabled") throw new Error(`Disable WhatsApp account ${account.accountKey} before linking it.`);
    const service = createRunService(serviceOptions(account, options, requireWhatsAppCrypto(dependencies)), dependencies) as WhatsAppService;
    try {
      const result = await service.pair(options.phone, (pairingCode) => {
        process.stdout.write([
          `WhatsApp account ${account.accountKey}`,
          `pairing code ${pairingCode}`,
          "Enter the pairing code in WhatsApp and wait for linking to finish.",
        ].join("\n") + "\n");
      });
      if (!result.accountId) throw new Error("WhatsApp linking completed without an account identity.");
      process.stdout.write(`Linked WhatsApp account ${account.accountKey}.\nprovider ${result.accountId}\n`);
    } finally {
      await service.stop();
    }
  });
}

export async function whatsappAccountDisableCommand(
  accountKey: string,
  options: WhatsAppDatabaseOptions,
  dependencies: WhatsAppCliDependencies = {},
): Promise<void> {
  await withWhatsAppAccountStores(options, dependencies, async (stores) => {
    await requireWhatsAppConnectorAccount({accountKey, accounts: stores.accounts});
    const account = await stores.accounts.disableAccount(WHATSAPP_SOURCE, accountKey);
    process.stdout.write(`Disabled WhatsApp account ${account.accountKey}.\n`);
  });
}

export async function whatsappAccountResetCommand(
  accountKey: string,
  options: WhatsAppDatabaseOptions,
  dependencies: WhatsAppCliDependencies = {},
): Promise<void> {
  await withWhatsAppAccountStores(options, dependencies, async (stores) => {
    const account = await requireWhatsAppConnectorAccount({accountKey, accounts: stores.accounts});
    await resetWhatsAppConnectorAccount({account, accounts: stores.accounts, auth: stores.auth});
    process.stdout.write(`Reset local WhatsApp link for ${account.accountKey}.\n`);
  });
}

export async function whatsappPairCommand(
  options: WhatsAppPairCliOptions,
  dependencies: WhatsAppCliDependencies = {},
): Promise<void> {
  await withWhatsAppAccountStores(options, dependencies, async (stores) => {
    const account = await requireWhatsAppConnectorAccount({accountKey: options.account, accounts: stores.accounts});
    const identity = await stores.identities.getIdentityByHandle(options.identity);
    const pairedAgents = await stores.agents.listIdentityPairings(identity.id);
    if (!pairedAgents.some((pairing) => pairing.agentKey === account.ownerAgentKey)) {
      throw new Error(`Identity ${identity.handle} is not paired to agent ${account.ownerAgentKey}.`);
    }
    const binding = await stores.identities.ensureIdentityBinding({
      source: WHATSAPP_SOURCE,
      connectorKey: account.connectorKey,
      externalActorId: parseWhatsAppActorId(options.actor),
      identityId: identity.id,
      metadata: {pairedVia: "whatsapp-cli"},
    });
    process.stdout.write(`Paired WhatsApp actor ${binding.externalActorId}.\nidentity ${binding.identityId}\naccount ${account.accountKey}\n`);
  });
}

export async function whatsappUnpairCommand(
  options: WhatsAppUnpairCliOptions,
  dependencies: WhatsAppCliDependencies = {},
): Promise<void> {
  await withWhatsAppAccountStores(options, dependencies, async (stores) => {
    const account = await requireWhatsAppConnectorAccount({accountKey: options.account, accounts: stores.accounts});
    const externalActorId = parseWhatsAppActorId(options.actor);
    const deleted = await stores.identities.deleteIdentityBinding({
      source: WHATSAPP_SOURCE,
      connectorKey: account.connectorKey,
      externalActorId,
    });
    process.stdout.write(`${deleted ? "Unpaired" : "No pairing found for"} WhatsApp actor ${externalActorId}.\naccount ${account.accountKey}\n`);
  });
}

function logRunEvent(event: string, payload: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({source: WHATSAPP_SOURCE, event, timestamp: new Date().toISOString(), ...payload})}\n`);
}

async function runSingleAccount(
  accountKey: string,
  options: WhatsAppRunCliOptions,
  dependencies: WhatsAppCliDependencies,
): Promise<void> {
  const resolved = await withWhatsAppAccountStores(options, dependencies, async (stores) => {
    const account = await requireWhatsAppConnectorAccount({accountKey, accounts: stores.accounts});
    if (account.status !== "enabled") throw new Error(`WhatsApp account ${account.accountKey} is ${account.status}.`);
    return account;
  });
  const service = createRunService(serviceOptions(resolved, options, requireWhatsAppCrypto(dependencies)), dependencies);
  const shutdown = () => void service.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await service.run();
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

async function startSupervisorHealthServer(getSnapshot: () => Record<string, unknown>): Promise<HealthServer | null> {
  const binding = resolveOptionalHealthServerBinding({
    hostEnvKey: "PANDA_WHATSAPP_HEALTH_HOST",
    portEnvKey: "PANDA_WHATSAPP_HEALTH_PORT",
  });
  return binding ? startHealthServer({...binding, getSnapshot: () => ({ok: true, ...getSnapshot()})}) : null;
}

async function runAllEnabled(
  options: WhatsAppRunCliOptions,
  dependencies: WhatsAppCliDependencies,
): Promise<void> {
  const crypto = requireWhatsAppCrypto(dependencies);
  let stopping = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const listEnabled = () => withWhatsAppAccountStores(options, dependencies, async (stores) => {
    const accounts = await stores.accounts.listAccounts({source: WHATSAPP_SOURCE, status: "enabled"});
    return accounts.filter((account) => account.ownerKind === "agent");
  });
  const supervisor = new WhatsAppAccountSupervisor({
    listEnabledAccounts: listEnabled,
    createService: (account) => createRunService(serviceOptions(account, options, crypto, {
      disableHealthServer: true,
      poolMaxFallback: WHATSAPP_ALL_ENABLED_POOL_MAX_FALLBACK,
    }), dependencies),
    log: logRunEvent,
  });
  const health = await startSupervisorHealthServer(() => ({
    supervisor: "running",
    ...supervisor.snapshot(),
  }));
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await supervisor.stop();
    await health?.close();
    resolveStopped?.();
  };
  const onSignal = () => void shutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await supervisor.start();
    logRunEvent("worker_supervisor_started", {accountCount: supervisor.snapshot().connectorCount});
    await stopped;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await shutdown();
  }
}

export async function whatsappRunCommand(
  accountKey: string | undefined,
  options: WhatsAppRunCliOptions,
  dependencies: WhatsAppCliDependencies = {},
): Promise<void> {
  if (options.allEnabled && accountKey) throw new Error("Choose a WhatsApp account key or --all-enabled, not both.");
  if (options.allEnabled) return runAllEnabled(options, dependencies);
  if (!accountKey) throw new Error("Pass a WhatsApp account key or --all-enabled.");
  return runSingleAccount(accountKey, options, dependencies);
}

export function registerWhatsAppCommands(program: Command, dependencies: WhatsAppCliDependencies = {}): void {
  const whatsappProgram = program.command("whatsapp").description("Run and manage the WhatsApp channel");
  const chatProgram = whatsappProgram.command("chat").description("Inspect WhatsApp chats");

  chatProgram.command("list")
    .description(whatsappChatListCommandDescriptor.summary)
    .helpOption(false).allowUnknownOption(true).allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--connector <connectorKey>", "WhatsApp connector key")
    .action((options: CommandShimOptions) => {
      if (options.help) return writeCommandDescriptorHelp(whatsappChatListCommandDescriptor, Boolean(options.json));
      throw new Error("panda whatsapp chat list execution requires the agent command shim transport; use --help for the command contract.");
    });

  whatsappProgram.command("history")
    .description(whatsappHistoryCommandDescriptor.summary)
    .helpOption(false).allowUnknownOption(true).allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--chat <jidOrPhone>", "WhatsApp phone number or chat JID")
    .option("--connector <connectorKey>", "WhatsApp connector key")
    .option("--direction <direction>", "History direction: inbound, outbound, or all")
    .option("--limit <n>", "Maximum number of history items")
    .action((options: CommandShimOptions) => {
      if (options.help) return writeCommandDescriptorHelp(whatsappHistoryCommandDescriptor, Boolean(options.json));
      throw new Error("panda whatsapp history execution requires the agent command shim transport; use --help for the command contract.");
    });

  whatsappProgram.command("send")
    .description(whatsappSendCommandDescriptor.summary)
    .helpOption(false).allowUnknownOption(true).allowExcessArguments(true)
    .option("--help", "Show command help")
    .option("--json [input]", "Use JSON input/output; pass @file or @- when execution transport is wired")
    .option("--chat <jidOrPhone>", "WhatsApp phone number or chat JID")
    .option("--connector <connectorKey>", "WhatsApp connector key")
    .option("--text <text>", "Text message body")
    .option("--image <path>", "Repeatable image path")
    .option("--file <path>", "Repeatable file path")
    .action((options: CommandShimOptions) => {
      if (options.help) return writeCommandDescriptorHelp(whatsappSendCommandDescriptor, Boolean(options.json));
      throw new Error("panda whatsapp send execution requires the agent command shim transport; use --help for the command contract.");
    });

  const accountProgram = whatsappProgram.command("account").description("Manage agent-owned WhatsApp accounts");
  accountProgram.command("create")
    .argument("<accountKey>", "Stable operator-facing account key", parseWhatsAppAccountKey)
    .requiredOption("--agent <agentKey>", "Owning agent", parseWhatsAppAgentKey)
    .option("--display-name <name>", "Display name")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: WhatsAppAccountCreateCliOptions) => whatsappAccountCreateCommand(accountKey, options, dependencies));
  accountProgram.command("link")
    .argument("<accountKey>", "WhatsApp account key", parseWhatsAppAccountKey)
    .requiredOption("--phone <number>", "Phone number to link", parseWhatsAppPhoneNumber)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: WhatsAppAccountLinkCliOptions) => whatsappAccountLinkCommand(accountKey, options, dependencies));
  accountProgram.command("whoami")
    .argument("<accountKey>", "WhatsApp account key", parseWhatsAppAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: WhatsAppDatabaseOptions) => whatsappAccountWhoamiCommand(accountKey, options, dependencies));
  accountProgram.command("disable")
    .argument("<accountKey>", "WhatsApp account key", parseWhatsAppAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: WhatsAppDatabaseOptions) => whatsappAccountDisableCommand(accountKey, options, dependencies));
  accountProgram.command("reset")
    .argument("<accountKey>", "WhatsApp account key", parseWhatsAppAccountKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: WhatsAppDatabaseOptions) => whatsappAccountResetCommand(accountKey, options, dependencies));

  whatsappProgram.command("pair")
    .description("Pair a WhatsApp sender to a Panda identity")
    .requiredOption("--account <accountKey>", "WhatsApp account key", parseWhatsAppAccountKey)
    .requiredOption("--identity <handle>", "Identity handle to pair", parseIdentityHandle)
    .requiredOption("--actor <actor>", "Phone number, @s.whatsapp.net JID, or exact @lid JID", parseWhatsAppActorId)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: WhatsAppPairCliOptions) => whatsappPairCommand(options, dependencies));
  whatsappProgram.command("unpair")
    .description("Remove a WhatsApp sender identity pairing")
    .requiredOption("--account <accountKey>", "WhatsApp account key", parseWhatsAppAccountKey)
    .requiredOption("--actor <actor>", "Phone number, @s.whatsapp.net JID, or exact @lid JID", parseWhatsAppActorId)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((options: WhatsAppUnpairCliOptions) => whatsappUnpairCommand(options, dependencies));
  whatsappProgram.command("run")
    .description("Run one stored WhatsApp account worker, or all enabled accounts")
    .argument("[accountKey]", "WhatsApp account key", parseWhatsAppAccountKey)
    .option("--all-enabled", "Run and reconcile every enabled WhatsApp account")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string | undefined, options: WhatsAppRunCliOptions) => whatsappRunCommand(accountKey, options, dependencies));
}
