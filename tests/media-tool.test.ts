import {mkdir, mkdtemp, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {Agent, MediaTool, type PandaSessionContext, RunContext, type ToolResultPayload,} from "../src/index.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6WQAAAAASUVORK5CYII=";

const SIMPLE_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count 1 /Kids [3 0 R] >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 55 >>
stream
BT
/F1 24 Tf
72 72 Td
(Hello PDF) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000063 00000 n 
0000000122 00000 n 
0000000248 00000 n 
0000000353 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
423
%%EOF
`;

function createAgent() {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools",
  });
}

function createRunContext(context: PandaSessionContext): RunContext<PandaSessionContext> {
  return new RunContext({
    agent: createAgent(),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

describe("MediaTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns an attached image for image files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-media-image-"));
    try {
      const imagePath = path.join(workspace, "image.png");
      await writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

      const tool = new MediaTool();
      const result = await tool.run(
        { path: "image.png" },
        createRunContext({ cwd: workspace }),
      ) as ToolResultPayload;

      expect(result.content[0]).toMatchObject({
        type: "text",
      });
      expect(result.content[1]).toMatchObject({
        type: "image",
        mimeType: "image/png",
      });
      expect(result.details).toMatchObject({
        kind: "image",
        originalPath: "image.png",
        artifact: {
          kind: "image",
          source: "view_media",
          path: imagePath,
          mimeType: "image/png",
          originalPath: "image.png",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts persisted inline image blocks while keeping the artifact ref", () => {
    const tool = new MediaTool();
    const message = {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "view_media",
      isError: false,
      timestamp: Date.now(),
      content: [
        {type: "text" as const, text: "Image file: image.png"},
        {type: "image" as const, data: "ZmFrZQ==", mimeType: "image/png"},
      ],
      details: {
        kind: "image",
        path: "/tmp/image.png",
        artifact: {
          kind: "image",
          source: "view_media",
          path: "/tmp/image.png",
          mimeType: "image/png",
        },
      },
    };

    const redacted = tool.redactResultMessage(message);

    expect(redacted.content).toEqual([
      {type: "text", text: "Image file: image.png"},
    ]);
    expect(redacted.details).toMatchObject({
      kind: "image",
      path: "/tmp/image.png",
      artifact: {
        kind: "image",
        source: "view_media",
        path: "/tmp/image.png",
        mimeType: "image/png",
      },
    });
  });

  it("returns a preview image for pdf files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-media-pdf-"));
    const dataDir = await mkdtemp(path.join(tmpdir(), "panda-media-store-"));
    try {
      vi.stubEnv("PANDA_DATA_DIR", dataDir);
      const pdfPath = path.join(workspace, "document.pdf");
      await writeFile(pdfPath, SIMPLE_PDF, "utf8");

      const tool = new MediaTool();
      const result = await tool.run(
        { path: "document.pdf" },
        createRunContext({ cwd: workspace, agentKey: "jozef", threadId: "thread-1" }),
      ) as ToolResultPayload;

      expect(result.content[0]).toMatchObject({
        type: "text",
      });
      expect(result.content[1]).toMatchObject({
        type: "image",
        mimeType: "image/png",
      });
      expect(result.details).toMatchObject({
        kind: "pdf",
        originalPath: "document.pdf",
        artifact: {
          kind: "pdf",
          source: "view_media",
          path: pdfPath,
          mimeType: "application/pdf",
          originalPath: "document.pdf",
          preview: {
            kind: "image",
            mimeType: "image/png",
          },
        },
      });
      const previewPath = String((result.details as Record<string, unknown>).previewPath);
      expect(previewPath).toContain(path.join(dataDir, "agents", "jozef", "media", "view_media", "previews"));
      await expect(stat(previewPath)).resolves.toBeTruthy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reuses the same durable preview path for repeated pdf views", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-media-pdf-cache-"));
    const dataDir = await mkdtemp(path.join(tmpdir(), "panda-media-store-"));
    try {
      vi.stubEnv("PANDA_DATA_DIR", dataDir);
      const pdfPath = path.join(workspace, "document.pdf");
      await writeFile(pdfPath, SIMPLE_PDF, "utf8");

      const tool = new MediaTool();
      const first = await tool.run(
        {path: "document.pdf"},
        createRunContext({cwd: workspace, agentKey: "jozef", threadId: "thread-1"}),
      ) as ToolResultPayload;
      const second = await tool.run(
        {path: "document.pdf"},
        createRunContext({cwd: workspace, agentKey: "jozef", threadId: "thread-2"}),
      ) as ToolResultPayload;

      expect((first.details as Record<string, unknown>).previewPath).toBe(
        (second.details as Record<string, unknown>).previewPath,
      );
    } finally {
      await rm(workspace, {recursive: true, force: true});
      await rm(dataDir, {recursive: true, force: true});
    }
  });

  it("reads runner agent-home paths when remote bash is enabled", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "panda-media-remote-"));
    try {
      vi.stubEnv("PANDA_BASH_EXECUTION_MODE", "remote");
      vi.stubEnv("PANDA_RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
      vi.stubEnv("PANDA_DATA_DIR", dataDir);

      const localImagePath = path.join(dataDir, "agents", "jozef", "media", "telegram", "photo.png");
      await mkdir(path.dirname(localImagePath), {recursive: true});
      await writeFile(localImagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

      const tool = new MediaTool();
      const originalPath = "/root/.panda/agents/jozef/media/telegram/photo.png";
      const result = await tool.run(
        {path: originalPath},
        createRunContext({agentKey: "jozef"}),
      ) as ToolResultPayload;

      expect(result.content[1]).toMatchObject({
        type: "image",
        mimeType: "image/png",
      });
      expect(result.details).toMatchObject({
        kind: "image",
        path: localImagePath,
        originalPath,
        artifact: {
          kind: "image",
          source: "view_media",
          path: localImagePath,
          mimeType: "image/png",
          originalPath,
        },
      });
    } finally {
      await rm(dataDir, {recursive: true, force: true});
    }
  });
});
