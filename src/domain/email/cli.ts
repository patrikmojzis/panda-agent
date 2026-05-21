import process from "node:process";

import {Command} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../lib/cli.js";
import {ensureSchemas, withPostgresPool} from "../../lib/postgres-bootstrap.js";
import {parseAgentKey} from "../agents/cli.js";
import {PostgresAgentStore} from "../agents/postgres.js";
import {PostgresIdentityStore} from "../identity/postgres.js";
import {PostgresSessionStore} from "../sessions/postgres.js";
import {parseLabeledPortOption} from "../../lib/cli.js";
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

interface EmailRouteSetOptions extends EmailAccountLookupOptions {
  session: string;
  mailbox?: string;
}

interface EmailRouteLookupOptions extends EmailAccountLookupOptions {
  mailbox?: string;
}

function collectMailbox(value: string, previous: string[] = []): string[] {
  return [...previous, normalizeEmailMailbox(value)];
}

const parseEmailPortOption = parseLabeledPortOption("Email port");

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
  fn: (stores: {email: PostgresEmailStore; sessions: PostgresSessionStore}) => Promise<T>,
): Promise<T> {
  return withPostgresPool(options.dbUrl, async (pool) => {
    const identities = new PostgresIdentityStore({pool});
    const agents = new PostgresAgentStore({pool});
    const sessions = new PostgresSessionStore({pool});
    const email = new PostgresEmailStore({pool});
    await ensureSchemas([identities, agents, sessions, email]);
    return fn({email, sessions});
  });
}

async function emailAccountSetCommand(accountKey: string, options: EmailAccountOptions): Promise<void> {
  await withEmailStores(options, async ({email: store}) => {
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

async function emailAccountDisableCommand(accountKey: string, options: EmailAccountLookupOptions): Promise<void> {
  await withEmailStores(options, async ({email: store}) => {
    const account = await store.disableAccount(options.agent, accountKey);
    process.stdout.write(`Disabled email account ${account.accountKey} for ${account.agentKey}.\n`);
  });
}

async function emailAllowAddCommand(
  accountKey: string,
  address: string,
  options: EmailAllowOptions,
): Promise<void> {
  await withEmailStores(options, async ({email: store}) => {
    const recipient = await store.addAllowedRecipient(options.agent, accountKey, address);
    process.stdout.write(`Allowed ${recipient.address} for email account ${recipient.accountKey}.\n`);
  });
}

async function emailAllowRemoveCommand(
  accountKey: string,
  address: string,
  options: EmailAllowOptions,
): Promise<void> {
  await withEmailStores(options, async ({email: store}) => {
    const normalized = normalizeEmailAddress(address);
    const removed = await store.removeAllowedRecipient(options.agent, accountKey, normalized);
    process.stdout.write(removed
      ? `Removed ${normalized} from email account ${accountKey}.\n`
      : `No allowlist entry removed for ${normalized}.\n`);
  });
}

async function emailAllowListCommand(accountKey: string, options: EmailAllowOptions): Promise<void> {
  await withEmailStores(options, async ({email: store}) => {
    const recipients = await store.listAllowedRecipients(options.agent, accountKey);
    if (recipients.length === 0) {
      process.stdout.write("No allowed recipients.\n");
      return;
    }

    process.stdout.write(recipients.map((recipient) => recipient.address).join("\n") + "\n");
  });
}

async function emailRouteSetCommand(accountKey: string, options: EmailRouteSetOptions): Promise<void> {
  await withEmailStores(options, async ({email, sessions}) => {
    const session = await sessions.resolveSessionRef({
      sessionRef: options.session,
      agentKey: options.agent,
    });
    const route = await email.setRoute({
      agentKey: options.agent,
      accountKey,
      ...(options.mailbox ? {mailbox: options.mailbox} : {}),
      sessionId: session.id,
    });

    process.stdout.write([
      `Configured email route ${route.id}.`,
      `agent ${route.agentKey}`,
      `account ${route.accountKey}`,
      `mailbox ${route.mailbox ?? "<account>"}`,
      `session ${route.sessionId}`,
    ].join("\n") + "\n");
  });
}

async function emailRouteRemoveCommand(accountKey: string, options: EmailRouteLookupOptions): Promise<void> {
  await withEmailStores(options, async ({email}) => {
    const removed = await email.removeRoute({
      agentKey: options.agent,
      accountKey,
      ...(options.mailbox ? {mailbox: options.mailbox} : {}),
    });
    const mailbox = options.mailbox ?? "<account>";
    process.stdout.write(removed
      ? `Removed email route for ${accountKey} ${mailbox}.\n`
      : `No email route removed for ${accountKey} ${mailbox}.\n`);
  });
}

async function emailRouteListCommand(accountKey: string | undefined, options: EmailAccountLookupOptions): Promise<void> {
  await withEmailStores(options, async ({email}) => {
    const routes = await email.listRoutes(options.agent, accountKey);
    if (routes.length === 0) {
      process.stdout.write("No email routes.\n");
      return;
    }

    process.stdout.write(routes.map((route) => [
      route.accountKey,
      route.mailbox ?? "<account>",
      route.sessionId,
      route.id,
    ].join("\t")).join("\n") + "\n");
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
    .option("--imap-port <port>", "IMAP port", parseEmailPortOption)
    .option("--imap-secure", "Use TLS for IMAP")
    .requiredOption("--imap-username-key <envKey>", "Credential env key for IMAP username")
    .requiredOption("--imap-password-key <envKey>", "Credential env key for IMAP password")
    .requiredOption("--smtp-host <host>", "SMTP host")
    .option("--smtp-port <port>", "SMTP port", parseEmailPortOption)
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

  const routeProgram = emailProgram
    .command("route")
    .description("Manage deterministic email account/mailbox session routes");

  routeProgram
    .command("set")
    .description("Route an email account or mailbox to a session")
    .argument("<accountKey>", "Stable email account key")
    .requiredOption("--agent <agentKey>", "Agent that owns the account", parseAgentKey)
    .requiredOption("--session <sessionRef>", "Target session id or alias")
    .option("--mailbox <mailbox>", "Mailbox-specific route; omit for account route", normalizeEmailMailbox)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: EmailRouteSetOptions) => {
      return emailRouteSetCommand(accountKey, options);
    });

  routeProgram
    .command("remove")
    .description("Remove an email account or mailbox route")
    .argument("<accountKey>", "Stable email account key")
    .requiredOption("--agent <agentKey>", "Agent that owns the account", parseAgentKey)
    .option("--mailbox <mailbox>", "Mailbox-specific route; omit for account route", normalizeEmailMailbox)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string, options: EmailRouteLookupOptions) => {
      return emailRouteRemoveCommand(accountKey, options);
    });

  routeProgram
    .command("list")
    .description("List email routes")
    .argument("[accountKey]", "Optional email account key")
    .requiredOption("--agent <agentKey>", "Agent that owns the account", parseAgentKey)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .action((accountKey: string | undefined, options: EmailAccountLookupOptions) => {
      return emailRouteListCommand(accountKey, options);
    });
}
