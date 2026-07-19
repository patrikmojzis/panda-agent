import {copyFile, mkdir, stat} from "node:fs/promises";
import path from "node:path";

import type {JsonObject} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {assertPathReadable} from "../../lib/fs.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {OutboundDeliveryInput} from "../channels/deliveries/types.js";
import type {OutboundFileItem, OutboundItem} from "../channels/types.js";
import {commandScopeDenied} from "../commands/errors.js";
import type {CommandFileResolver, CommandWritableFileResolver} from "../commands/files.js";
import type {
  CommandArtifactDescriptor,
  CommandDescriptor,
  CommandRequest,
  CommandSuccess,
  RegisteredCommand,
} from "../commands/types.js";
import {EMAIL_CONNECTOR_KEY, EMAIL_SOURCE, normalizeEmailAddress} from "./shared.js";
import {emailSendPayloadToJsonObject, type EmailSendPayload, type EmailSendRecipientPayload} from "./send-payload.js";
import type {
  EmailAccountRecord,
  EmailAttachmentRecord,
  EmailMessageDirection,
  EmailMessageRecipientRecord,
  EmailMessageRecord,
  EmailRouteRecord,
  EmailStore,
} from "./types.js";

export const EMAIL_ACCOUNT_LIST_COMMAND_NAME = "email.account.list";
export const EMAIL_LIST_COMMAND_NAME = "email.list";
export const EMAIL_READ_COMMAND_NAME = "email.read";
export const EMAIL_SEARCH_COMMAND_NAME = "email.search";
export const EMAIL_SEND_COMMAND_NAME = "email.send";
export const EMAIL_ATTACHMENTS_FETCH_COMMAND_NAME = "email.attachments.fetch";

const MAX_EMAIL_ATTACHMENTS = 10;
const MAX_EMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_EMAIL_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_EMAIL_MESSAGE_LIMIT = 50;
const MAX_RECIPIENTS = 20;

export type EmailReadCommandStore = Pick<
  EmailStore,
  | "assertMessageOwnedBySession"
  | "getMessageAttachment"
  | "getMessage"
  | "listMessageAttachments"
  | "listMessageRecipients"
  | "listMessagesForSession"
  | "searchMessagesForSession"
>;

export type EmailAccountListCommandStore = Pick<
  EmailStore,
  | "assertAccountSendableBySession"
  | "listEnabledAccounts"
  | "listRoutes"
>;

export type EmailSendCommandStore = Pick<
  EmailStore,
  "assertAccountSendableBySession" | "assertMessageOwnedBySession" | "getAccount" | "getMessage" | "listMessageRecipients" | "assertRecipientsAllowed"
>;

export interface EmailSendCommandQueue {
  enqueueDelivery(input: OutboundDeliveryInput): Promise<{
    id: string;
  }>;
}

export interface EmailSendCommandServices {
  store: EmailSendCommandStore;
  queue: EmailSendCommandQueue;
}

export interface EmailReadCommandServices {
  store: EmailReadCommandStore;
}

export interface EmailAccountListCommandServices {
  store: EmailAccountListCommandStore;
}

export interface EmailAccountListCommandInput {
  sendableOnly?: boolean;
}

export interface EmailListCommandInput {
  accountKey?: string;
  mailbox?: string;
  direction?: EmailMessageDirection;
  limit?: number;
}

export interface EmailReadCommandInput {
  emailId: string;
}

export interface EmailSearchCommandInput extends EmailListCommandInput {
  query: string;
}

export interface EmailAttachmentFetchCommandInput {
  attachmentId: string;
  save?: string;
  overwrite?: boolean;
}

interface EmailSendRecipientInput {
  address: string;
  name?: string;
}

interface EmailSendAttachmentInput {
  path: string;
  filename?: string;
  mimeType?: string;
}

export interface EmailSendCommandInput {
  accountKey: string;
  to?: readonly EmailSendRecipientInput[];
  cc?: readonly EmailSendRecipientInput[];
  subject?: string;
  replyToEmailId?: string;
  replyMode?: "sender" | "all";
  text: string;
  html?: string;
  attachments?: readonly EmailSendAttachmentInput[];
}

interface ResolvedEmailDraft {
  to: EmailSendRecipientPayload[];
  cc: EmailSendRecipientPayload[];
  subject: string;
  replyToEmailId?: string;
  inReplyTo?: string;
  references?: string;
  threadKey: string;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return readRequiredString(value, label);
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return Math.min(value, MAX_EMAIL_MESSAGE_LIMIT);
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }

  return value;
}

function rejectUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported field ${unexpected[0]}.`);
  }
}

function parseEmailAccountListCommandInput(input: unknown): EmailAccountListCommandInput {
  if (!isRecord(input)) {
    throw new Error("email.account.list input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["sendableOnly"], "email.account.list input");

  const sendableOnly = readOptionalBoolean(input.sendableOnly, "email.account.list sendableOnly");
  return {
    ...(sendableOnly === undefined ? {} : {sendableOnly}),
  };
}

function parseRecipient(value: unknown, label: string): EmailSendRecipientInput {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  rejectUnexpectedKeys(value, ["address", "name"], label);

  const name = readOptionalString(value.name, `${label}.name`);
  return {
    address: readRequiredString(value.address, `${label}.address`),
    ...(name ? {name} : {}),
  };
}

function parseRecipients(value: unknown, label: string, options: {required?: boolean} = {}): EmailSendRecipientInput[] | undefined {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new Error(`${label} is required.`);
    }
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECIPIENTS) {
    throw new Error(`${label} must contain 1-${MAX_RECIPIENTS} recipients.`);
  }

  return value.map((entry, index) => parseRecipient(entry, `${label}[${index}]`));
}

function parseOptionalRecipients(value: unknown, label: string): EmailSendRecipientInput[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_RECIPIENTS) {
    throw new Error(`${label} must contain at most ${MAX_RECIPIENTS} recipients.`);
  }

  return value.map((entry, index) => parseRecipient(entry, `${label}[${index}]`));
}

function parseAttachment(value: unknown, label: string): EmailSendAttachmentInput {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  rejectUnexpectedKeys(value, ["path", "filename", "mimeType"], label);

  const filename = readOptionalString(value.filename, `${label}.filename`);
  const mimeType = readOptionalString(value.mimeType, `${label}.mimeType`);
  return {
    path: readRequiredString(value.path, `${label}.path`),
    ...(filename ? {filename} : {}),
    ...(mimeType ? {mimeType} : {}),
  };
}

function parseAttachments(value: unknown): EmailSendAttachmentInput[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_EMAIL_ATTACHMENTS) {
    throw new Error(`email.send attachments must contain at most ${MAX_EMAIL_ATTACHMENTS} files.`);
  }

  return value.map((entry, index) => parseAttachment(entry, `email.send attachments[${index}]`));
}

function parseEmailDirection(value: unknown, label: string): EmailMessageDirection | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== "inbound" && value !== "outbound") {
    throw new Error(`${label} must be inbound or outbound.`);
  }

  return value;
}

function parseEmailListCommandInput(input: unknown): EmailListCommandInput {
  if (!isRecord(input)) {
    throw new Error("email.list input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["accountKey", "mailbox", "direction", "limit"], "email.list input");

  const accountKey = readOptionalString(input.accountKey, "email.list accountKey");
  const mailbox = readOptionalString(input.mailbox, "email.list mailbox");
  const direction = parseEmailDirection(input.direction, "email.list direction");
  const limit = readOptionalPositiveInteger(input.limit, "email.list limit");
  return {
    ...(accountKey ? {accountKey} : {}),
    ...(mailbox ? {mailbox} : {}),
    ...(direction ? {direction} : {}),
    ...(limit !== undefined ? {limit} : {}),
  };
}

function parseEmailReadCommandInput(input: unknown): EmailReadCommandInput {
  if (!isRecord(input)) {
    throw new Error("email.read input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["emailId"], "email.read input");

  return {
    emailId: readRequiredString(input.emailId, "email.read emailId"),
  };
}

function parseEmailSearchCommandInput(input: unknown): EmailSearchCommandInput {
  if (!isRecord(input)) {
    throw new Error("email.search input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["query", "accountKey", "mailbox", "direction", "limit"], "email.search input");
  const listInput = parseEmailListCommandInput({
    accountKey: input.accountKey,
    mailbox: input.mailbox,
    direction: input.direction,
    limit: input.limit,
  });

  return {
    ...listInput,
    query: readRequiredString(input.query, "email.search query"),
  };
}

function parseEmailAttachmentFetchCommandInput(input: unknown): EmailAttachmentFetchCommandInput {
  if (!isRecord(input)) {
    throw new Error("email.attachments.fetch input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, ["attachmentId", "save", "overwrite"], "email.attachments.fetch input");

  const save = readOptionalString(input.save, "email.attachments.fetch save");
  const overwrite = input.overwrite;
  if (overwrite !== undefined && typeof overwrite !== "boolean") {
    throw new Error("email.attachments.fetch overwrite must be a boolean.");
  }

  return {
    attachmentId: readRequiredString(input.attachmentId, "email.attachments.fetch attachmentId"),
    ...(save ? {save} : {}),
    ...(overwrite !== undefined ? {overwrite} : {}),
  };
}

function parseEmailSendCommandInput(input: unknown): EmailSendCommandInput {
  if (!isRecord(input)) {
    throw new Error("email.send input must be a JSON object.");
  }
  rejectUnexpectedKeys(input, [
    "accountKey",
    "to",
    "cc",
    "subject",
    "replyToEmailId",
    "replyMode",
    "text",
    "html",
    "attachments",
  ], "email.send input");

  const replyToEmailId = readOptionalString(input.replyToEmailId, "email.send replyToEmailId");
  const replyMode = input.replyMode;
  if (replyMode !== undefined && replyMode !== "sender" && replyMode !== "all") {
    throw new Error("email.send replyMode must be sender or all.");
  }

  const subject = readOptionalString(input.subject, "email.send subject");
  if (subject && subject.length > 200) {
    throw new Error("email.send subject must be at most 200 characters.");
  }

  if (replyToEmailId) {
    if (input.to !== undefined) {
      throw new Error("email.send to is not allowed when replyToEmailId is provided.");
    }
    if (input.cc !== undefined) {
      throw new Error("email.send cc is not allowed when replyToEmailId is provided.");
    }
    if (subject) {
      throw new Error("email.send subject is derived when replyToEmailId is provided.");
    }
  } else if (replyMode !== undefined) {
    throw new Error("email.send replyMode requires replyToEmailId.");
  }

  const to = replyToEmailId ? undefined : parseRecipients(input.to, "email.send to", {required: true});
  const cc = replyToEmailId ? undefined : parseOptionalRecipients(input.cc, "email.send cc") ?? [];
  const html = readOptionalString(input.html, "email.send html");
  const attachments = parseAttachments(input.attachments);
  if (!replyToEmailId && !subject) {
    throw new Error("email.send subject is required for a fresh email.");
  }

  return {
    accountKey: readRequiredString(input.accountKey, "email.send accountKey"),
    ...(to ? {to} : {}),
    ...(replyToEmailId ? {} : {cc}),
    ...(subject ? {subject} : {}),
    ...(replyToEmailId ? {replyToEmailId} : {}),
    ...(replyMode ? {replyMode} : {}),
    text: readRequiredString(input.text, "email.send text"),
    ...(html ? {html} : {}),
    ...(attachments ? {attachments} : {}),
  };
}

function timestampIso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function serializeSender(message: EmailMessageRecord): JsonObject | undefined {
  if (!message.fromAddress && !message.fromName) {
    return undefined;
  }

  return {
    ...(message.fromAddress ? {address: message.fromAddress} : {}),
    ...(message.fromName ? {name: message.fromName} : {}),
  };
}

function currentSessionRouteSummaries(
  routes: readonly EmailRouteRecord[],
  sessionId: string,
): JsonObject[] {
  return routes
    .filter((route) => route.sessionId === sessionId)
    .map((route) => ({
      scope: route.mailbox ? "mailbox" : "account",
      ...(route.mailbox ? {mailbox: route.mailbox} : {}),
    }));
}

function sendBlockedReason(routes: readonly EmailRouteRecord[], sessionId: string): string {
  const accountRoute = routes.find((route) => !route.mailbox);
  if (accountRoute && accountRoute.sessionId !== sessionId) {
    return "account_routed_elsewhere";
  }

  return "not_routed_to_current_session";
}

function serializeEmailAccountSummary(input: {
  account: EmailAccountRecord;
  routes: readonly EmailRouteRecord[];
  sendable: boolean;
  sessionId: string;
}): JsonObject {
  const currentSessionRoutes = currentSessionRouteSummaries(input.routes, input.sessionId);
  return {
    accountKey: input.account.accountKey,
    fromAddress: input.account.fromAddress,
    ...(input.account.fromName ? {fromName: input.account.fromName} : {}),
    mailboxes: [...input.account.mailboxes],
    sendable: input.sendable,
    ...(input.sendable ? {} : {sendBlockedReason: sendBlockedReason(input.routes, input.sessionId)}),
    ...(currentSessionRoutes.length > 0 ? {currentSessionRoutes} : {}),
    updatedAt: input.account.updatedAt,
  };
}

function serializeEmailMessageSummary(message: EmailMessageRecord): JsonObject {
  const receivedAt = timestampIso(message.receivedAt);
  const sentAt = timestampIso(message.sentAt);
  const from = serializeSender(message);
  return {
    id: message.id,
    accountKey: message.accountKey,
    direction: message.direction,
    ...(message.mailbox ? {mailbox: message.mailbox} : {}),
    ...(message.subject ? {subject: message.subject} : {}),
    ...(from ? {from} : {}),
    ...(receivedAt ? {receivedAt} : {}),
    ...(sentAt ? {sentAt} : {}),
    ...(message.bodyExcerpt ? {bodyExcerpt: message.bodyExcerpt} : {}),
    authSummary: message.authSummary,
    hasAttachments: message.hasAttachments,
    threadKey: message.threadKey,
  };
}

function serializeRecipient(recipient: EmailMessageRecipientRecord): JsonObject {
  return {
    role: recipient.role,
    address: recipient.address,
    ...(recipient.name ? {name: recipient.name} : {}),
  };
}

function serializeAttachment(attachment: EmailAttachmentRecord): JsonObject {
  return {
    id: attachment.id,
    ...(attachment.filename ? {filename: attachment.filename} : {}),
    ...(attachment.mimeType ? {mimeType: attachment.mimeType} : {}),
    ...(attachment.sizeBytes !== undefined ? {sizeBytes: attachment.sizeBytes} : {}),
    ...(attachment.contentId ? {contentId: attachment.contentId} : {}),
  };
}

function serializeEmailMessageFull(
  message: EmailMessageRecord,
  recipients: readonly EmailMessageRecipientRecord[],
  attachments: readonly EmailAttachmentRecord[],
): JsonObject {
  return {
    ...serializeEmailMessageSummary(message),
    ...(message.messageIdHeader ? {messageIdHeader: message.messageIdHeader} : {}),
    ...(message.inReplyTo ? {inReplyTo: message.inReplyTo} : {}),
    ...(message.referencesHeader ? {referencesHeader: message.referencesHeader} : {}),
    ...(message.replyToAddress ? {replyToAddress: message.replyToAddress} : {}),
    ...(message.bodyText ? {bodyText: message.bodyText} : {}),
    ...(message.authenticationResults ? {authenticationResults: message.authenticationResults} : {}),
    ...(message.authSpf ? {authSpf: message.authSpf} : {}),
    ...(message.authDkim ? {authDkim: message.authDkim} : {}),
    ...(message.authDmarc ? {authDmarc: message.authDmarc} : {}),
    recipients: recipients.map(serializeRecipient),
    attachments: attachments.map(serializeAttachment),
  };
}

function safeAttachmentFilename(attachment: EmailAttachmentRecord): string {
  const filename = trimToUndefined(attachment.filename);
  const base = filename ? path.basename(filename) : attachment.id;
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || attachment.id;
}

function defaultAttachmentSavePath(attachment: EmailAttachmentRecord): string {
  return path.join("email-attachments", `${attachment.id}-${safeAttachmentFilename(attachment)}`);
}

function inferAttachmentMimeType(attachment: EmailAttachmentRecord): string | undefined {
  const normalized = trimToUndefined(attachment.mimeType)?.toLowerCase();
  if (normalized) {
    return normalized;
  }

  const extension = path.extname(attachment.filename ?? attachment.localPath ?? "").toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}

function toAttachmentArtifact(
  attachment: EmailAttachmentRecord,
  savedPath: string,
): CommandArtifactDescriptor | undefined {
  const mimeType = inferAttachmentMimeType(attachment);
  if (!mimeType) {
    return undefined;
  }
  if (mimeType === "application/pdf") {
    return {
      kind: "pdf",
      source: "view_media",
      path: savedPath,
      mimeType,
      ...(attachment.sizeBytes !== undefined ? {bytes: attachment.sizeBytes} : {}),
      originalPath: attachment.filename ?? attachment.id,
    };
  }
  if (mimeType.startsWith("image/")) {
    return {
      kind: "image",
      source: "view_media",
      path: savedPath,
      mimeType,
      ...(attachment.sizeBytes !== undefined ? {bytes: attachment.sizeBytes} : {}),
      originalPath: attachment.filename ?? attachment.id,
    };
  }

  return undefined;
}

function normalizeRecipients(
  recipients: readonly EmailSendRecipientInput[] | undefined,
): EmailSendRecipientPayload[] {
  const seen = new Set<string>();
  const normalized: EmailSendRecipientPayload[] = [];
  for (const recipient of recipients ?? []) {
    const address = normalizeEmailAddress(recipient.address);
    if (seen.has(address)) {
      continue;
    }

    seen.add(address);
    normalized.push({
      address,
      ...(trimToUndefined(recipient.name) ? {name: trimToUndefined(recipient.name)} : {}),
    });
  }

  return normalized;
}

function stripOwnAndDedupe(
  recipients: readonly EmailSendRecipientPayload[],
  ownAddress: string,
): EmailSendRecipientPayload[] {
  const own = normalizeEmailAddress(ownAddress);
  const seen = new Set<string>();
  const deduped: EmailSendRecipientPayload[] = [];
  for (const recipient of recipients) {
    const address = normalizeEmailAddress(recipient.address);
    if (address === own || seen.has(address)) {
      continue;
    }

    seen.add(address);
    deduped.push({
      address,
      ...(trimToUndefined(recipient.name) ? {name: trimToUndefined(recipient.name)} : {}),
    });
  }

  return deduped;
}

function replySubject(message: EmailMessageRecord): string {
  const subject = trimToUndefined(message.subject) ?? "(no subject)";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function replyReferences(message: EmailMessageRecord): string | undefined {
  const parts = [
    ...(trimToUndefined(message.referencesHeader)?.split(/\s+/) ?? []),
    trimToUndefined(message.messageIdHeader),
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? Array.from(new Set(parts)).join(" ") : undefined;
}

function recipientPayloadFromMessage(message: EmailMessageRecord): EmailSendRecipientPayload {
  const address = message.replyToAddress ?? message.fromAddress;
  if (!address) {
    throw new Error(`Email message ${message.id} has no sender or reply-to address.`);
  }

  return {
    address: normalizeEmailAddress(address),
    ...(message.fromName ? {name: message.fromName} : {}),
  };
}

function toPayloadRecipient(recipient: EmailMessageRecipientRecord): EmailSendRecipientPayload {
  return {
    address: recipient.address,
    ...(recipient.name ? {name: recipient.name} : {}),
  };
}

async function resolveDraft(
  input: EmailSendCommandInput,
  request: CommandRequest,
  store: EmailSendCommandStore,
  fromAddress: string,
): Promise<ResolvedEmailDraft> {
  if (!input.replyToEmailId) {
    return {
      to: stripOwnAndDedupe(normalizeRecipients(input.to), fromAddress),
      cc: stripOwnAndDedupe(normalizeRecipients(input.cc), fromAddress),
      subject: input.subject!,
      threadKey: input.subject!,
    };
  }

  const message = await store.getMessage(input.replyToEmailId);
  await store.assertMessageOwnedBySession({
    messageId: message.id,
    sessionId: request.scope.sessionId,
  });
  if (message.agentKey !== request.scope.agentKey || message.accountKey !== input.accountKey) {
    throw commandScopeDenied(
      "The email message is not available for this reply account.",
      "resource_scope_denied",
      "Use a message and account returned by the current session email commands.",
    );
  }

  const sender = recipientPayloadFromMessage(message);
  let cc: EmailSendRecipientPayload[] = [];
  if ((input.replyMode ?? "sender") === "all") {
    const originalRecipients = await store.listMessageRecipients(message.id);
    cc = originalRecipients
      .filter((recipient) => recipient.role === "to" || recipient.role === "cc")
      .map(toPayloadRecipient);
  }

  return {
    to: stripOwnAndDedupe([sender], fromAddress),
    cc: stripOwnAndDedupe(cc, fromAddress),
    subject: replySubject(message),
    replyToEmailId: message.id,
    inReplyTo: message.messageIdHeader,
    references: replyReferences(message),
    threadKey: message.threadKey,
  };
}

async function resolveAttachmentItems(
  attachments: readonly EmailSendAttachmentInput[] | undefined,
  request: CommandRequest,
  fileResolver: CommandFileResolver,
): Promise<{
  items: OutboundFileItem[];
  payload: EmailSendPayload["attachments"];
}> {
  const items: OutboundFileItem[] = [];
  const payload: EmailSendPayload["attachments"] = [];
  let totalBytes = 0;

  for (const attachment of attachments ?? []) {
    const resolved = await fileResolver.resolveReadablePath({
      request,
      file: {
        path: attachment.path,
      },
    });
    await assertPathReadable(resolved.path, () => new Error(`No readable file found at ${resolved.displayPath}`));
    const stats = await stat(resolved.path);
    if (!stats.isFile()) {
      throw new Error(`Email attachment ${resolved.displayPath} is not a file.`);
    }
    if (stats.size > MAX_EMAIL_ATTACHMENT_BYTES) {
      throw new Error(`Email attachment ${resolved.displayPath} exceeds the 20 MB per-file limit.`);
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_EMAIL_TOTAL_ATTACHMENT_BYTES) {
      throw new Error("Email attachments exceed the 50 MB total limit.");
    }

    const item: OutboundFileItem = {
      type: "file",
      path: resolved.path,
      ...(attachment.filename ? {filename: attachment.filename} : {}),
      ...(attachment.mimeType ? {mimeType: attachment.mimeType} : {}),
    };
    items.push(item);
    payload.push({
      path: resolved.path,
      ...(attachment.filename ? {filename: attachment.filename} : {}),
      ...(attachment.mimeType ? {mimeType: attachment.mimeType} : {}),
    });
  }

  return {items, payload};
}

export function serializeEmailQueuedDelivery(input: {
  deliveryId: string;
  accountKey: string;
  fromAddress: string;
}): JsonObject {
  return {
    ok: true,
    status: "queued",
    deliveryId: input.deliveryId,
    channel: EMAIL_SOURCE,
    accountKey: input.accountKey,
    from: input.fromAddress,
  };
}

export async function executeEmailAccountListCommand(
  input: EmailAccountListCommandInput,
  request: CommandRequest,
  services: EmailAccountListCommandServices,
): Promise<JsonObject> {
  const [accounts, routes] = await Promise.all([
    services.store.listEnabledAccounts(),
    services.store.listRoutes(request.scope.agentKey),
  ]);
  const routesByAccount = new Map<string, EmailRouteRecord[]>();
  for (const route of routes) {
    const list = routesByAccount.get(route.accountKey) ?? [];
    list.push(route);
    routesByAccount.set(route.accountKey, list);
  }

  const summaries = await Promise.all(accounts
    .filter((account) => account.agentKey === request.scope.agentKey)
    .map(async (account) => {
      let sendable = false;
      try {
        await services.store.assertAccountSendableBySession({
          agentKey: request.scope.agentKey,
          accountKey: account.accountKey,
          sessionId: request.scope.sessionId,
        });
        sendable = true;
      } catch {
        sendable = false;
      }

      return serializeEmailAccountSummary({
        account,
        routes: routesByAccount.get(account.accountKey) ?? [],
        sendable,
        sessionId: request.scope.sessionId,
      });
    }));
  const visible = input.sendableOnly
    ? summaries.filter((account) => account.sendable === true)
    : summaries;

  return {
    ok: true,
    count: visible.length,
    accounts: visible,
  };
}

export async function executeEmailListCommand(
  input: EmailListCommandInput,
  request: CommandRequest,
  services: EmailReadCommandServices,
): Promise<JsonObject> {
  const messages = await services.store.listMessagesForSession({
    agentKey: request.scope.agentKey,
    sessionId: request.scope.sessionId,
    ...(input.accountKey ? {accountKey: input.accountKey} : {}),
    ...(input.mailbox ? {mailbox: input.mailbox} : {}),
    ...(input.direction ? {direction: input.direction} : {}),
    ...(input.limit !== undefined ? {limit: input.limit} : {}),
  });

  return {
    ok: true,
    count: messages.length,
    messages: messages.map(serializeEmailMessageSummary),
  };
}

export async function executeEmailReadCommand(
  input: EmailReadCommandInput,
  request: CommandRequest,
  services: EmailReadCommandServices,
): Promise<JsonObject> {
  const message = await services.store.getMessage(input.emailId);
  await services.store.assertMessageOwnedBySession({
    messageId: message.id,
    sessionId: request.scope.sessionId,
  });
  if (message.agentKey !== request.scope.agentKey) {
    throw commandScopeDenied(
      "The email message is not visible to the current agent.",
      "resource_scope_denied",
      "Use a message returned by the current agent email commands.",
    );
  }

  const [recipients, attachments] = await Promise.all([
    services.store.listMessageRecipients(message.id),
    services.store.listMessageAttachments(message.id),
  ]);

  return {
    ok: true,
    message: serializeEmailMessageFull(message, recipients, attachments),
  };
}

export async function executeEmailAttachmentFetchCommand(
  input: EmailAttachmentFetchCommandInput,
  request: CommandRequest,
  services: EmailReadCommandServices,
  fileResolver: CommandWritableFileResolver,
): Promise<{output: JsonObject; artifact?: CommandArtifactDescriptor}> {
  const attachment = await services.store.getMessageAttachment(input.attachmentId);
  const message = await services.store.getMessage(attachment.messageId);
  await services.store.assertMessageOwnedBySession({
    messageId: message.id,
    sessionId: request.scope.sessionId,
  });
  if (message.agentKey !== request.scope.agentKey) {
    throw commandScopeDenied(
      "The email attachment is not visible to the current agent.",
      "resource_scope_denied",
      "Use an attachment returned by the current agent email commands.",
    );
  }
  if (!attachment.localPath) {
    throw new Error(`Email attachment ${attachment.id} has no stored local file path.`);
  }

  const sourceStat = await stat(attachment.localPath);
  if (!sourceStat.isFile()) {
    throw new Error(`Email attachment ${attachment.id} is not stored as a readable file.`);
  }
  const savePath = input.save ?? defaultAttachmentSavePath(attachment);
  const resolved = await fileResolver.resolveWritablePath({
    request,
    file: {
      path: savePath,
    },
  });
  if (!input.overwrite) {
    try {
      await stat(resolved.path);
      throw new Error(`Refusing to overwrite existing file at ${resolved.displayPath}; pass --overwrite to replace it.`);
    } catch (error) {
      if (
        error instanceof Error
        && error.message === `Refusing to overwrite existing file at ${resolved.displayPath}; pass --overwrite to replace it.`
      ) {
        throw error;
      }
    }
  }

  await mkdir(path.dirname(resolved.path), {recursive: true});
  await copyFile(attachment.localPath, resolved.path);
  const bytes = sourceStat.size;
  const mimeType = inferAttachmentMimeType(attachment);
  const artifact = toAttachmentArtifact({...attachment, sizeBytes: attachment.sizeBytes ?? bytes}, resolved.path);
  return {
    output: {
      ok: true,
      attachment: {
        ...serializeAttachment(attachment),
        messageId: attachment.messageId,
      },
      message: serializeEmailMessageSummary(message),
      saved: {
        path: resolved.path,
        displayPath: resolved.displayPath,
        bytes,
        ...(mimeType ? {mimeType} : {}),
      },
    },
    ...(artifact ? {artifact} : {}),
  };
}

export async function executeEmailSearchCommand(
  input: EmailSearchCommandInput,
  request: CommandRequest,
  services: EmailReadCommandServices,
): Promise<JsonObject> {
  const messages = await services.store.searchMessagesForSession({
    agentKey: request.scope.agentKey,
    sessionId: request.scope.sessionId,
    query: input.query,
    ...(input.accountKey ? {accountKey: input.accountKey} : {}),
    ...(input.mailbox ? {mailbox: input.mailbox} : {}),
    ...(input.direction ? {direction: input.direction} : {}),
    ...(input.limit !== undefined ? {limit: input.limit} : {}),
  });

  return {
    ok: true,
    query: input.query,
    count: messages.length,
    messages: messages.map(serializeEmailMessageSummary),
  };
}

export async function executeEmailSendCommand(
  input: EmailSendCommandInput,
  request: CommandRequest,
  services: EmailSendCommandServices,
  fileResolver: CommandFileResolver,
): Promise<JsonObject> {
  if (!request.scope.threadId) {
    throw commandScopeDenied(
      "Email send requires agentKey, sessionId, and threadId in the current runtime context.",
      "command_scope_denied",
      "Run the command from an active Panda thread context.",
    );
  }

  const account = await services.store.getAccount(request.scope.agentKey, input.accountKey);
  if (!account.enabled) {
    throw new Error(`Email account ${input.accountKey} is disabled.`);
  }

  if (!input.replyToEmailId) {
    await services.store.assertAccountSendableBySession({
      agentKey: request.scope.agentKey,
      accountKey: account.accountKey,
      sessionId: request.scope.sessionId,
    });
  }

  const draft = await resolveDraft(input, request, services.store, account.fromAddress);
  const recipientAddresses = [...draft.to, ...draft.cc].map((recipient) => recipient.address);
  if (recipientAddresses.length === 0) {
    throw new Error("Email has no recipients after removing the sender account address.");
  }
  await services.store.assertRecipientsAllowed(request.scope.agentKey, account.accountKey, recipientAddresses);

  const attachments = await resolveAttachmentItems(input.attachments, request, fileResolver);
  const payload: EmailSendPayload = {
    kind: "email_send",
    agentKey: request.scope.agentKey,
    accountKey: account.accountKey,
    sessionId: request.scope.sessionId,
    fromAddress: account.fromAddress,
    ...(account.fromName ? {fromName: account.fromName} : {}),
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    text: input.text,
    ...(input.html ? {html: input.html} : {}),
    attachments: attachments.payload,
    ...(draft.replyToEmailId ? {replyToEmailId: draft.replyToEmailId} : {}),
    ...(draft.inReplyTo ? {inReplyTo: draft.inReplyTo} : {}),
    ...(draft.references ? {references: draft.references} : {}),
    threadKey: draft.threadKey,
  };
  const items: OutboundItem[] = [
    {type: "text", text: input.text},
    ...attachments.items,
  ];
  const delivery = await services.queue.enqueueDelivery({
    threadId: request.scope.threadId,
    channel: EMAIL_SOURCE,
    target: {
      source: EMAIL_SOURCE,
      connectorKey: EMAIL_CONNECTOR_KEY,
      externalConversationId: account.accountKey,
    },
    items,
    metadata: {
      email: emailSendPayloadToJsonObject(payload),
    },
  });

  return serializeEmailQueuedDelivery({
    deliveryId: delivery.id,
    accountKey: account.accountKey,
    fromAddress: account.fromAddress,
  });
}

export const emailAccountListCommandDescriptor: CommandDescriptor = {
  name: EMAIL_ACCOUNT_LIST_COMMAND_NAME,
  summary: "List configured email accounts visible to this agent.",
  description: "Lists enabled email accounts for the current agent without exposing IMAP/SMTP hosts or credential keys. Use --sendable-only to show only accounts this session can send from.",
  usage: "panda email account list [--sendable-only]",
  inputModes: ["flags", "json"],
  outputModes: ["json"],
  arguments: [
    {
      name: "sendable-only",
      description: "Only include accounts the current session can send from.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "JSON object containing optional sendableOnly.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List email accounts for this agent",
      command: "panda email account list",
    },
    {
      description: "List only sendable accounts",
      command: "panda email account list --sendable-only",
    },
  ],
  requiredCapabilities: [EMAIL_ACCOUNT_LIST_COMMAND_NAME],
  resultShape: {
    ok: true,
    count: "number",
    accounts: [{
      accountKey: "string",
      fromAddress: "string",
      mailboxes: ["string"],
      sendable: "boolean",
    }],
  },
};

export const emailListCommandDescriptor: CommandDescriptor = {
  name: EMAIL_LIST_COMMAND_NAME,
  summary: "List recent session-visible email messages.",
  description: "Lists recent emails visible to the current Panda session, with optional account, mailbox, direction, and limit filters.",
  usage: "panda email list [--account <key>] [--mailbox <name>] [--direction inbound|outbound] [--limit <n>]",
  inputModes: ["flags", "json"],
  outputModes: ["json"],
  arguments: [
    {
      name: "account",
      description: "Optional email account key filter.",
      valueType: "string",
      valueName: "key",
    },
    {
      name: "mailbox",
      description: "Optional mailbox filter, for example INBOX.",
      valueType: "string",
      valueName: "name",
    },
    {
      name: "direction",
      description: "Optional message direction filter.",
      valueType: "string",
      valueName: "inbound|outbound",
      enumValues: ["inbound", "outbound"],
    },
    {
      name: "limit",
      description: "Maximum messages to return. Capped at 50.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "json",
      description: "JSON object containing optional accountKey, mailbox, direction, and limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List recent mail",
      command: "panda email list --limit 10",
    },
    {
      description: "List inbound INBOX messages for one account",
      command: "panda email list --account work --mailbox INBOX --direction inbound",
    },
  ],
  requiredCapabilities: ["email.read"],
  resultShape: {
    ok: true,
    count: "number",
    messages: [],
  },
};

export const emailReadCommandDescriptor: CommandDescriptor = {
  name: EMAIL_READ_COMMAND_NAME,
  summary: "Read one session-visible email message.",
  description: "Returns the full body, recipients, authentication summary, and attachment metadata for one session-visible email.",
  usage: "panda email read <email-id>",
  inputModes: ["flags", "json"],
  outputModes: ["json"],
  arguments: [
    {
      name: "email-id",
      description: "Email message id returned by email.list or email.search.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "email-id",
    },
    {
      name: "json",
      description: "JSON object containing emailId.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Read an email",
      command: "panda email read msg_123",
    },
  ],
  requiredCapabilities: ["email.read"],
  resultShape: {
    ok: true,
    message: "Email message object",
  },
};

export const emailSearchCommandDescriptor: CommandDescriptor = {
  name: EMAIL_SEARCH_COMMAND_NAME,
  summary: "Search session-visible email messages.",
  description: "Searches subject, sender, body excerpt, and body text across emails visible to the current Panda session.",
  usage: "panda email search <query> [--account <key>] [--mailbox <name>] [--direction inbound|outbound] [--limit <n>]",
  inputModes: ["flags", "json"],
  outputModes: ["json"],
  arguments: [
    {
      name: "query",
      description: "Search text.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "query",
    },
    {
      name: "account",
      description: "Optional email account key filter.",
      valueType: "string",
      valueName: "key",
    },
    {
      name: "mailbox",
      description: "Optional mailbox filter, for example INBOX.",
      valueType: "string",
      valueName: "name",
    },
    {
      name: "direction",
      description: "Optional message direction filter.",
      valueType: "string",
      valueName: "inbound|outbound",
      enumValues: ["inbound", "outbound"],
    },
    {
      name: "limit",
      description: "Maximum messages to return. Capped at 50.",
      valueType: "number",
      valueName: "n",
    },
    {
      name: "json",
      description: "JSON object containing query and optional accountKey, mailbox, direction, and limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Search recent mail",
      command: "panda email search invoice --limit 10",
    },
    {
      description: "Search one mailbox",
      command: "panda email search 'launch plan' --account work --mailbox INBOX",
    },
  ],
  requiredCapabilities: ["email.read"],
  resultShape: {
    ok: true,
    query: "string",
    count: "number",
    messages: [],
  },
};

export const emailAttachmentsFetchCommandDescriptor: CommandDescriptor = {
  name: EMAIL_ATTACHMENTS_FETCH_COMMAND_NAME,
  summary: "Fetch one session-visible email attachment into the workspace.",
  description: "Copies a stored email attachment into the current command filesystem after verifying the parent message is visible to the current session.",
  usage: "panda email attachments fetch <attachment-id> [--save <path>] [--overwrite]",
  inputModes: ["flags", "json"],
  outputModes: ["json"],
  arguments: [
    {
      name: "attachment-id",
      description: "Attachment id returned by email.read.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "attachment-id",
    },
    {
      name: "save",
      description: "Optional destination path. Defaults to email-attachments/<attachment-id>-<filename>.",
      valueType: "string",
      valueName: "path",
    },
    {
      name: "overwrite",
      description: "Replace the destination file if it already exists.",
      valueType: "boolean",
    },
    {
      name: "json",
      description: "JSON object containing attachmentId, optional save, and optional overwrite.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Fetch an attachment to the default path",
      command: "panda email attachments fetch att_123",
    },
    {
      description: "Fetch an attachment to a named workspace file",
      command: "panda email attachments fetch att_123 --save ./invoice.pdf",
    },
  ],
  requiredCapabilities: ["email.attachments.fetch"],
  resultShape: {
    ok: true,
    attachment: "Email attachment object",
    message: "Email message summary",
    saved: {
      path: "string",
      displayPath: "string",
      bytes: "number",
      mimeType: "string|optional",
    },
  },
};

export const emailSendCommandDescriptor: CommandDescriptor = {
  name: EMAIL_SEND_COMMAND_NAME,
  summary: "Send or reply to an email.",
  description: "Queues a fresh email or reply from a configured Panda email account through runtime policy and recipient allowlists.",
  usage: "panda email send --account <key> (--to <address>... --subject <text|@file|@->|--reply-to-email-id <email-id> [--reply-mode sender|all]) --text <text|@file|@-> [--html <text|@file|@->] [--cc <address>...] [--file <path>...]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "account",
      description: "Email account key to send from.",
      required: true,
      valueType: "string",
      valueName: "key",
    },
    {
      name: "to",
      description: "Recipient email address. Repeat for multiple recipients. Use 'Name <address@example.com>' for display names.",
      valueType: "string",
      valueName: "address",
      repeatable: true,
      conflictsWith: ["reply-to-email-id"],
    },
    {
      name: "cc",
      description: "CC recipient email address. Repeat for multiple recipients.",
      valueType: "string",
      valueName: "address",
      repeatable: true,
      conflictsWith: ["reply-to-email-id"],
    },
    {
      name: "subject",
      description: "Subject for a fresh email.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
      conflictsWith: ["reply-to-email-id"],
    },
    {
      name: "text",
      description: "Plain text email body. Use @file or @- for multiline bodies.",
      required: true,
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "html",
      description: "Optional HTML body. Use @file or @- for multiline HTML.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "reply-to-email-id",
      description: "Reply to a session-owned email message instead of sending a fresh email.",
      valueType: "string",
      valueName: "email-id",
      conflictsWith: ["to", "cc", "subject"],
    },
    {
      name: "reply-mode",
      description: "Reply recipient mode when replying.",
      valueType: "string",
      valueName: "sender|all",
      enumValues: ["sender", "all"],
      requires: ["reply-to-email-id"],
    },
    {
      name: "file",
      description: "Repeatable attachment path.",
      valueType: "string",
      valueName: "path",
      repeatable: true,
    },
    {
      name: "json",
      description: "JSON object containing accountKey, text, either fresh-email recipients/subject or replyToEmailId, and optional attachments.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Send a fresh email",
      command: "panda email send --account work --to alice@example.com --subject Update --text 'Done.'",
    },
    {
      description: "Send with an attachment",
      command: "panda email send --account work --to alice@example.com --subject Report --text @body.txt --file ./report.pdf",
    },
    {
      description: "Reply to an email thread",
      command: "panda email send --account work --reply-to-email-id msg_123 --reply-mode all --text @-",
    },
    {
      description: "Use JSON input",
      command: "panda email send --json '{\"accountKey\":\"work\",\"to\":[{\"address\":\"alice@example.com\"}],\"subject\":\"Update\",\"text\":\"Done.\"}'",
    },
  ],
  requiredCapabilities: ["email.send"],
  resultShape: {
    ok: true,
    status: "queued",
    deliveryId: "string",
    channel: EMAIL_SOURCE,
    accountKey: "string",
    from: "string",
  },
};

export function createEmailSendCommand(
  services: EmailSendCommandServices,
  fileResolver: CommandFileResolver,
): RegisteredCommand {
  return {
    descriptor: emailSendCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeEmailSendCommand(
        parseEmailSendCommandInput(request.input),
        request,
        services,
        fileResolver,
      );
      if (!isJsonObject(output)) {
        throw new Error("email.send result must be a JSON object.");
      }

      return {
        ok: true,
        command: EMAIL_SEND_COMMAND_NAME,
        output,
        summary: `Queued email delivery ${String(output.deliveryId)}.`,
      };
    },
  };
}

export function createEmailAccountListCommand(services: EmailAccountListCommandServices): RegisteredCommand {
  return {
    descriptor: emailAccountListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeEmailAccountListCommand(
        parseEmailAccountListCommandInput(request.input),
        request,
        services,
      );
      if (!isJsonObject(output)) {
        throw new Error("email.account.list result must be a JSON object.");
      }

      return {
        ok: true,
        command: EMAIL_ACCOUNT_LIST_COMMAND_NAME,
        output,
        summary: `Returned ${String(output.count)} email account${output.count === 1 ? "" : "s"}.`,
      };
    },
  };
}

export function createEmailListCommand(services: EmailReadCommandServices): RegisteredCommand {
  return {
    descriptor: emailListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeEmailListCommand(
        parseEmailListCommandInput(request.input),
        request,
        services,
      );
      if (!isJsonObject(output)) {
        throw new Error("email.list result must be a JSON object.");
      }

      return {
        ok: true,
        command: EMAIL_LIST_COMMAND_NAME,
        output,
        summary: `Returned ${String(output.count)} email messages.`,
      };
    },
  };
}

export function createEmailReadCommand(services: EmailReadCommandServices): RegisteredCommand {
  return {
    descriptor: emailReadCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeEmailReadCommand(
        parseEmailReadCommandInput(request.input),
        request,
        services,
      );
      if (!isJsonObject(output)) {
        throw new Error("email.read result must be a JSON object.");
      }

      return {
        ok: true,
        command: EMAIL_READ_COMMAND_NAME,
        output,
        summary: `Read email message ${String(output.message && typeof output.message === "object" && !Array.isArray(output.message) ? output.message.id : "unknown")}.`,
      };
    },
  };
}

export function createEmailAttachmentsFetchCommand(
  services: EmailReadCommandServices,
  fileResolver: CommandWritableFileResolver,
): RegisteredCommand {
  return {
    descriptor: emailAttachmentsFetchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const result = await executeEmailAttachmentFetchCommand(
        parseEmailAttachmentFetchCommandInput(request.input),
        request,
        services,
        fileResolver,
      );
      if (!isJsonObject(result.output)) {
        throw new Error("email.attachments.fetch result must be a JSON object.");
      }

      return {
        ok: true,
        command: EMAIL_ATTACHMENTS_FETCH_COMMAND_NAME,
        output: result.output,
        ...(result.artifact ? {artifact: result.artifact} : {}),
        summary: `Fetched email attachment ${String(result.output.attachment && typeof result.output.attachment === "object" && !Array.isArray(result.output.attachment) ? result.output.attachment.id : "unknown")}.`,
      };
    },
  };
}

export function createEmailSearchCommand(services: EmailReadCommandServices): RegisteredCommand {
  return {
    descriptor: emailSearchCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const output = await executeEmailSearchCommand(
        parseEmailSearchCommandInput(request.input),
        request,
        services,
      );
      if (!isJsonObject(output)) {
        throw new Error("email.search result must be a JSON object.");
      }

      return {
        ok: true,
        command: EMAIL_SEARCH_COMMAND_NAME,
        output,
        summary: `Found ${String(output.count)} email messages.`,
      };
    },
  };
}
