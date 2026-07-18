import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {
  CommandUploadError,
  FileSystemCommandUploadStore,
  MAX_COMMAND_UPLOAD_BYTES,
} from "../src/integrations/commands/file-uploads.js";

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield Buffer.from(value);
  }
}

describe("command file uploads", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })));
  });

  async function createStore(options: {maxBytes?: number; ttlMs?: number} = {}) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "panda-command-upload-"));
    directories.push(dataDir);
    return {
      dataDir,
      store: new FileSystemCommandUploadStore({
        env: {DATA_DIR: dataDir},
        ...options,
      }),
    };
  }

  it("uses the 60 MiB public upload limit", () => {
    expect(MAX_COMMAND_UPLOAD_BYTES).toBe(60 * 1024 * 1024);
  });

  it("streams through the exact limit and removes partial files on overflow", async () => {
    const {dataDir, store} = await createStore({maxBytes: 5});
    const scope = {agentKey: "panda", sessionId: "session-main"};
    const upload = await store.stage({
      scope,
      filename: "report.txt",
      mimeType: "text/plain; charset=utf-8",
      chunks: chunks("12", "345"),
    });

    await expect(store.inspect(scope, upload.uploadRef)).resolves.toEqual({
      uploadRef: upload.uploadRef,
      filename: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    await expect(store.stage({
      scope,
      filename: "too-large.txt",
      chunks: chunks("123", "456"),
    })).rejects.toEqual(expect.objectContaining<Partial<CommandUploadError>>({
      statusCode: 413,
    }));

    const uploadDirectory = path.join(dataDir, "agents", "panda", "media", "command-upload", "session-main");
    expect((await readdir(uploadDirectory)).some((name) => name.endsWith(".partial"))).toBe(false);
  });

  it("sanitizes filenames and scopes opaque references to agent and session", async () => {
    const {store} = await createStore();
    const scope = {agentKey: "panda", sessionId: "session-main"};
    const upload = await store.stage({
      scope,
      filename: "../../private/report\n.txt",
      mimeType: "not a mime",
      chunks: chunks("report"),
    });

    expect(upload).toMatchObject({
      filename: "report_.txt",
      mimeType: "application/octet-stream",
      sizeBytes: 6,
    });
    await expect(store.inspect({agentKey: "koala", sessionId: "session-main"}, upload.uploadRef))
      .rejects.toThrow("unknown or not available");
    await expect(store.inspect({agentKey: "panda", sessionId: "session-other"}, upload.uploadRef))
      .rejects.toThrow("unknown or not available");
    await expect(store.inspect(scope, "../../etc/passwd"))
      .rejects.toThrow("reference is invalid");
  });

  it("sweeps abandoned uploads after the retention window", async () => {
    const {store} = await createStore({ttlMs: 10});
    const scope = {agentKey: "panda", sessionId: "session-main"};
    const upload = await store.stage({
      scope,
      filename: "abandoned.txt",
      chunks: chunks("report"),
    });
    const resolved = await store.resolve(scope, upload.uploadRef);

    await expect(store.sweep(scope, Date.now() + 100)).resolves.toBe(1);
    await expect(store.resolve(scope, upload.uploadRef)).rejects.toThrow("unknown or not available");
    await expect(readdir(path.dirname(resolved.path))).resolves.not.toContain(`${upload.uploadRef}.data`);
  });
});
