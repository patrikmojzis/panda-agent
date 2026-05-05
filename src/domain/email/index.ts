export {
  DEFAULT_EMAIL_BACKFILL_LIMIT,
  DEFAULT_EMAIL_MAILBOXES,
  EMAIL_CONNECTOR_KEY,
  EMAIL_SOURCE,
  normalizeEmailAccountKey,
  normalizeEmailAddress,
  EMAIL_EXTERNAL_CONTENT_MARKER,
  markExternalEmailContent,
} from "./shared.js";
export {
  parseEmailAuthenticationResults,
  summarizeEmailAuthentication,
  type ParsedEmailAuthentication,
} from "./auth.js";
export {
  PostgresEmailStore,
  type PostgresEmailStoreOptions,
} from "./postgres.js";
export type {
  EmailAccountRecord,
  EmailAccountSyncState,
  EmailAllowedRecipientRecord,
  EmailAuthSummary,
  EmailAuthVerdict,
  EmailAttachmentInput,
  EmailAttachmentRecord,
  EmailEndpointConfig,
  EmailMailboxSyncState,
  EmailMessageDirection,
  EmailMessageRecord,
  EmailMessageRecipientRecord,
  EmailRecipientInput,
  EmailRecipientRole,
  EmailStore,
  RecordEmailMessageInput,
  RecordEmailMessageResult,
  UpsertEmailAccountInput,
} from "./types.js";
