import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  Agent,
  MediaTool,
  RunContext,
  type PandaSessionContext,
  type ToolResultPayload,
} from "../src/index.js";

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
    model: "gpt-4o-mini",
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
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns a preview image for pdf files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-media-pdf-"));
    try {
      const pdfPath = path.join(workspace, "document.pdf");
      await writeFile(pdfPath, SIMPLE_PDF, "utf8");

      const tool = new MediaTool();
      const result = await tool.run(
        { path: "document.pdf" },
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
        kind: "pdf",
        originalPath: "document.pdf",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
