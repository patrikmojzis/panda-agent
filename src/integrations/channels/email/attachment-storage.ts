import {rm} from "node:fs/promises";

import type {Attachment} from "mailparser";

import type {WriteMediaInput} from "../../../domain/channels/media-store.js";
import {
  EMAIL_SOURCE,
  MAX_EMAIL_ATTACHMENT_BYTES,
  MAX_EMAIL_ATTACHMENTS,
  MAX_EMAIL_TOTAL_ATTACHMENT_BYTES,
} from "../../../domain/email/shared.js";
import type {
  EmailAttachmentInput,
  EmailAttachmentStorageReason,
} from "../../../domain/email/types.js";
import {trimToUndefined} from "../../../lib/strings.js";

export interface EmailAttachmentMediaWriter {
  writeMedia(input: WriteMediaInput): Promise<{localPath: string}>;
}

export interface PrepareInboundEmailAttachmentsOptions {
  accountKey: string;
  mediaWriter: EmailAttachmentMediaWriter;
  persistBytes: boolean;
}

export interface PreparedInboundEmailAttachments {
  attachments: readonly EmailAttachmentInput[];
  writtenPaths: readonly string[];
}

function attachmentMetadata(attachment: Attachment): Omit<EmailAttachmentInput, "storageStatus" | "storageReason"> {
  return {
    filename: trimToUndefined(attachment.filename),
    mimeType: trimToUndefined(attachment.contentType),
    sizeBytes: attachment.content.byteLength,
    contentId: trimToUndefined(attachment.contentId),
  };
}

function metadataOnly(
  attachment: Attachment,
  storageReason: EmailAttachmentStorageReason,
): EmailAttachmentInput {
  return {
    ...attachmentMetadata(attachment),
    storageStatus: "metadata_only",
    storageReason,
  };
}

async function rethrowAfterCleanup(error: unknown, writtenPaths: readonly string[]): Promise<never> {
  try {
    await removeInboundEmailAttachmentFiles(writtenPaths);
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "Email attachment storage failed and cleanup did not complete.",
    );
  }

  throw error;
}

/** Removes files written for an email that was not durably recorded. */
export async function removeInboundEmailAttachmentFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((localPath) => rm(localPath, {force: true})));
}

/** Applies inbound email attachment policy and stores eligible decoded bytes. */
export async function prepareInboundEmailAttachments(
  parsedAttachments: readonly Attachment[],
  options: PrepareInboundEmailAttachmentsOptions,
): Promise<PreparedInboundEmailAttachments> {
  const attachments: EmailAttachmentInput[] = [];
  const writtenPaths: string[] = [];
  let eligibleCount = 0;
  let totalStoredBytes = 0;

  for (const attachment of parsedAttachments) {
    if (!options.persistBytes) {
      attachments.push(metadataOnly(attachment, "backfill"));
      continue;
    }

    if (attachment.related === true || attachment.contentDisposition?.toLowerCase() === "inline") {
      attachments.push(metadataOnly(attachment, "inline"));
      continue;
    }

    eligibleCount += 1;
    if (eligibleCount > MAX_EMAIL_ATTACHMENTS) {
      attachments.push(metadataOnly(attachment, "too_many_attachments"));
      continue;
    }

    const sizeBytes = attachment.content.byteLength;
    if (sizeBytes > MAX_EMAIL_ATTACHMENT_BYTES) {
      attachments.push(metadataOnly(attachment, "attachment_too_large"));
      continue;
    }
    if (totalStoredBytes + sizeBytes > MAX_EMAIL_TOTAL_ATTACHMENT_BYTES) {
      attachments.push(metadataOnly(attachment, "total_size_limit"));
      continue;
    }

    try {
      const stored = await options.mediaWriter.writeMedia({
        bytes: attachment.content,
        source: EMAIL_SOURCE,
        connectorKey: options.accountKey,
        mimeType: trimToUndefined(attachment.contentType) ?? "application/octet-stream",
        sizeBytes,
        hintFilename: trimToUndefined(attachment.filename),
      });
      writtenPaths.push(stored.localPath);
      totalStoredBytes += sizeBytes;
      attachments.push({
        ...attachmentMetadata(attachment),
        localPath: stored.localPath,
        storageStatus: "stored",
      });
    } catch (error) {
      await rethrowAfterCleanup(error, writtenPaths);
    }
  }

  return {attachments, writtenPaths};
}
