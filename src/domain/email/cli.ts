import process from "node:process";

import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {ensureSchemas, withPostgresPool} from "../../app/runtime/postgres-bootstrap.js";
import {parseAgentKey, PostgresAgentStore} from "../agents/index.js";
import {DEFAULT_EMAIL_MAILBOXES, normalizeEmailAddress, normalizeEmailMailbox} from "./shared.js";
import {PostgresEmailStore} from "./postgres.js";
import type {EmailEndpointConfig} from "./types.js";

interface EmailCliOptions {
  dbUrl?: string;
}

interface EmailAccountOptions extends EmailCliOptions {
  agent: string;
  from: string;
  name?: string;
  imapHost: string;
  imapPort?: number;
  imapSecure?: boolean;
  imapUsernameKey: string;
  imapPasswordKey: string;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsernameKey: string;
  smtpPasswordKey: string;
  mailbox?: string[];
  secure?: boolean;
  disabled?: boolean;
}

interface EmailAccountLookupOptions extends EmailCliOptions {
  agent: string;
}

interface EmailAllowOptions extends EmailAccountLookupOptions {}

function parseEmailPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new InvalidArgumentError("Email port must be an integer between 1 and 65535.");
  }

  return parsed;
}

function collectMailbox(value: string, previous: string[] = []): string[] {
  return [...previous, normalizeEmailMailbox(value)];
}

function endpoint(input: {
  host: string;
  port?: number;
  secure?: boolean;
  usernameKey: string;
  passwordKey: string;
}): EmailEndpointConfig {
  return {
    host: input.host,
    ...(input.port !== undefined ? {port: input.port} : {}),
    ...(input.secure !== undefined ? {secure: input.secure} : {}),
    usernameCredentialEnvKey: input.usernameKey,
    passwordCredentialEnvKey: input.passwordKey,
  };
}

async function withEmailStores<T>(
  options: EmailCliOptions,
  fn: (store: PostgresEmailStore) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const agents = new PostgresAgentStore({pool});
    const email = new PostgresEmailStore({pool});
    await ensureSchemas([agents, email]);
    return fn(email);
  });
}

export async function emailAccountSetCommand(accountKey: string, options: EmailAccountOptions): Promise<void> {
  await withEmailStores(options, async (store) => {
    const secureFallback = options.secure;
    const account = await store.upsertAccount({
      agentKey: options.agent,
      accountKey,
      fromAddress: options.from,
      fromName: options.name,
      imap: endpoint({
        host: options.imapHost,
        port: options.imapPort,
        secure: options.imapSecure ?? secureFallback,
        usernameKey: options.imapUsernameKey,
        passwordKey: options.imapPasswordKey,
      }),
      smtp: endpoint({
        host: options.smtpHost,
        port: options.smtpPort,
        secure: options.smtpSecure ?? secureFallback,
        usernameKey: options.smtpUsernameKey,
        passwordKey: options.smtpPasswordKey,
      }),
      mailboxes: options.mailbox && options.mailbox.length > 0 ? options.mailbox : DEFAULT_EMAIL_MAILBOXES,
      enabled: !options.disabled,
    });

    process.stdout.write(
      [
        `Configured email account ${account.accountKey}.`,
        `agent ${account.agentKey}`,
        `from ${account.fromAddress}`,
        `mailboxes ${account.mailboxes.join(", ")}`,
        `enabled ${account.enabled ? "yes" : "no"}`,
      ].join("\n") + "\n",
    );
  });
}

export async function emailAccountDisableCommand(accountKey: string, options: EmailAccountLookupOptions): Promise<void> {
  await withEmailStores(options, async (store) => {
    const account = await store.disableAccount(options.agent, accountKey);
    process.stdout.write(`Disabled email account ${account.accountKey} for ${account.agentKey}.\n`);
  });
}

export async function emailAllowAddCommand(
  accountKey: string,
  address: string,
  options: EmailAllowOptions,
): Promise<void> {
  await withEmailStores(options, async (store) => {
    const recipient = await store.addAllowedRecipient(options.agent, accountKey, address);
    process.stdout.write(`Allowed ${recipient.address} for email account ${recipient.accountKey}.\n`);
  });
}

export async function emailAllowRemoveCommand(
  accountKey: string,
  address: string,
  options: EmailAllowOptions,
): Promise<void> {
  await withEmailStores(options, async (store) => {
    const normalized = normalizeEmailAddress(address);
    const removed = await store.removeAllowedRecipient(options.agent, accountKey, normalized);
    process.stdout.write(removed
      ? `Removed ${normalized} from email account ${accountKey}.\n`
      : `No allowlist entry removed for ${normalized}.\n`);
  });
}

export async function emailAllowListCommand(accountKey: string, options: EmailAllowOptions): Promise<void> {
  await withEmailStores(options, async (store) => {
    const recipients = await store.listAllowedRecipients(options.agent, accountKey);
    if (recipients.length === 0) {
      process.stdout.write("No allowed recipients.\n");
      return;
    }

    process.stdout.write(recipients.map((recipient) => recipient.address).join("\n") + "\n");
  });
}

export function registerEmailCommands(program: Command): void {
  const emailProgram = program
    .command("email")
    .description("Configure Panda email accounts");

  const accountProgram = emailProgram
    .command("account")
    .description("Manage email sender/reader accounts");

  accountProgram
    .command("set")
    .description("Create or update an email account")
    .argument("<accountKey>", "Stable email account key")
    .requiredOption("--agent <agentKey>", "Agent that owns the account", parseAgentKey)
    .requiredOption("--from <email>", "From email address", normalizeEmailAddress)
    .option("--name <name>", "From display name")
    .requiredOption("--imap-host <host>", "IMAP host")
    .option("--imap-port <port>", "IMAP port", parseEmailPort)
    .option("--imap-secure", "Use TLS for IMAP")
    .requiredOption("--imap-username-key <envKey>", "Credential env key for IMAP username")
    .requiredOption("--imap-password-key <envKey>", "Credential env key for IMAP password")
    .requiredOption("--smtp-host <host>", "SMTP host")
    .option("--smtp-port <port>", "SMTP port", parseEmailPort)
    .option("--smtp-secure", "Use TLS for SMTP")
    .requiredOption("--smtp-username-key <envKey>", "Credential env key for SMTP username")
    .requiredOption("--smtp-password-key <envKey>", "Credential env key for SMTP password")
    .option("--mailbox <mailbox>", "Mailbox to sync; repeatable", collectMailbox, [])
    .option("--secure", "Use TLS for both IMAP and SMTP unless overridden")
    .option("--disabled", "Save the account disabled")
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: EmailAccountOptions) => {
      return emailAccountSetCommand(accountKey, options);
    });

  accountProgram
    .command("disable")
    .description("Disable an email account")
    .argument("<accountKey>", "Stable email account key")
    .requiredOption("--agent <agentKey>", "Agent that owns the account", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: EmailAccountLookupOptions) => {
      return emailAccountDisableCommand(accountKey, options);
    });

  const allowProgram = emailProgram
    .command("allow")
    .description("Manage exact send-recipient allowlists");

  allowProgram
    .command("add")
    .description("Allow one recipient for an email account")
    .argument("<accountKey>", "Stable email account key")
    .argument("<email>", "Recipient email address", normalizeEmailAddress)
    .requiredOption("--agent <agentKey>", "Agent that owns the account", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, address: string, options: EmailAllowOptions) => {
      return emailAllowAddCommand(accountKey, address, options);
    });

  allowProgram
    .command("remove")
    .description("Remove one recipient from an email account allowlist")
    .argument("<accountKey>", "Stable email account key")
    .argument("<email>", "Recipient email address", normalizeEmailAddress)
    .requiredOption("--agent <agentKey>", "Agent that owns the account", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, address: string, options: EmailAllowOptions) => {
      return emailAllowRemoveCommand(accountKey, address, options);
    });

  allowProgram
    .command("list")
    .description("List allowed recipients for an email account")
    .argument("<accountKey>", "Stable email account key")
    .requiredOption("--agent <agentKey>", "Agent that owns the account", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: EmailAllowOptions) => {
      return emailAllowListCommand(accountKey, options);
    });
}

