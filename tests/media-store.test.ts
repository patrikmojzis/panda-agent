import * as fs from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {
  discardStagedMediaDescriptor,
  FileSystemMediaStore,
  moveMediaFile,
  relocateMediaDescriptor,
} from "../src/domain/channels/media-store.js";

describe("FileSystemMediaStore", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of directories) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    directories.clear();
  });

  it("writes bytes to a stable source/connector partition", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-a`);
    directories.add(rootDir);

    const store = new FileSystemMediaStore({
      rootDir,
      now: () => new Date("2026-04-08T12:00:00.000Z"),
    });

    const descriptor = await store.writeMedia({
      bytes: Buffer.from("hello world", "utf8"),
      source: "telegram",
      connectorKey: "bot-main",
      mimeType: "text/plain",
      hintFilename: "greeting.txt",
      metadata: {
        fileId: "abc123",
      },
    });

    expect(descriptor).toMatchObject({
      source: "telegram",
      connectorKey: "bot-main",
      mimeType: "text/plain",
      sizeBytes: 11,
      originalFilename: "greeting.txt",
      metadata: {
        fileId: "abc123",
      },
    });
    expect(descriptor.localPath).toMatch(/media-store-[^/]+\/telegram\/bot-main\/2026-04\/.+\.txt$/);
    await expect(fs.readFile(descriptor.localPath, "utf8")).resolves.toBe("hello world");
  });

  it("sanitizes storage path segments and falls back to a binary extension", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-b`);
    directories.add(rootDir);

    const store = new FileSystemMediaStore({
      rootDir,
      now: () => new Date("2026-04-08T12:00:00.000Z"),
    });

    const descriptor = await store.writeMedia({
      bytes: new Uint8Array([1, 2, 3]),
      source: " telegram/bot ",
      connectorKey: " session:main/1 ",
      mimeType: "application/x-weird",
      hintFilename: "../voice note",
    });

    expect(descriptor.localPath).toMatch(/telegram_bot\/session_main_1\/2026-04\/.+\.bin$/);
    expect(descriptor.originalFilename).toBe("voice note");
    await expect(fs.readFile(descriptor.localPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("keeps media paths under the configured root for dot segments", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-d`);
    directories.add(rootDir);

    const store = new FileSystemMediaStore({
      rootDir,
      now: () => new Date("2026-04-08T12:00:00.000Z"),
    });

    const descriptor = await store.writeMedia({
      bytes: new Uint8Array([9]),
      source: "..",
      connectorKey: ".",
      mimeType: "application/octet-stream",
    });

    expect(descriptor.localPath.startsWith(`${rootDir}${path.sep}`)).toBe(true);
    expect(descriptor.localPath).toMatch(/unknown\/unknown\/2026-04\/.+\.bin$/);
  });

  it("infers Telegram rich media extensions from MIME types", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-rich-media`);
    directories.add(rootDir);

    const store = new FileSystemMediaStore({
      rootDir,
      now: () => new Date("2026-04-08T12:00:00.000Z"),
    });

    const webm = await store.writeMedia({
      bytes: new Uint8Array([1]),
      source: "telegram",
      connectorKey: "bot-main",
      mimeType: "video/webm",
    });
    const tgs = await store.writeMedia({
      bytes: new Uint8Array([2]),
      source: "telegram",
      connectorKey: "bot-main",
      mimeType: "application/x-tgsticker",
    });

    expect(webm.localPath).toMatch(/telegram\/bot-main\/2026-04\/.+\.webm$/);
    expect(tgs.localPath).toMatch(/telegram\/bot-main\/2026-04\/.+\.tgs$/);
  });

  it("validates required fields", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-c`);
    directories.add(rootDir);

    const store = new FileSystemMediaStore({ rootDir });

    await expect(store.writeMedia({
      bytes: new Uint8Array(),
      source: "   ",
      connectorKey: "bot-main",
      mimeType: "text/plain",
    })).rejects.toThrow("Media source must not be empty.");
    await expect(store.writeMedia({
      bytes: new Uint8Array(),
      source: "telegram",
      connectorKey: "bot-main",
      mimeType: "   ",
    })).rejects.toThrow("Media mime type must not be empty.");
  });

  it("rejects size metadata that does not match the payload bytes", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-e`);
    directories.add(rootDir);

    const store = new FileSystemMediaStore({ rootDir });

    await expect(store.writeMedia({
      bytes: new Uint8Array([1, 2, 3]),
      sizeBytes: 999,
      source: "telegram",
      connectorKey: "bot-main",
      mimeType: "application/octet-stream",
    })).rejects.toThrow("Media sizeBytes 999 does not match payload byte length 3.");
  });

  it("maps an external media part to one stable descriptor across redelivery", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-idempotent`);
    directories.add(rootDir);
    const store = new FileSystemMediaStore({rootDir});
    const input = {
      bytes: Buffer.from("stable payload"),
      source: "telegram",
      connectorKey: "main",
      mimeType: "text/plain",
      hintFilename: "note.txt",
      idempotencyKey: "chat-1:message-9:document:file-1",
      createdAt: Date.parse("2026-08-25T01:02:03.000Z"),
    };

    const [first, concurrent, replay] = await Promise.all([
      store.writeMedia(input),
      store.writeMedia(input),
      store.writeMedia(input),
    ]);

    expect(concurrent).toEqual(first);
    expect(replay).toEqual(first);
    expect(first.createdAt).toBe(input.createdAt);
    expect(first.localPath).toContain(`${path.sep}.idempotent${path.sep}`);
    await expect(fs.readFile(first.localPath, "utf8")).resolves.toBe("stable payload");
  });

  it("replays the first canonical descriptor when transport metadata changes", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-descriptor-replay`);
    directories.add(rootDir);
    const store = new FileSystemMediaStore({rootDir});
    const common = {
      bytes: Buffer.from("same bytes"),
      source: "telegram",
      connectorKey: "main",
      idempotencyKey: "chat-1:message-9:document:file-1",
    };
    const first = await store.writeMedia({
      ...common,
      mimeType: "text/plain",
      hintFilename: "first.txt",
      metadata: {filePath: "documents/first.txt"},
      createdAt: 1_777_000_000_000,
    });
    const replay = await store.writeMedia({
      ...common,
      mimeType: "application/octet-stream",
      hintFilename: "changed.bin",
      metadata: {filePath: "documents/refreshed.bin"},
      createdAt: 1_777_000_001_000,
    });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      mimeType: "text/plain",
      originalFilename: "first.txt",
      metadata: {filePath: "documents/first.txt"},
      createdAt: 1_777_000_000_000,
    });
    await expect(fs.readdir(path.dirname(first.localPath))).resolves.toHaveLength(2);
  });

  it("keeps request payload paths immutable while replaying relocated bytes", async () => {
    const sourceRootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-canonical-source`);
    const targetRootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-canonical-target`);
    directories.add(sourceRootDir);
    directories.add(targetRootDir);
    const store = new FileSystemMediaStore({rootDir: sourceRootDir});
    const input = {
      bytes: Buffer.from("replay after relocation"),
      source: "telegram",
      connectorKey: "main",
      mimeType: "text/plain",
      hintFilename: "message.txt",
      idempotencyKey: "chat-1:message-10:document:file-1",
      createdAt: 1_777_000_000_000,
    };

    const canonical = await store.writeMedia(input);
    const relocated = await relocateMediaDescriptor(canonical, {rootDir: targetRootDir});
    const replayedCanonical = await store.writeMedia(input);
    const replayedRelocation = await relocateMediaDescriptor(replayedCanonical, {rootDir: targetRootDir});

    expect(replayedCanonical).toEqual(canonical);
    expect(replayedRelocation).toEqual(relocated);
    await expect(fs.access(canonical.localPath)).rejects.toMatchObject({code: "ENOENT"});
    await expect(fs.readFile(relocated.localPath, "utf8")).resolves.toBe("replay after relocation");
    await expect(fs.readdir(path.dirname(canonical.localPath))).resolves.toEqual(["descriptor.json"]);
  });

  it("reconciles stale request-owned staging receipts in one bounded owner batch", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-owner-janitor`);
    directories.add(rootDir);
    let nowMs = 1_000;
    const resolveReceiptOwners = vi.fn(async (owners: readonly {requestIdempotencyKey: string}[]) => (
      owners.map((owner) => owner.requestIdempotencyKey === "request-active" ? "active" as const : "missing" as const)
    ));
    const store = new FileSystemMediaStore({
      rootDir,
      now: () => new Date(nowMs),
      orphanRetentionMs: 1_000,
      receiptRetentionMs: 1_000,
      resolveReceiptOwners,
    });
    const writeOwned = (key: string, requestIdempotencyKey: string) => store.writeMedia({
      bytes: Buffer.from(requestIdempotencyKey),
      source: "discord",
      connectorKey: "main",
      mimeType: "text/plain",
      idempotencyKey: key,
      createdAt: 1_000,
      receiptOwner: {requestKind: "discord_message", requestIdempotencyKey},
    });
    const orphan = await writeOwned("orphan-part", "request-missing");
    const active = await writeOwned("active-part", "request-active");
    nowMs = 2_001;
    for (const descriptor of [orphan, active]) {
      await fs.utimes(
        path.join(path.dirname(descriptor.localPath), "descriptor.json"),
        new Date(1_000),
        new Date(1_000),
      );
    }

    await expect(store.reconcileOrphanedReceipts()).resolves.toBe(1);
    expect(resolveReceiptOwners).toHaveBeenCalledOnce();
    expect(resolveReceiptOwners.mock.calls[0]?.[0]).toHaveLength(2);
    await expect(fs.access(orphan.localPath)).rejects.toMatchObject({code: "ENOENT"});
    await expect(fs.readFile(active.localPath, "utf8")).resolves.toBe("request-active");
  });

  it("keeps missing-owner staging that redelivery refreshed during resolution", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-owner-race`);
    directories.add(rootDir);
    let nowMs = 1_000;
    let releaseResolver!: () => void;
    let markResolverStarted!: () => void;
    const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve; });
    const resolverBlocked = new Promise<void>((resolve) => { releaseResolver = resolve; });
    const resolveReceiptOwners = vi.fn(async () => {
      markResolverStarted();
      await resolverBlocked;
      return ["missing" as const];
    });
    const store = new FileSystemMediaStore({
      rootDir,
      now: () => new Date(nowMs),
      orphanRetentionMs: 1,
      receiptRetentionMs: 1_000,
      resolveReceiptOwners,
    });
    const input = {
      bytes: Buffer.from("redelivered staging"),
      source: "discord",
      connectorKey: "main",
      mimeType: "text/plain",
      idempotencyKey: "redelivery-race-part",
      createdAt: 1_000,
      receiptOwner: {requestKind: "discord_message", requestIdempotencyKey: "request-race"},
    };
    const staged = await store.writeMedia(input);
    await fs.utimes(
      path.join(path.dirname(staged.localPath), "descriptor.json"),
      new Date(1_000),
      new Date(1_000),
    );

    nowMs = 2_001;
    const sweep = store.reconcileOrphanedReceipts();
    await resolverStarted;
    await store.writeMedia(input);
    releaseResolver();

    await expect(sweep).resolves.toBe(0);
    await expect(fs.readFile(staged.localPath, "utf8")).resolves.toBe("redelivered staging");
  });

  it("releases pre-owner staging receipts only after the hard-cut retention window", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-ownerless-janitor`);
    directories.add(rootDir);
    let nowMs = 1_000;
    const resolveReceiptOwners = vi.fn(async () => []);
    const store = new FileSystemMediaStore({
      rootDir,
      now: () => new Date(nowMs),
      orphanRetentionMs: 1,
      ownerlessRetentionMs: 1_000,
      receiptRetentionMs: 1_000,
      resolveReceiptOwners,
    });
    const legacy = await store.writeMedia({
      bytes: Buffer.from("pre-owner staging"),
      source: "telegram",
      connectorKey: "main",
      mimeType: "text/plain",
      idempotencyKey: "legacy-part",
      createdAt: 1_000,
    });
    await fs.utimes(
      path.join(path.dirname(legacy.localPath), "descriptor.json"),
      new Date(1_000),
      new Date(1_000),
    );

    nowMs = 1_999;
    await expect(store.reconcileOrphanedReceipts()).resolves.toBe(0);
    await expect(fs.readFile(legacy.localPath, "utf8")).resolves.toBe("pre-owner staging");

    nowMs = 2_001;
    await expect(store.reconcileOrphanedReceipts()).resolves.toBe(1);
    expect(resolveReceiptOwners).toHaveBeenCalledOnce();
    await expect(fs.access(legacy.localPath)).rejects.toMatchObject({code: "ENOENT"});
  });

  it("discards only terminal transport staging and lets redelivery publish it again", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-discard-staging`);
    directories.add(rootDir);
    const store = new FileSystemMediaStore({rootDir});
    const input = {
      bytes: Buffer.from("unconsumed attachment"),
      source: "discord",
      connectorKey: "main",
      mimeType: "text/plain",
      idempotencyKey: "channel-1:message-1:attachment-1",
      createdAt: 1_777_000_000_000,
    };

    const staged = await store.writeMedia(input);
    await expect(discardStagedMediaDescriptor(staged)).resolves.toBe(true);
    await expect(fs.access(staged.localPath)).rejects.toMatchObject({code: "ENOENT"});
    await expect(discardStagedMediaDescriptor(staged)).resolves.toBe(false);

    const redelivered = await store.writeMedia(input);
    expect(redelivered).toEqual(staged);
    await expect(fs.readFile(redelivered.localPath, "utf8")).resolves.toBe("unconsumed attachment");
  });

  it("never discards media after its manifest transfers ownership to an agent", async () => {
    const sourceRootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-discard-source`);
    const targetRootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-discard-target`);
    directories.add(sourceRootDir);
    directories.add(targetRootDir);
    const store = new FileSystemMediaStore({rootDir: sourceRootDir});
    const staged = await store.writeMedia({
      bytes: Buffer.from("agent-owned attachment"),
      source: "telegram",
      connectorKey: "main",
      mimeType: "text/plain",
      idempotencyKey: "chat-1:message-1:attachment-1",
      createdAt: 1_777_000_000_000,
    });
    const relocated = await relocateMediaDescriptor(staged, {rootDir: targetRootDir});

    await expect(discardStagedMediaDescriptor(staged)).resolves.toBe(false);
    await expect(fs.readFile(relocated.localPath, "utf8")).resolves.toBe("agent-owned attachment");
    await expect(fs.readdir(path.dirname(staged.localPath))).resolves.toEqual(["descriptor.json"]);
  });

  it("prunes expired descriptor-only replay receipts without touching durable bytes", async () => {
    const sourceRootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-receipt-source`);
    const targetRootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-receipt-target`);
    directories.add(sourceRootDir);
    directories.add(targetRootDir);
    let nowMs = 1_000;
    const source = "telegram";
    const connectorKey = "main";
    const store = new FileSystemMediaStore({
      rootDir: sourceRootDir,
      now: () => new Date(nowMs),
      receiptRetentionMs: 1_000,
      resolveReceiptOwners: async () => [],
    });
    const firstKey = "receipt-old";

    const canonical = await store.writeMedia({
      bytes: Buffer.from("old durable byte"),
      source,
      connectorKey,
      mimeType: "text/plain",
      idempotencyKey: firstKey,
      createdAt: 1_000,
    });
    const relocated = await relocateMediaDescriptor(canonical, {rootDir: targetRootDir});
    const receiptDirectory = path.dirname(canonical.localPath);
    await fs.utimes(
      path.join(receiptDirectory, "descriptor.json"),
      new Date(nowMs),
      new Date(nowMs),
    );
    nowMs = 2_001;
    await expect(store.reconcileOrphanedReceipts()).resolves.toBe(1);

    await expect(fs.access(receiptDirectory)).rejects.toMatchObject({code: "ENOENT"});
    await expect(fs.readFile(relocated.localPath, "utf8")).resolves.toBe("old durable byte");
  });

  it("rejects reuse of an external media identity for different bytes", async () => {
    const rootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-conflict`);
    directories.add(rootDir);
    const store = new FileSystemMediaStore({rootDir});
    const common = {
      source: "whatsapp",
      connectorKey: "main",
      mimeType: "application/octet-stream",
      idempotencyKey: "chat-1:message-9:part-0",
      createdAt: 1_777_000_000_000,
    };

    await store.writeMedia({...common, bytes: Buffer.from("first")});
    await expect(store.writeMedia({...common, bytes: Buffer.from("second")}))
      .rejects.toThrow("already bound to different bytes");
  });

  it("relocates media into another root and stays idempotent", async () => {
    const sourceRootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-f-source`);
    const targetRootDir = path.join(tmpdir(), `runtime-media-store-${Date.now()}-f-target`);
    directories.add(sourceRootDir);
    directories.add(targetRootDir);

    const store = new FileSystemMediaStore({
      rootDir: sourceRootDir,
      now: () => new Date("2026-04-08T12:00:00.000Z"),
    });

    const descriptor = await store.writeMedia({
      bytes: Buffer.from("hello world", "utf8"),
      source: "telegram",
      connectorKey: "bot-main",
      mimeType: "text/plain",
      hintFilename: "greeting.txt",
    });

    const relocated = await relocateMediaDescriptor(descriptor, { rootDir: targetRootDir });
    expect(relocated).toMatchObject({
      id: descriptor.id,
      source: descriptor.source,
      connectorKey: descriptor.connectorKey,
      mimeType: descriptor.mimeType,
      sizeBytes: descriptor.sizeBytes,
      createdAt: descriptor.createdAt,
    });
    expect(path.basename(relocated.localPath)).toBe(path.basename(descriptor.localPath));
    expect(relocated.localPath).toMatch(/f-target\/telegram\/bot-main\/2026-04\/.+\.txt$/);
    await expect(fs.readFile(relocated.localPath, "utf8")).resolves.toBe("hello world");
    await expect(fs.access(descriptor.localPath)).rejects.toThrow();

    const relocatedAgain = await relocateMediaDescriptor(descriptor, { rootDir: targetRootDir });
    expect(relocatedAgain.localPath).toBe(relocated.localPath);
    await expect(fs.readFile(relocatedAgain.localPath, "utf8")).resolves.toBe("hello world");
  });

  it("falls back to copy plus unlink when a move crosses devices", async () => {
    const fileOps = {
      rename: vi.fn(async () => {
        const error = new Error("Cross-device link not permitted") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      }),
      copyFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };

    await moveMediaFile("/tmp/source.txt", "/tmp/target.txt", fileOps);

    expect(fileOps.rename).toHaveBeenCalledWith("/tmp/source.txt", "/tmp/target.txt");
    expect(fileOps.copyFile).toHaveBeenCalledWith("/tmp/source.txt", "/tmp/target.txt");
    expect(fileOps.unlink).toHaveBeenNthCalledWith(1, "/tmp/source.txt");
  });

  it("cleans up the copied target if cross-device unlink fails", async () => {
    const fileOps = {
      rename: vi.fn(async () => {
        const error = new Error("Cross-device link not permitted") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      }),
      copyFile: vi.fn(async () => {}),
      unlink: vi.fn(async (targetPath: string) => {
        if (targetPath === "/tmp/source.txt") {
          throw new Error("unlink failed");
        }
      }),
    };

    await expect(moveMediaFile("/tmp/source.txt", "/tmp/target.txt", fileOps)).rejects.toThrow("unlink failed");

    expect(fileOps.copyFile).toHaveBeenCalledWith("/tmp/source.txt", "/tmp/target.txt");
    expect(fileOps.unlink).toHaveBeenNthCalledWith(1, "/tmp/source.txt");
    expect(fileOps.unlink).toHaveBeenNthCalledWith(2, "/tmp/target.txt");
  });
});
