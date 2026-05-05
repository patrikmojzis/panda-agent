export interface EmailEndpointConfig {
  host: string;
  port?: number;
  secure?: boolean;
  usernameCredentialEnvKey: string;
  passwordCredentialEnvKey: string;
}

export interface EmailMailboxSyncState {
  uidValidity?: string;
  lastUid?: number;
  initialized?: boolean;
}

export interface EmailAccountSyncState {
  mailboxes?: Record<string, EmailMailboxSyncState>;
}

export interface EmailAccountRecord {
  agentKey: string;
  accountKey: string;
  fromAddress: string;
  fromName?: string;
  imap: EmailEndpointConfig;
  smtp: EmailEndpointConfig;
  mailboxes: readonly string[];
  syncState: EmailAccountSyncState;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertEmailAccountInput {
  agentKey: string;
  accountKey: string;
  fromAddress: string;
  fromName?: string;
  imap: EmailEndpointConfig;
  smtp: EmailEndpointConfig;
  mailboxes?: readonly string[];
  enabled?: boolean;
}

export interface EmailAllowedRecipientRecord {
  agentKey: string;
  accountKey: string;
  address: string;
  createdAt: number;
}

export type EmailMessageDirection = "inbound" | "outbound";
export type EmailRecipientRole = "from" | "reply_to" | "to" | "cc";
export type EmailAuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "unknown";
export type EmailAuthSummary = "trusted" | "suspicious" | "unknown";

export interface EmailRecipientInput {
  role: EmailRecipientRole;
  address: string;
  name?: string;
}

export interface EmailAttachmentInput {
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  localPath?: string;
  contentId?: string;
}

export interface EmailMessageRecord {
  id: string;
  agentKey: string;
  accountKey: string;
  direction: EmailMessageDirection;
  mailbox?: string;
  uid?: number;
  uidValidity?: string;
  messageIdHeader?: string;
  inReplyTo?: string;
  referencesHeader?: string;
  threadKey: string;
  subject?: string;
  fromName?: string;
  fromAddress?: string;
  replyToAddress?: string;
  sentAt?: number;
  receivedAt?: number;
  bodyText?: string;
  bodyExcerpt?: string;
  authenticationResults?: string;
  authSpf?: EmailAuthVerdict;
  authDkim?: EmailAuthVerdict;
  authDmarc?: EmailAuthVerdict;
  authSummary: EmailAuthSummary;
  hasAttachments: boolean;
  sourceDeliveryId?: string;
  createdAt: number;
}

export interface RecordEmailMessageInput {
  agentKey: string;
  accountKey: string;
  direction: EmailMessageDirection;
  mailbox?: string;
  uid?: number;
  uidValidity?: string;
  messageIdHeader?: string;
  inReplyTo?: string;
  referencesHeader?: string;
  threadKey?: string;
  subject?: string;
  fromName?: string;
  fromAddress?: string;
  replyToAddress?: string;
  sentAt?: number;
  receivedAt?: number;
  bodyText?: string;
  authenticationResults?: string;
  authSpf?: EmailAuthVerdict;
  authDkim?: EmailAuthVerdict;
  authDmarc?: EmailAuthVerdict;
  authSummary?: EmailAuthSummary;
  sourceDeliveryId?: string;
  recipients?: readonly EmailRecipientInput[];
  attachments?: readonly EmailAttachmentInput[];
}

export interface RecordEmailMessageResult {
  message: EmailMessageRecord;
  inserted: boolean;
}

export interface EmailMessageRecipientRecord {
  id: string;
  messageId: string;
  role: EmailRecipientRole;
  address: string;
  name?: string;
  createdAt: number;
}

export interface EmailAttachmentRecord {
  id: string;
  messageId: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  localPath?: string;
  contentId?: string;
  createdAt: number;
}

export interface EmailStore {
  ensureSchema(): Promise<void>;
  upsertAccount(input: UpsertEmailAccountInput): Promise<EmailAccountRecord>;
  disableAccount(agentKey: string, accountKey: string): Promise<EmailAccountRecord>;
  getAccount(agentKey: string, accountKey: string): Promise<EmailAccountRecord>;
  listEnabledAccounts(): Promise<readonly EmailAccountRecord[]>;
  updateAccountSyncState(agentKey: string, accountKey: string, syncState: EmailAccountSyncState): Promise<EmailAccountRecord>;
  addAllowedRecipient(agentKey: string, accountKey: string, address: string): Promise<EmailAllowedRecipientRecord>;
  removeAllowedRecipient(agentKey: string, accountKey: string, address: string): Promise<boolean>;
  listAllowedRecipients(agentKey: string, accountKey: string): Promise<readonly EmailAllowedRecipientRecord[]>;
  assertRecipientsAllowed(agentKey: string, accountKey: string, addresses: readonly string[]): Promise<void>;
  recordMessage(input: RecordEmailMessageInput): Promise<RecordEmailMessageResult>;
  getMessage(messageId: string): Promise<EmailMessageRecord>;
  listMessageRecipients(messageId: string): Promise<readonly EmailMessageRecipientRecord[]>;
}
