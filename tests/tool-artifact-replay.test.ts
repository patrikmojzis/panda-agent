import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {describe, expect, it} from "vitest";

import {rehydrateToolArtifactMessage} from "../src/kernel/agent/tool-artifacts.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6WQAAAAASUVORK5CYII=";

describe("tool artifact replay", () => {
  it("rehydrates persisted image artifacts back into inline image blocks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "runtime-tool-artifact-image-"));

    try {
      const imagePath = path.join(directory, "shot.png");
      await writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

      const message = await rehydrateToolArtifactMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "browser",
        isError: false,
        timestamp: Date.now(),
        content: [
          {type: "text", text: "Browser screenshot saved to disk"},
        ],
        details: {
          action: "screenshot",
          artifact: {
            kind: "image",
            source: "browser",
            path: imagePath,
            mimeType: "image/png",
          },
        },
      });

      expect(message.content).toMatchObject([
        {type: "text", text: "Browser screenshot saved to disk"},
        {type: "image", mimeType: "image/png"},
      ]);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it("rehydrates pdf artifacts from their preview image when available", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "runtime-tool-artifact-pdf-"));

    try {
      const previewPath = path.join(directory, "preview.png");
      await writeFile(previewPath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

      const message = await rehydrateToolArtifactMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "view_media",
        isError: false,
        timestamp: Date.now(),
        content: [
          {type: "text", text: "PDF preview cached"},
        ],
        details: {
          kind: "pdf",
          artifact: {
            kind: "pdf",
            source: "view_media",
            path: path.join(directory, "document.pdf"),
            mimeType: "application/pdf",
            preview: {
              kind: "image",
              path: previewPath,
              mimeType: "image/png",
            },
          },
        },
      });

      expect(message.content).toMatchObject([
        {type: "text", text: "PDF preview cached"},
        {type: "image", mimeType: "image/png"},
      ]);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it("fails soft when the artifact file is gone", async () => {
    const message = await rehydrateToolArtifactMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "browser",
      isError: false,
      timestamp: Date.now(),
      content: [
        {type: "text", text: "Missing artifact"},
      ],
      details: {
        artifact: {
          kind: "image",
          source: "browser",
          path: "/definitely/missing/screenshot.png",
          mimeType: "image/png",
        },
      },
    });

    expect(message.content).toEqual([
      {type: "text", text: "Missing artifact"},
    ]);
  });
});
