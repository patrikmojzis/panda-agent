import * as fs from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {FileSystemMediaStore, relocateMediaDescriptor} from "../src/index.js";
import {moveMediaFile} from "../src/features/channels/core/media-store.js";

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
    const rootDir = path.join(tmpdir(), `panda-media-store-${Date.now()}-a`);
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
    const rootDir = path.join(tmpdir(), `panda-media-store-${Date.now()}-b`);
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
    const rootDir = path.join(tmpdir(), `panda-media-store-${Date.now()}-d`);
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

  it("validates required fields", async () => {
    const rootDir = path.join(tmpdir(), `panda-media-store-${Date.now()}-c`);
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
    const rootDir = path.join(tmpdir(), `panda-media-store-${Date.now()}-e`);
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

  it("relocates media into another root and stays idempotent", async () => {
    const sourceRootDir = path.join(tmpdir(), `panda-media-store-${Date.now()}-f-source`);
    const targetRootDir = path.join(tmpdir(), `panda-media-store-${Date.now()}-f-target`);
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
