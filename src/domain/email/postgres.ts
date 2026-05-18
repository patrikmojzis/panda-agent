import {optionalTimestampMillis, requireTimestampMillis, toJson} from "../../lib/postgres-values.js";
import {randomUUID} from "node:crypto";

import {requireBoolean} from "../../lib/booleans.js";
import {requireNonNegativeInteger} from "../../lib/numbers.js";
import type {PgClientLike, PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {requireTrimmedString, trimToUndefined} from "../../lib/strings.js";
import {
    DEFAULT_EMAIL_MAILBOXES,
    normalizeEmailAccountKey,
    normalizeEmailAddress,
    normalizeEmailMailbox,
} from "./shared.js";
import {normalizeEmailMessageInput} from "./message-input.js";
import {ensurePostgresEmailSchema} from "./postgres-schema.js";
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
    EmailMessageDirection,
    EmailMessageRecipientRecord,
    EmailMessageRecord,
    EmailRecipientRole,
    EmailRecipientInput,
    EmailStore,
    RecordEmailMessageInput,
    RecordEmailMessageResult,
    UpsertEmailAccountInput,
} from "./types.js";

export interface PostgresEmailStoreOptions {
  pool: PgPoolLike;
}

function requireTrimmed(field: string, value: unknown): string {
  return requireTrimmedString(value, `Email ${field} must be a string.`, `Email ${field} must not be empty.`);
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
    host: requireTrimmed(`account ${field} host`, record.host),
    port: parseOptionalPort(record.port, field),
    secure: parseOptionalEndpointBoolean(record.secure, field),
    usernameCredentialEnvKey: requireTrimmed(`account ${field} username credential key`, record.usernameCredentialEnvKey),
    passwordCredentialEnvKey: requireTrimmed(`account ${field} password credential key`, record.passwordCredentialEnvKey),
  }, field);
}

function parseMailboxes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("Email account mailboxes must be an array.");
  }

  const mailboxes = value.map((entry) => normalizeEmailMailbox(requireTrimmed("account mailbox", entry)));
  return mailboxes.length > 0 ? mailboxes : [...DEFAULT_EMAIL_MAILBOXES];
}

function parseOptionalPort(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number") {
    throw new Error(`Email account ${field} port must be a number.`);
  }

  return value;
}

function parseOptionalEndpointBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Email account ${field} secure flag must be a boolean.`);
  }

  return value;
}

function parseMessageDirection(value: unknown): EmailMessageDirection {
  if (value === "inbound" || value === "outbound") {
    return value;
  }

  throw new Error(`Unsupported email message direction ${String(value)}.`);
}

function parseRecipientRole(value: unknown): EmailRecipientRole {
  if (value === "from" || value === "reply_to" || value === "to" || value === "cc") {
    return value;
  }

  throw new Error(`Unsupported email recipient role ${String(value)}.`);
}

function parseAuthVerdict(value: unknown): EmailAuthVerdict {
  if (
    value === "pass"
    || value === "fail"
    || value === "softfail"
    || value === "neutral"
    || value === "none"
    || value === "temperror"
    || value === "permerror"
    || value === "unknown"
  ) {
    return value;
  }

  throw new Error(`Unsupported email authentication verdict ${String(value)}.`);
}

function parseOptionalAuthVerdict(value: unknown): EmailAuthVerdict | undefined {
  return value === null || value === undefined ? undefined : parseAuthVerdict(value);
}

function parseAuthSummary(value: unknown): EmailAuthSummary {
  if (value === "trusted" || value === "suspicious" || value === "unknown") {
    return value;
  }

  throw new Error(`Unsupported email authentication summary ${String(value)}.`);
}

function parseOptionalString(field: string, value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Email ${field} must be a string.`);
  }

  return value;
}

function parseOptionalNormalizedAddress(field: string, value: unknown): string | undefined {
  const parsed = parseOptionalString(field, value);
  return parsed === undefined ? undefined : normalizeEmailAddress(parsed);
}

function parseOptionalNonNegativeInteger(field: string, value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return requireNonNegativeInteger(value, `Email ${field}`);
}

function parseAccountRow(row: Record<string, unknown>): EmailAccountRecord {
  return {
    agentKey: requireTrimmed("account agent key", row.agent_key),
    accountKey: normalizeEmailAccountKey(requireTrimmed("account key", row.account_key)),
    fromAddress: normalizeEmailAddress(requireTrimmed("account from address", row.from_address)),
    fromName: parseOptionalString("account from name", row.from_name),
    imap: parseEndpoint(row.imap_config, "IMAP"),
    smtp: parseEndpoint(row.smtp_config, "SMTP"),
    mailboxes: parseMailboxes(row.mailboxes),
    syncState: normalizeSyncState(row.sync_state),
    enabled: requireBoolean(row.enabled, "Email account enabled flag must be a boolean."),
    createdAt: requireTimestampMillis(row.created_at, "Email account created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Email account updated_at must be a valid timestamp."),
  };
}

function parseAllowedRecipientRow(row: Record<string, unknown>): EmailAllowedRecipientRecord {
  return {
    agentKey: requireTrimmed("allowed recipient agent key", row.agent_key),
    accountKey: normalizeEmailAccountKey(requireTrimmed("allowed recipient account key", row.account_key)),
    address: normalizeEmailAddress(requireTrimmed("allowed recipient address", row.address)),
    createdAt: requireTimestampMillis(row.created_at, "Email allowed recipient created_at must be a valid timestamp."),
  };
}

function parseMessageRow(row: Record<string, unknown>): EmailMessageRecord {
  return {
    id: requireTrimmed("message id", row.id),
    agentKey: requireTrimmed("message agent key", row.agent_key),
    accountKey: normalizeEmailAccountKey(requireTrimmed("message account key", row.account_key)),
    direction: parseMessageDirection(row.direction),
    mailbox: parseOptionalString("message mailbox", row.mailbox),
    uid: parseOptionalNonNegativeInteger("message uid", row.uid),
    uidValidity: parseOptionalString("message uid validity", row.uid_validity),
    messageIdHeader: parseOptionalString("message-id header", row.message_id_header),
    inReplyTo: parseOptionalString("in-reply-to header", row.in_reply_to),
    referencesHeader: parseOptionalString("references header", row.references_header),
    threadKey: requireTrimmed("message thread key", row.thread_key),
    subject: parseOptionalString("message subject", row.subject),
    fromName: parseOptionalString("message from name", row.from_name),
    fromAddress: parseOptionalNormalizedAddress("message from address", row.from_address),
    replyToAddress: parseOptionalNormalizedAddress("message reply-to address", row.reply_to_address),
    sentAt: optionalTimestampMillis(row.sent_at, "Email message sent_at must be a valid timestamp."),
    receivedAt: optionalTimestampMillis(row.received_at, "Email message received_at must be a valid timestamp."),
    bodyText: parseOptionalString("message body text", row.body_text),
    bodyExcerpt: parseOptionalString("message body excerpt", row.body_excerpt),
    authenticationResults: parseOptionalString("message authentication results", row.authentication_results),
    authSpf: parseOptionalAuthVerdict(row.auth_spf),
    authDkim: parseOptionalAuthVerdict(row.auth_dkim),
    authDmarc: parseOptionalAuthVerdict(row.auth_dmarc),
    authSummary: parseAuthSummary(row.auth_summary),
    hasAttachments: requireBoolean(row.has_attachments, "Email message attachment flag must be a boolean."),
    sourceDeliveryId: parseOptionalString("message source delivery id", row.source_delivery_id),
    createdAt: requireTimestampMillis(row.created_at, "Email message created_at must be a valid timestamp."),
  };
}

function parseMessageRecipientRow(row: Record<string, unknown>): EmailMessageRecipientRecord {
  return {
    id: requireTrimmed("recipient id", row.id),
    messageId: requireTrimmed("recipient message id", row.message_id),
    role: parseRecipientRole(row.role),
    address: normalizeEmailAddress(requireTrimmed("recipient address", row.address)),
    name: parseOptionalString("recipient name", row.name),
    createdAt: requireTimestampMillis(row.created_at, "Email recipient created_at must be a valid timestamp."),
  };
}

function parseAttachmentRow(row: Record<string, unknown>): EmailAttachmentRecord {
  return {
    id: requireTrimmed("attachment id", row.id),
    messageId: requireTrimmed("attachment message id", row.message_id),
    filename: parseOptionalString("attachment filename", row.filename),
    mimeType: parseOptionalString("attachment MIME type", row.mime_type),
    sizeBytes: parseOptionalNonNegativeInteger("attachment size", row.size_bytes),
    localPath: parseOptionalString("attachment local path", row.local_path),
    contentId: parseOptionalString("attachment content id", row.content_id),
    createdAt: requireTimestampMillis(row.created_at, "Email attachment created_at must be a valid timestamp."),
  };
}

export class PostgresEmailStore implements EmailStore {
  private readonly pool: PgPoolLike;
  private readonly tables: EmailTableNames;

  constructor(options: PostgresEmailStoreOptions) {
    this.pool = options.pool;
    this.tables = buildEmailTableNames();
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresEmailSchema(this.pool);
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
    client: PgClientLike,
    input: RecordEmailMessageInput,
  ): Promise<RecordEmailMessageResult> {
    const agentKey = requireTrimmed("agent key", input.agentKey);
    const accountKey = normalizeEmailAccountKey(input.accountKey);
    const normalizedMessage = normalizeEmailMessageInput(input);
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
      normalizedMessage.threadKey,
      trimToUndefined(input.subject) ?? null,
      trimToUndefined(input.fromName) ?? null,
      normalizedMessage.fromAddress ?? null,
      normalizedMessage.replyToAddress ?? null,
      input.sentAt === undefined ? null : new Date(input.sentAt),
      input.receivedAt === undefined ? null : new Date(input.receivedAt),
      normalizedMessage.bodyText ?? null,
      normalizedMessage.bodyExcerpt ?? null,
      trimToUndefined(input.authenticationResults) ?? null,
      input.authSpf ?? null,
      input.authDkim ?? null,
      input.authDmarc ?? null,
      normalizedMessage.authSummary,
      normalizedMessage.attachments.length > 0,
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
    await this.insertRecipients(client, message.id, normalizedMessage.recipients);
    await this.insertAttachments(client, message.id, normalizedMessage.attachments);
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
    client: PgClientLike,
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
    client: PgClientLike,
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
