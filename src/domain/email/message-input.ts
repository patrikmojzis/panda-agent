import {randomUUID} from "node:crypto";

import {collapseWhitespace, trimToUndefined} from "../../lib/strings.js";
import {summarizeEmailAuthentication} from "./auth.js";
import {
    markExternalEmailContent,
    normalizeEmailAddress,
    normalizeOptionalEmailAddress,
} from "./shared.js";
import type {
    EmailAttachmentInput,
    EmailAttachmentStorageStatus,
    EmailAuthSummary,
    EmailRecipientInput,
    RecordEmailMessageInput,
} from "./types.js";

export interface NormalizedEmailMessageInput {
  recipients: readonly EmailRecipientInput[];
  attachments: readonly NormalizedEmailAttachmentInput[];
  bodyText?: string;
  bodyExcerpt?: string;
  authSummary: EmailAuthSummary;
  fromAddress?: string;
  replyToAddress?: string;
  threadKey: string;
}

export type NormalizedEmailAttachmentInput = Omit<EmailAttachmentInput, "storageStatus"> & {
  storageStatus: EmailAttachmentStorageStatus;
};

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

function normalizeAttachments(attachments: readonly EmailAttachmentInput[] | undefined): readonly NormalizedEmailAttachmentInput[] {
  return (attachments ?? []).map((attachment) => {
    const localPath = trimToUndefined(attachment.localPath);
    const storageStatus = attachment.storageStatus ?? (localPath ? "stored" : "metadata_only");
    if (storageStatus === "stored" && !localPath) {
      throw new Error("Stored email attachments require a local path.");
    }
    if (storageStatus === "metadata_only" && localPath) {
      throw new Error("Metadata-only email attachments must not include a local path.");
    }

    return {
      filename: trimToUndefined(attachment.filename),
      mimeType: trimToUndefined(attachment.mimeType),
      sizeBytes: attachment.sizeBytes === undefined ? undefined : Math.max(0, Math.floor(attachment.sizeBytes)),
      localPath,
      contentId: trimToUndefined(attachment.contentId),
      storageStatus,
      storageReason: storageStatus === "stored" ? undefined : attachment.storageReason ?? "legacy",
    };
  });
}

/** Normalizes email message input before persistence, including inbound trust markers. */
export function normalizeEmailMessageInput(input: RecordEmailMessageInput): NormalizedEmailMessageInput {
  const bodyText = normalizeBodyText(input);
  return {
    recipients: normalizeRecipients(input.recipients),
    attachments: normalizeAttachments(input.attachments),
    bodyText,
    bodyExcerpt: normalizeBodyExcerpt(bodyText),
    authSummary: normalizeAuthSummary(input),
    fromAddress: normalizeOptionalEmailAddress(input.fromAddress),
    replyToAddress: normalizeOptionalEmailAddress(input.replyToAddress),
    threadKey: normalizeThreadKey(input),
  };
}
