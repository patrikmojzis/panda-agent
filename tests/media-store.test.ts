import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemMediaStore } from "../src/index.js";

describe("FileSystemMediaStore", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    for (const directory of directories) {
      await rm(directory, { recursive: true, force: true });
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
    await expect(readFile(descriptor.localPath, "utf8")).resolves.toBe("hello world");
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
    await expect(readFile(descriptor.localPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
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
});
