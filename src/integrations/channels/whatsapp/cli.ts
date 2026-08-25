import process from "node:process";

import {Command, InvalidArgumentError} from "commander";
import type {Pool} from "pg";

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
import {withPostgresPool} from "../../../lib/postgres-database.js";
import {runCleanupSteps} from "../../../lib/cleanup.js";
import {PostgresWhatsAppAuthStore} from "./auth-store.js";
import {whatsappChatListCommandDescriptor, whatsappHistoryCommandDescriptor, whatsappSendCommandDescriptor} from "./commands.js";
import {WHATSAPP_SOURCE} from "./config.js";
import {
  createWhatsAppConnectorAccount,
  requireWhatsAppConnectorAccount,
  resetWhatsAppConnectorAccount,
} from "./connector-account.js";
import {WhatsAppService, type WhatsAppServiceOptions} from "./service.js";
import {ConnectorAccountSupervisor, type ConnectorAccountSupervisorWorker} from "../account-supervisor.js";
import {startConnectorDaemonRuntime, type ConnectorDaemonRuntimeHandle} from "../worker-runtime.js";

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
  pool: Pool;
  accounts: PostgresConnectorAccountStore;
  agents: PostgresAgentStore;
  auth: PostgresWhatsAppAuthStore;
  identities: PostgresIdentityStore;
}

export interface WhatsAppCliDependencies {
  createDaemonRuntime?: (options: {dbUrl?: string; crypto: CredentialCrypto}) => Promise<ConnectorDaemonRuntimeHandle>;
  createRunService?: (options: WhatsAppServiceOptions) => WhatsAppRunService;
  crypto?: CredentialCrypto;
}

type WhatsAppRunService = ConnectorAccountSupervisorWorker;

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
      pool,
      accounts: new PostgresConnectorAccountStore({pool}),
      agents: new PostgresAgentStore({pool}),
      auth: new PostgresWhatsAppAuthStore({pool, crypto: requireWhatsAppCrypto(dependencies)}),
      identities: new PostgresIdentityStore({pool}),
    };
    return fn(stores);
  });
}

function serviceOptions(
  account: ConnectorAccountRecord,
  crypto: CredentialCrypto,
  connection: Pick<WhatsAppServiceOptions, "pool" | "runtime">,
  overrides: Partial<Pick<WhatsAppServiceOptions, "disableHealthServer">> = {},
): WhatsAppServiceOptions {
  return {
    accountId: account.id,
    accountKey: account.accountKey,
    connectorKey: account.connectorKey,
    crypto,
    dataDir: resolveMediaDir(),
    ...connection,
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
    const service = createRunService(serviceOptions(account, requireWhatsAppCrypto(dependencies), {pool: stores.pool}), dependencies) as WhatsAppService;
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
    const service = createRunService(serviceOptions(account, requireWhatsAppCrypto(dependencies), {pool: stores.pool}), dependencies) as WhatsAppService;
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

async function startWhatsAppDaemonRuntime(
  options: WhatsAppRunCliOptions,
  dependencies: WhatsAppCliDependencies,
  crypto: CredentialCrypto,
): Promise<ConnectorDaemonRuntimeHandle> {
  if (dependencies.createDaemonRuntime) return dependencies.createDaemonRuntime({dbUrl: options.dbUrl, crypto});
  return startConnectorDaemonRuntime({
    source: WHATSAPP_SOURCE,
    dbUrl: options.dbUrl,
    poolMaxEnvKey: "PANDA_WHATSAPP_DB_POOL_MAX",
    log: logRunEvent,
  });
}

async function runSingleAccount(
  accountKey: string,
  options: WhatsAppRunCliOptions,
  dependencies: WhatsAppCliDependencies,
): Promise<void> {
  const crypto = requireWhatsAppCrypto(dependencies);
  const runtime = await startWhatsAppDaemonRuntime(options, dependencies, crypto);
  let service: WhatsAppRunService | null = null;
  let stopPromise: Promise<void> | null = null;
  let shutdown: (() => void) | null = null;
  try {
    const accounts = new PostgresConnectorAccountStore({pool: runtime.pool});
    const resolved = await requireWhatsAppConnectorAccount({accountKey, accounts});
    if (resolved.status !== "enabled") throw new Error(`WhatsApp account ${resolved.accountKey} is ${resolved.status}.`);
    service = createRunService(serviceOptions(resolved, crypto, {runtime}), dependencies);
    const stopService = () => stopPromise ??= service!.stop();
    shutdown = () => void stopService();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await service.run();
  } finally {
    if (shutdown) {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    }
    await runCleanupSteps([
      {label: "whatsapp-service", run: async () => {
        if (service) await (stopPromise ??= service.stop());
      }},
      {label: "whatsapp-daemon-runtime", run: async () => runtime.close()},
    ]);
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
  const runtime = await startWhatsAppDaemonRuntime(options, dependencies, crypto);
  const accounts = new PostgresConnectorAccountStore({pool: runtime.pool});
  let stopping = false;
  let shutdownPromise: Promise<void> | null = null;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const supervisor = new ConnectorAccountSupervisor<ConnectorAccountRecord, WhatsAppRunService>({
    listEnabledAccounts: async () => {
      const enabled = await accounts.listAccounts({source: WHATSAPP_SOURCE, status: "enabled"});
      return enabled.filter((account) => account.ownerKind === "agent");
    },
    createWorker: (account) => createRunService(serviceOptions(account, crypto, {runtime}, {
      disableHealthServer: true,
    }), dependencies),
    log: logRunEvent,
  });
  let health: HealthServer | null = null;
  const createHealthServer = () => startSupervisorHealthServer(() => ({
    supervisor: "running",
    ...supervisor.snapshot(),
    listener: runtime.getNotificationSnapshot(),
  }));
  const shutdown = () => shutdownPromise ??= (async () => {
    stopping = true;
    await supervisor.stop();
    resolveStopped?.();
  })();
  const onSignal = () => void shutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    health = await createHealthServer();
    await supervisor.start();
    if (!stopping) {
      logRunEvent("worker_supervisor_started", {
        accountCount: supervisor.snapshot().connectorCount,
        poolMax: runtime.poolConfig.max,
      });
    }
    await stopped;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await shutdown();
    await runtime.close();
    await health?.close();
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
