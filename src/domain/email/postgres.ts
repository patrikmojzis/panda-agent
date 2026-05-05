import {randomUUID} from "node:crypto";

import type {PoolClient} from "pg";

import {buildAgentTableNames} from "../agents/postgres-shared.js";
import type {PgPoolLike, PgQueryable} from "../threads/runtime/postgres-db.js";
import {withTransaction} from "../threads/runtime/postgres-db.js";
import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier, toJson, toMillis,} from "../threads/runtime/postgres-shared.js";
import {addConstraint, assertIntegrityChecks} from "../../lib/postgres-integrity.js";
import {collapseWhitespace, trimToUndefined} from "../../lib/strings.js";
import {
    DEFAULT_EMAIL_MAILBOXES,
    markExternalEmailContent,
    normalizeEmailAccountKey,
    normalizeEmailAddress,
    normalizeEmailMailbox,
    normalizeOptionalEmailAddress,
} from "./shared.js";
import {summarizeEmailAuthentication} from "./auth.js";
import {buildEmailTableNames, type EmailTableNames} from "./postgres-shared.js";
import type {
    EmailAccountRecord,
    EmailAccountSyncState,
    EmailAllowedRecipientRecord,
    EmailAttachmentInput,
    EmailAttachmentRecord,
    EmailAuthSummary,
    EmailAuthVerdict,
    EmailEndpointConfig,
    EmailMessageRecipientRecord,
    EmailMessageRecord,
    EmailRecipientInput,
    EmailStore,
    RecordEmailMessageInput,
    RecordEmailMessageResult,
    UpsertEmailAccountInput,
} from "./types.js";

export interface PostgresEmailStoreOptions {
  pool: PgPoolLike;
}

function requireTrimmed(field: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Email ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeEndpoint(input: EmailEndpointConfig, label: string): EmailEndpointConfig {
  const host = requireTrimmed(`${label} host`, input.host);
  const usernameCredentialEnvKey = requireTrimmed(`${label} username credential key`, input.usernameCredentialEnvKey);
  const passwordCredentialEnvKey = requireTrimmed(`${label} password credential key`, input.passwordCredentialEnvKey);
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)) {
    throw new Error(`Email ${label} port must be an integer between 1 and 65535.`);
  }

  return {
    host,
    ...(input.port !== undefined ? {port: input.port} : {}),
    ...(input.secure !== undefined ? {secure: input.secure} : {}),
    usernameCredentialEnvKey,
    passwordCredentialEnvKey,
  };
}

function normalizeSyncState(value: unknown): EmailAccountSyncState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as EmailAccountSyncState;
}

function parseEndpoint(value: unknown, field: string): EmailEndpointConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Email account ${field} config is invalid.`);
  }

  const record = value as Record<string, unknown>;
  return normalizeEndpoint({
    host: String(record.host ?? ""),
    port: typeof record.port === "number" ? record.port : undefined,
    secure: typeof record.secure === "boolean" ? record.secure : undefined,
    usernameCredentialEnvKey: String(record.usernameCredentialEnvKey ?? ""),
    passwordCredentialEnvKey: String(record.passwordCredentialEnvKey ?? ""),
  }, field);
}

function parseMailboxes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_EMAIL_MAILBOXES];
  }

  const mailboxes = value.map((entry) => normalizeEmailMailbox(String(entry)));
  return mailboxes.length > 0 ? mailboxes : [...DEFAULT_EMAIL_MAILBOXES];
}

function parseAccountRow(row: Record<string, unknown>): EmailAccountRecord {
  return {
    agentKey: String(row.agent_key),
    accountKey: String(row.account_key),
    fromAddress: String(row.from_address),
    fromName: row.from_name === null ? undefined : String(row.from_name),
    imap: parseEndpoint(row.imap_config, "IMAP"),
    smtp: parseEndpoint(row.smtp_config, "SMTP"),
    mailboxes: parseMailboxes(row.mailboxes),
    syncState: normalizeSyncState(row.sync_state),
    enabled: Boolean(row.enabled),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseAllowedRecipientRow(row: Record<string, unknown>): EmailAllowedRecipientRecord {
  return {
    agentKey: String(row.agent_key),
    accountKey: String(row.account_key),
    address: String(row.address),
    createdAt: toMillis(row.created_at),
  };
}

function parseMessageRow(row: Record<string, unknown>): EmailMessageRecord {
  return {
    id: String(row.id),
    agentKey: String(row.agent_key),
    accountKey: String(row.account_key),
    direction: String(row.direction) as EmailMessageRecord["direction"],
    mailbox: row.mailbox === null ? undefined : String(row.mailbox),
    uid: row.uid === null ? undefined : Number(row.uid),
    uidValidity: row.uid_validity === null ? undefined : String(row.uid_validity),
    messageIdHeader: row.message_id_header === null ? undefined : String(row.message_id_header),
    inReplyTo: row.in_reply_to === null ? undefined : String(row.in_reply_to),
    referencesHeader: row.references_header === null ? undefined : String(row.references_header),
    threadKey: String(row.thread_key),
    subject: row.subject === null ? undefined : String(row.subject),
    fromName: row.from_name === null ? undefined : String(row.from_name),
    fromAddress: row.from_address === null ? undefined : String(row.from_address),
    replyToAddress: row.reply_to_address === null ? undefined : String(row.reply_to_address),
    sentAt: row.sent_at === null ? undefined : toMillis(row.sent_at),
    receivedAt: row.received_at === null ? undefined : toMillis(row.received_at),
    bodyText: row.body_text === null ? undefined : String(row.body_text),
    bodyExcerpt: row.body_excerpt === null ? undefined : String(row.body_excerpt),
    authenticationResults: row.authentication_results === null ? undefined : String(row.authentication_results),
    authSpf: row.auth_spf === null ? undefined : String(row.auth_spf) as EmailAuthVerdict,
    authDkim: row.auth_dkim === null ? undefined : String(row.auth_dkim) as EmailAuthVerdict,
    authDmarc: row.auth_dmarc === null ? undefined : String(row.auth_dmarc) as EmailAuthVerdict,
    authSummary: String(row.auth_summary) as EmailAuthSummary,
    hasAttachments: Boolean(row.has_attachments),
    sourceDeliveryId: row.source_delivery_id === null ? undefined : String(row.source_delivery_id),
    createdAt: toMillis(row.created_at),
  };
}

function parseMessageRecipientRow(row: Record<string, unknown>): EmailMessageRecipientRecord {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    role: String(row.role) as EmailMessageRecipientRecord["role"],
    address: String(row.address),
    name: row.name === null ? undefined : String(row.name),
    createdAt: toMillis(row.created_at),
  };
}

function parseAttachmentRow(row: Record<string, unknown>): EmailAttachmentRecord {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    filename: row.filename === null ? undefined : String(row.filename),
    mimeType: row.mime_type === null ? undefined : String(row.mime_type),
    sizeBytes: row.size_bytes === null ? undefined : Number(row.size_bytes),
    localPath: row.local_path === null ? undefined : String(row.local_path),
    contentId: row.content_id === null ? undefined : String(row.content_id),
    createdAt: toMillis(row.created_at),
  };
}

function normalizeBodyExcerpt(bodyText: string | undefined): string | undefined {
  const collapsed = collapseWhitespace(bodyText ?? "");
  return collapsed ? collapsed.slice(0, 500) : undefined;
}

function normalizeBodyText(input: RecordEmailMessageInput): string | undefined {
  const bodyText = trimToUndefined(input.bodyText);
  return input.direction === "inbound"
    ? markExternalEmailContent(bodyText)
    : bodyText;
}

function normalizeAuthSummary(input: RecordEmailMessageInput): EmailAuthSummary {
  if (input.direction === "outbound") {
    return input.authSummary ?? "trusted";
  }

  const verdictSummary = summarizeEmailAuthentication({
    authSpf: input.authSpf,
    authDkim: input.authDkim,
    authDmarc: input.authDmarc,
  });
  if (verdictSummary === "suspicious" || input.authSummary === "suspicious") {
    return "suspicious";
  }

  return verdictSummary;
}

function normalizeThreadKey(input: RecordEmailMessageInput): string {
  const explicit = trimToUndefined(input.threadKey);
  if (explicit) {
    return explicit;
  }

  const firstReference = trimToUndefined(input.referencesHeader)?.split(/\s+/)[0];
  return firstReference
    ?? trimToUndefined(input.inReplyTo)
    ?? trimToUndefined(input.messageIdHeader)
    ?? randomUUID();
}

function normalizeRecipients(recipients: readonly EmailRecipientInput[] | undefined): readonly EmailRecipientInput[] {
  return (recipients ?? []).map((recipient) => ({
    role: recipient.role,
    address: normalizeEmailAddress(recipient.address),
    name: trimToUndefined(recipient.name),
  }));
}

function normalizeAttachments(attachments: readonly EmailAttachmentInput[] | undefined): readonly EmailAttachmentInput[] {
  return (attachments ?? []).map((attachment) => ({
    filename: trimToUndefined(attachment.filename),
    mimeType: trimToUndefined(attachment.mimeType),
    sizeBytes: attachment.sizeBytes === undefined ? undefined : Math.max(0, Math.floor(attachment.sizeBytes)),
    localPath: trimToUndefined(attachment.localPath),
    contentId: trimToUndefined(attachment.contentId),
  }));
}

export class PostgresEmailStore implements EmailStore {
  private readonly pool: PgPoolLike;
  private readonly tables: EmailTableNames;
  private readonly agentTableName: string;

  constructor(options: PostgresEmailStoreOptions) {
    this.pool = options.pool;
    this.tables = buildEmailTableNames();
    this.agentTableName = buildAgentTableNames().agents;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.emailAccounts} (
        id UUID PRIMARY KEY,
        agent_key TEXT NOT NULL,
        account_key TEXT NOT NULL,
        from_address TEXT NOT NULL,
        from_name TEXT,
        imap_config JSONB NOT NULL,
        smtp_config JSONB NOT NULL,
        mailboxes JSONB NOT NULL,
        sync_state JSONB NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.emailAllowedRecipients} (
        id UUID PRIMARY KEY,
        agent_key TEXT NOT NULL,
        account_key TEXT NOT NULL,
        address TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.emailMessages} (
        id UUID PRIMARY KEY,
        agent_key TEXT NOT NULL,
        account_key TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        mailbox TEXT,
        uid INTEGER CHECK (uid IS NULL OR uid >= 0),
        uid_validity TEXT,
        message_id_header TEXT,
        in_reply_to TEXT,
        references_header TEXT,
        thread_key TEXT NOT NULL,
        subject TEXT,
        from_name TEXT,
        from_address TEXT,
        reply_to_address TEXT,
        sent_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ,
        body_text TEXT,
        body_excerpt TEXT,
        authentication_results TEXT,
        auth_spf TEXT CHECK (auth_spf IS NULL OR auth_spf IN ('pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'unknown')),
        auth_dkim TEXT CHECK (auth_dkim IS NULL OR auth_dkim IN ('pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'unknown')),
        auth_dmarc TEXT CHECK (auth_dmarc IS NULL OR auth_dmarc IN ('pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'unknown')),
        auth_summary TEXT NOT NULL DEFAULT 'unknown' CHECK (auth_summary IN ('trusted', 'suspicious', 'unknown')),
        has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
        source_delivery_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.emailMessageRecipients} (
        id UUID PRIMARY KEY,
        message_id UUID NOT NULL REFERENCES ${this.tables.emailMessages}(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('from', 'reply_to', 'to', 'cc')),
        address TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.emailAttachments} (
        id UUID PRIMARY KEY,
        message_id UUID NOT NULL REFERENCES ${this.tables.emailMessages}(id) ON DELETE CASCADE,
        filename TEXT,
        mime_type TEXT,
        size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
        local_path TEXT,
        content_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_email_accounts_key_idx`)}
      ON ${this.tables.emailAccounts} (agent_key, account_key)
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_email_allowed_key_idx`)}
      ON ${this.tables.emailAllowedRecipients} (agent_key, account_key, address)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_email_accounts_enabled_idx`)}
      ON ${this.tables.emailAccounts} (enabled, agent_key, account_key)
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_email_messages_mailbox_uid_idx`)}
      ON ${this.tables.emailMessages} (agent_key, account_key, mailbox, uid_validity, uid)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_email_messages_thread_idx`)}
      ON ${this.tables.emailMessages} (agent_key, account_key, thread_key, COALESCE(received_at, sent_at, created_at))
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_email_recipients_message_idx`)}
      ON ${this.tables.emailMessageRecipients} (message_id, role)
    `);
    await assertIntegrityChecks(this.pool, "Email schema", [
      {
        label: "email_accounts.agent_key orphaned from agents.agent_key",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.emailAccounts} AS account
          LEFT JOIN ${this.agentTableName} AS agent
            ON agent.agent_key = account.agent_key
          WHERE agent.agent_key IS NULL
        `,
      },
    ]);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.emailAccounts}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_email_accounts_agent_fk`)}
      FOREIGN KEY (agent_key)
      REFERENCES ${this.agentTableName}(agent_key)
      ON DELETE CASCADE
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.emailAllowedRecipients}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_email_allowed_account_fk`)}
      FOREIGN KEY (agent_key, account_key)
      REFERENCES ${this.tables.emailAccounts}(agent_key, account_key)
      ON DELETE CASCADE
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.emailMessages}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_email_messages_account_fk`)}
      FOREIGN KEY (agent_key, account_key)
      REFERENCES ${this.tables.emailAccounts}(agent_key, account_key)
      ON DELETE CASCADE
    `);
  }

  async upsertAccount(input: UpsertEmailAccountInput): Promise<EmailAccountRecord> {
    const agentKey = requireTrimmed("agent key", input.agentKey);
    const accountKey = normalizeEmailAccountKey(input.accountKey);
    const mailboxes = (input.mailboxes && input.mailboxes.length > 0 ? input.mailboxes : DEFAULT_EMAIL_MAILBOXES)
      .map((mailbox) => normalizeEmailMailbox(mailbox));
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.emailAccounts} (
        id,
        agent_key,
        account_key,
        from_address,
        from_name,
        imap_config,
        smtp_config,
        mailboxes,
        sync_state,
        enabled
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb,
        $7::jsonb,
        $8::jsonb,
        $9::jsonb,
        $10
      )
      ON CONFLICT (agent_key, account_key)
      DO UPDATE SET
        from_address = EXCLUDED.from_address,
        from_name = EXCLUDED.from_name,
        imap_config = EXCLUDED.imap_config,
        smtp_config = EXCLUDED.smtp_config,
        mailboxes = EXCLUDED.mailboxes,
        enabled = EXCLUDED.enabled,
        updated_at = NOW()
      RETURNING *
    `, [
      randomUUID(),
      agentKey,
      accountKey,
      normalizeEmailAddress(input.fromAddress),
      trimToUndefined(input.fromName) ?? null,
      JSON.stringify(normalizeEndpoint(input.imap, "IMAP")),
      JSON.stringify(normalizeEndpoint(input.smtp, "SMTP")),
      JSON.stringify(mailboxes),
      JSON.stringify({}),
      input.enabled ?? true,
    ]);

    return parseAccountRow(result.rows[0] as Record<string, unknown>);
  }

  async disableAccount(agentKey: string, accountKey: string): Promise<EmailAccountRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.emailAccounts}
      SET enabled = FALSE,
          updated_at = NOW()
      WHERE agent_key = $1
        AND account_key = $2
      RETURNING *
    `, [
      requireTrimmed("agent key", agentKey),
      normalizeEmailAccountKey(accountKey),
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown email account ${accountKey}`);
    }

    return parseAccountRow(row as Record<string, unknown>);
  }

  async getAccount(agentKey: string, accountKey: string): Promise<EmailAccountRecord> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.emailAccounts}
      WHERE agent_key = $1
        AND account_key = $2
    `, [
      requireTrimmed("agent key", agentKey),
      normalizeEmailAccountKey(accountKey),
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown email account ${accountKey}`);
    }

    return parseAccountRow(row as Record<string, unknown>);
  }

  async listEnabledAccounts(): Promise<readonly EmailAccountRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.emailAccounts}
      WHERE enabled = TRUE
      ORDER BY agent_key ASC, account_key ASC
    `);
    return result.rows.map((row) => parseAccountRow(row as Record<string, unknown>));
  }

  async updateAccountSyncState(
    agentKey: string,
    accountKey: string,
    syncState: EmailAccountSyncState,
  ): Promise<EmailAccountRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.emailAccounts}
      SET sync_state = $3::jsonb,
          updated_at = NOW()
      WHERE agent_key = $1
        AND account_key = $2
      RETURNING *
    `, [
      requireTrimmed("agent key", agentKey),
      normalizeEmailAccountKey(accountKey),
      toJson(syncState) ?? "{}",
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown email account ${accountKey}`);
    }

    return parseAccountRow(row as Record<string, unknown>);
  }

  async addAllowedRecipient(agentKey: string, accountKey: string, address: string): Promise<EmailAllowedRecipientRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.emailAllowedRecipients} (
        id,
        agent_key,
        account_key,
        address
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (agent_key, account_key, address)
      DO UPDATE SET address = EXCLUDED.address
      RETURNING *
    `, [
      randomUUID(),
      requireTrimmed("agent key", agentKey),
      normalizeEmailAccountKey(accountKey),
      normalizeEmailAddress(address),
    ]);
    return parseAllowedRecipientRow(result.rows[0] as Record<string, unknown>);
  }

  async removeAllowedRecipient(agentKey: string, accountKey: string, address: string): Promise<boolean> {
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.emailAllowedRecipients}
      WHERE agent_key = $1
        AND account_key = $2
        AND address = $3
    `, [
      requireTrimmed("agent key", agentKey),
      normalizeEmailAccountKey(accountKey),
      normalizeEmailAddress(address),
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async listAllowedRecipients(agentKey: string, accountKey: string): Promise<readonly EmailAllowedRecipientRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.emailAllowedRecipients}
      WHERE agent_key = $1
        AND account_key = $2
      ORDER BY address ASC
    `, [
      requireTrimmed("agent key", agentKey),
      normalizeEmailAccountKey(accountKey),
    ]);
    return result.rows.map((row) => parseAllowedRecipientRow(row as Record<string, unknown>));
  }

  async assertRecipientsAllowed(agentKey: string, accountKey: string, addresses: readonly string[]): Promise<void> {
    const normalized = Array.from(new Set(addresses.map((address) => normalizeEmailAddress(address))));
    if (normalized.length === 0) {
      return;
    }

    const allowed = await this.listAllowedRecipients(agentKey, accountKey);
    const allowedSet = new Set(allowed.map((recipient) => recipient.address));
    const blocked = normalized.filter((address) => !allowedSet.has(address));
    if (blocked.length > 0) {
      throw new Error(`Email account ${accountKey} is not allowed to send to ${blocked.join(", ")}.`);
    }
  }

  async recordMessage(input: RecordEmailMessageInput): Promise<RecordEmailMessageResult> {
    return withTransaction(this.pool, async (client) => await this.recordMessageInTransaction(client, input));
  }

  private async recordMessageInTransaction(
    client: PoolClient,
    input: RecordEmailMessageInput,
  ): Promise<RecordEmailMessageResult> {
    const agentKey = requireTrimmed("agent key", input.agentKey);
    const accountKey = normalizeEmailAccountKey(input.accountKey);
    const recipients = normalizeRecipients(input.recipients);
    const attachments = normalizeAttachments(input.attachments);
    const bodyText = normalizeBodyText(input);
    const bodyExcerpt = normalizeBodyExcerpt(bodyText);
    const authSummary = normalizeAuthSummary(input);
    const fromAddress = normalizeOptionalEmailAddress(input.fromAddress);
    const replyToAddress = normalizeOptionalEmailAddress(input.replyToAddress);
    const uid = input.uid === undefined ? null : Math.floor(input.uid);
    const uidValidity = trimToUndefined(input.uidValidity) ?? null;
    const mailbox = trimToUndefined(input.mailbox) ?? null;
    if (mailbox && uidValidity && uid !== null) {
      const existing = await this.findMessageByMailboxUidOrNull(client, {
        agentKey,
        accountKey,
        mailbox,
        uid,
        uidValidity,
      });
      if (existing) {
        return {
          message: existing,
          inserted: false,
        };
      }
    }

    const result = await client.query(`
      INSERT INTO ${this.tables.emailMessages} (
        id,
        agent_key,
        account_key,
        direction,
        mailbox,
        uid,
        uid_validity,
        message_id_header,
        in_reply_to,
        references_header,
        thread_key,
        subject,
        from_name,
        from_address,
        reply_to_address,
        sent_at,
        received_at,
        body_text,
        body_excerpt,
        authentication_results,
        auth_spf,
        auth_dkim,
        auth_dmarc,
        auth_summary,
        has_attachments,
        source_delivery_id
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        $21,
        $22,
        $23,
        $24,
        $25,
        $26
      )
      ON CONFLICT (agent_key, account_key, mailbox, uid_validity, uid)
      DO NOTHING
      RETURNING *
    `, [
      randomUUID(),
      agentKey,
      accountKey,
      input.direction,
      mailbox,
      uid,
      uidValidity,
      trimToUndefined(input.messageIdHeader) ?? null,
      trimToUndefined(input.inReplyTo) ?? null,
      trimToUndefined(input.referencesHeader) ?? null,
      normalizeThreadKey(input),
      trimToUndefined(input.subject) ?? null,
      trimToUndefined(input.fromName) ?? null,
      fromAddress ?? null,
      replyToAddress ?? null,
      input.sentAt === undefined ? null : new Date(input.sentAt),
      input.receivedAt === undefined ? null : new Date(input.receivedAt),
      bodyText ?? null,
      bodyExcerpt ?? null,
      trimToUndefined(input.authenticationResults) ?? null,
      input.authSpf ?? null,
      input.authDkim ?? null,
      input.authDmarc ?? null,
      authSummary,
      attachments.length > 0,
      trimToUndefined(input.sourceDeliveryId) ?? null,
    ]);

    const insertedRow = result.rows[0];
    if (!insertedRow) {
      const existing = await this.findMessageByMailboxUid(client, {
        agentKey,
        accountKey,
        mailbox,
        uid,
        uidValidity,
      });
      return {
        message: existing,
        inserted: false,
      };
    }

    const message = parseMessageRow(insertedRow as Record<string, unknown>);
    await this.insertRecipients(client, message.id, recipients);
    await this.insertAttachments(client, message.id, attachments);
    return {
      message,
      inserted: true,
    };
  }

  private async findMessageByMailboxUid(
    queryable: PgQueryable,
    input: {
      agentKey: string;
      accountKey: string;
      mailbox: string | null;
      uid: number | null;
      uidValidity: string | null;
    },
  ): Promise<EmailMessageRecord> {
    const result = await queryable.query(`
      SELECT *
      FROM ${this.tables.emailMessages}
      WHERE agent_key = $1
        AND account_key = $2
        AND mailbox = $3
        AND uid_validity = $4
        AND uid = $5
      LIMIT 1
    `, [
      input.agentKey,
      input.accountKey,
      input.mailbox,
      input.uidValidity,
      input.uid,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Email message insert was skipped but no existing message was found.");
    }

    return parseMessageRow(row as Record<string, unknown>);
  }

  private async findMessageByMailboxUidOrNull(
    queryable: PgQueryable,
    input: {
      agentKey: string;
      accountKey: string;
      mailbox: string;
      uid: number;
      uidValidity: string;
    },
  ): Promise<EmailMessageRecord | null> {
    const result = await queryable.query(`
      SELECT *
      FROM ${this.tables.emailMessages}
      WHERE agent_key = $1
        AND account_key = $2
        AND mailbox = $3
        AND uid_validity = $4
        AND uid = $5
      LIMIT 1
    `, [
      input.agentKey,
      input.accountKey,
      input.mailbox,
      input.uidValidity,
      input.uid,
    ]);
    const row = result.rows[0];
    return row ? parseMessageRow(row as Record<string, unknown>) : null;
  }

  private async insertRecipients(
    client: PoolClient,
    messageId: string,
    recipients: readonly EmailRecipientInput[],
  ): Promise<void> {
    for (const recipient of recipients) {
      await client.query(`
        INSERT INTO ${this.tables.emailMessageRecipients} (
          id,
          message_id,
          role,
          address,
          name
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        randomUUID(),
        messageId,
        recipient.role,
        recipient.address,
        trimToUndefined(recipient.name) ?? null,
      ]);
    }
  }

  private async insertAttachments(
    client: PoolClient,
    messageId: string,
    attachments: readonly EmailAttachmentInput[],
  ): Promise<void> {
    for (const attachment of attachments) {
      await client.query(`
        INSERT INTO ${this.tables.emailAttachments} (
          id,
          message_id,
          filename,
          mime_type,
          size_bytes,
          local_path,
          content_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        randomUUID(),
        messageId,
        trimToUndefined(attachment.filename) ?? null,
        trimToUndefined(attachment.mimeType) ?? null,
        attachment.sizeBytes ?? null,
        trimToUndefined(attachment.localPath) ?? null,
        trimToUndefined(attachment.contentId) ?? null,
      ]);
    }
  }

  async getMessage(messageId: string): Promise<EmailMessageRecord> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.emailMessages}
      WHERE id = $1
    `, [requireTrimmed("message id", messageId)]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown email message ${messageId}`);
    }

    return parseMessageRow(row as Record<string, unknown>);
  }

  async listMessageRecipients(messageId: string): Promise<readonly EmailMessageRecipientRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.emailMessageRecipients}
      WHERE message_id = $1
      ORDER BY created_at ASC, role ASC
    `, [requireTrimmed("message id", messageId)]);
    return result.rows.map((row) => parseMessageRecipientRow(row as Record<string, unknown>));
  }

  async listMessageAttachments(messageId: string): Promise<readonly EmailAttachmentRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.emailAttachments}
      WHERE message_id = $1
      ORDER BY created_at ASC
    `, [requireTrimmed("message id", messageId)]);
    return result.rows.map((row) => parseAttachmentRow(row as Record<string, unknown>));
  }
}
