import {access, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {Attachment} from "mailparser";
import {afterEach, describe, expect, it, vi} from "vitest";

import {FileSystemMediaStore} from "../src/domain/channels/media-store.js";
import {
  MAX_EMAIL_ATTACHMENT_BYTES,
  MAX_EMAIL_TOTAL_ATTACHMENT_BYTES,
} from "../src/domain/email/shared.js";
import {
  prepareInboundEmailAttachments,
  type EmailAttachmentMediaWriter,
} from "../src/integrations/channels/email/attachment-storage.js";

function parsedAttachment(input: {
  content: Buffer;
  filename: string;
  contentType?: string;
  contentDisposition?: string;
  related?: boolean;
}): Attachment {
  return {
    content: input.content,
    filename: input.filename,
    contentType: input.contentType ?? "application/octet-stream",
    contentDisposition: input.contentDisposition ?? "attachment",
    related: input.related ?? false,
  } as Attachment;
}

describe("inbound email attachment storage", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    for (const directory of directories) {
      await rm(directory, {recursive: true, force: true});
    }
    directories.clear();
  });

  it("stores decoded bytes under the email account media directory and sanitizes filenames", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "panda-email-media-"));
    directories.add(rootDir);
    const bytes = Buffer.from("invoice contents");

    const result = await prepareInboundEmailAttachments([
      parsedAttachment({
        content: bytes,
        filename: "../../invoice.pdf",
        contentType: "application/pdf",
      }),
    ], {
      accountKey: "work",
      mediaWriter: new FileSystemMediaStore({rootDir}),
      persistBytes: true,
    });

    expect(result.attachments).toEqual([
      expect.objectContaining({
        filename: "../../invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
        storageStatus: "stored",
      }),
    ]);
    const localPath = result.attachments[0]?.localPath;
    expect(localPath).toBeDefined();
    expect(path.relative(rootDir, localPath!)).toMatch(/^email[/\\]work[/\\]/);
    expect(path.basename(localPath!)).not.toContain("..");
    await expect(readFile(localPath!)).resolves.toEqual(bytes);
  });

  it("keeps backfill and inline parts as metadata only", async () => {
    const writeMedia = vi.fn<EmailAttachmentMediaWriter["writeMedia"]>();
    const backfill = await prepareInboundEmailAttachments([
      parsedAttachment({content: Buffer.from("old"), filename: "old.txt"}),
    ], {
      accountKey: "work",
      mediaWriter: {writeMedia},
      persistBytes: false,
    });
    const inline = await prepareInboundEmailAttachments([
      parsedAttachment({
        content: Buffer.from("logo"),
        filename: "logo.png",
        contentType: "image/png",
        contentDisposition: "inline",
      }),
      parsedAttachment({
        content: Buffer.from("related"),
        filename: "related.png",
        contentType: "image/png",
        related: true,
      }),
    ], {
      accountKey: "work",
      mediaWriter: {writeMedia},
      persistBytes: true,
    });

    expect(backfill.attachments).toEqual([
      expect.objectContaining({storageStatus: "metadata_only", storageReason: "backfill"}),
    ]);
    expect(inline.attachments).toEqual([
      expect.objectContaining({storageStatus: "metadata_only", storageReason: "inline"}),
      expect.objectContaining({storageStatus: "metadata_only", storageReason: "inline"}),
    ]);
    expect(writeMedia).not.toHaveBeenCalled();
  });

  it("enforces count and per-file limits without blocking later valid files", async () => {
    let nextPath = 0;
    const writeMedia = vi.fn(async () => ({localPath: `/tmp/email-${nextPath += 1}`}));
    const countLimited = await prepareInboundEmailAttachments(
      Array.from({length: 11}, (_, index) => parsedAttachment({
        content: Buffer.from(String(index)),
        filename: `${index}.txt`,
        contentType: "text/plain",
      })),
      {
        accountKey: "work",
        mediaWriter: {writeMedia},
        persistBytes: true,
      },
    );
    const sizeLimited = await prepareInboundEmailAttachments([
      parsedAttachment({
        content: Buffer.allocUnsafe(MAX_EMAIL_ATTACHMENT_BYTES + 1),
        filename: "huge.bin",
      }),
      parsedAttachment({content: Buffer.from("valid"), filename: "valid.txt", contentType: "text/plain"}),
    ], {
      accountKey: "work",
      mediaWriter: {writeMedia},
      persistBytes: true,
    });

    expect(countLimited.attachments.at(-1)).toMatchObject({
      storageStatus: "metadata_only",
      storageReason: "too_many_attachments",
    });
    expect(countLimited.attachments.filter((attachment) => attachment.storageStatus === "stored")).toHaveLength(10);
    expect(sizeLimited.attachments).toEqual([
      expect.objectContaining({storageStatus: "metadata_only", storageReason: "attachment_too_large"}),
      expect.objectContaining({storageStatus: "stored", filename: "valid.txt"}),
    ]);
  });

  it("enforces the total byte limit while allowing a later file that still fits", async () => {
    let nextPath = 0;
    const writeMedia = vi.fn(async () => ({localPath: `/tmp/total-${nextPath += 1}`}));
    const megabyte = 1024 * 1024;
    const result = await prepareInboundEmailAttachments([
      parsedAttachment({content: Buffer.allocUnsafe(20 * megabyte), filename: "a.bin"}),
      parsedAttachment({content: Buffer.allocUnsafe(20 * megabyte), filename: "b.bin"}),
      parsedAttachment({content: Buffer.allocUnsafe(9 * megabyte), filename: "c.bin"}),
      parsedAttachment({content: Buffer.allocUnsafe(2 * megabyte), filename: "over.bin"}),
      parsedAttachment({content: Buffer.allocUnsafe(1 * megabyte), filename: "fits.bin"}),
    ], {
      accountKey: "work",
      mediaWriter: {writeMedia},
      persistBytes: true,
    });

    expect(result.attachments[3]).toMatchObject({
      storageStatus: "metadata_only",
      storageReason: "total_size_limit",
    });
    expect(result.attachments[4]).toMatchObject({storageStatus: "stored", filename: "fits.bin"});
    expect(result.attachments
      .filter((attachment) => attachment.storageStatus === "stored")
      .reduce((total, attachment) => total + (attachment.sizeBytes ?? 0), 0))
      .toBe(MAX_EMAIL_TOTAL_ATTACHMENT_BYTES);
  });

  it("removes files already written when a later media write fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "panda-email-cleanup-"));
    directories.add(rootDir);
    const firstPath = path.join(rootDir, "first.txt");
    let calls = 0;
    const mediaWriter: EmailAttachmentMediaWriter = {
      writeMedia: async (input) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("disk full");
        }
        await writeFile(firstPath, input.bytes);
        return {localPath: firstPath};
      },
    };

    await expect(prepareInboundEmailAttachments([
      parsedAttachment({content: Buffer.from("first"), filename: "first.txt"}),
      parsedAttachment({content: Buffer.from("second"), filename: "second.txt"}),
    ], {
      accountKey: "work",
      mediaWriter,
      persistBytes: true,
    })).rejects.toThrow("disk full");
    await expect(access(firstPath)).rejects.toThrow();
  });
});
