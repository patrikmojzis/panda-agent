import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {FileSystemMediaStore} from "../src/domain/channels/index.js";
import {persistTelepathyContextItems} from "../src/integrations/telepathy/context-media.js";

describe("telepathy context media", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop() ?? "", {recursive: true, force: true});
    }
  });

  async function createStore(): Promise<FileSystemMediaStore> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "telepathy-context-media-"));
    tempDirs.push(rootDir);
    return new FileSystemMediaStore({
      rootDir,
      now: () => new Date("2026-05-13T01:02:03.000Z"),
    });
  }

  it("persists pushed media with Telepathy metadata and preserves text items", async () => {
    const mediaStore = await createStore();

    const persisted = await persistTelepathyContextItems({
      agentKey: "panda",
      deviceId: "local-mac",
      requestId: "ctx-123",
      mode: "push_to_talk",
      label: "Local Mac",
      metadata: {
        frontmostApp: "Telegram",
        windowTitle: "Chat",
        trigger: "voice_with_screenshot_hotkey",
      },
      mediaStore,
      items: [
        {
          type: "text",
          text: "heads up",
        },
        {
          type: "audio",
          mimeType: "audio/m4a",
          filename: "../voice-note.m4a",
          data: Buffer.from("voice-note").toString("base64"),
          bytes: 10,
        },
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("screen-shot").toString("base64"),
        },
      ],
    });

    expect(persisted.textParts).toEqual(["heads up"]);
    expect(persisted.media).toHaveLength(2);

    const audio = persisted.media[0]!;
    const image = persisted.media[1]!;
    expect(audio).toMatchObject({
      source: "telepathy",
      connectorKey: "local-mac",
      mimeType: "audio/m4a",
      sizeBytes: 10,
      originalFilename: "voice-note.m4a",
    });
    expect(audio.metadata).toMatchObject({
      requestId: "ctx-123",
      deviceId: "local-mac",
      agentKey: "panda",
      label: "Local Mac",
      mode: "push_to_talk",
      itemType: "audio",
      itemIndex: 1,
      frontmostApp: "Telegram",
      windowTitle: "Chat",
      trigger: "voice_with_screenshot_hotkey",
    });
    expect(path.extname(image.localPath)).toBe(".png");
    expect(image.metadata).toMatchObject({
      itemType: "image",
      itemIndex: 2,
    });
    await expect(readFile(audio.localPath, "utf8")).resolves.toBe("voice-note");
    await expect(readFile(image.localPath, "utf8")).resolves.toBe("screen-shot");
  });

  it("rejects pushed media when declared byte count does not match decoded bytes", async () => {
    const mediaStore = await createStore();

    await expect(persistTelepathyContextItems({
      agentKey: "panda",
      deviceId: "local-mac",
      requestId: "ctx-bad-bytes",
      mode: "push_to_talk",
      mediaStore,
      items: [
        {
          type: "audio",
          mimeType: "audio/m4a",
          data: Buffer.from("voice-note").toString("base64"),
          bytes: 999,
        },
      ],
    })).rejects.toThrow(/declared 999 bytes/);
  });
});
