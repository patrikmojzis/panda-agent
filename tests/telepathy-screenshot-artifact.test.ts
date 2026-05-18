import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {persistTelepathyScreenshotArtifact} from "../src/integrations/telepathy/screenshot-artifact.js";

describe("telepathy screenshot artifact", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop() ?? "", {recursive: true, force: true});
    }
  });

  async function createRoot(): Promise<string> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "telepathy-screenshot-artifact-"));
    tempDirs.push(rootDir);
    return rootDir;
  }

  it("persists screenshots under sanitized Telepathy media paths", async () => {
    const rootDir = await createRoot();

    const artifact = await persistTelepathyScreenshotArtifact({
      deviceId: "local/mac",
      label: "Local Mac",
      mimeType: "image/png",
      data: Buffer.from("telepathy-image").toString("base64"),
      bytes: 15,
    }, {
      rootDir,
      scopeKey: "thread/../main",
      now: () => 1778659323000,
      randomId: () => "image-id",
    });

    expect(artifact).toMatchObject({
      byteLength: 15,
      path: path.join(rootDir, "telepathy", "thread_.._main", "local_mac", "1778659323000-image-id.png"),
    });
    await expect(readFile(artifact.path, "utf8")).resolves.toBe("telepathy-image");
  });

  it("rejects screenshots when declared byte count does not match decoded bytes", async () => {
    const rootDir = await createRoot();

    await expect(persistTelepathyScreenshotArtifact({
      deviceId: "local-mac",
      mimeType: "image/png",
      data: Buffer.from("telepathy-image").toString("base64"),
      bytes: 999,
    }, {
      rootDir,
      scopeKey: "thread-1",
    })).rejects.toThrow(/declared 999 bytes/);
  });
});
