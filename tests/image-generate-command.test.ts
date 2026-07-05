import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {describe, expect, it, vi} from "vitest";

import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import type {GenerateOpenAIImageRequest} from "../src/integrations/providers/openai-image/client.js";
import {createImageGenerateCommand, IMAGE_GENERATE_COMMAND_NAME} from "../src/panda/commands/image-generate-command.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6WQAAAAASUVORK5CYII=";

describe("image generate command", () => {
  it("starts an image generation background job and resolves reference files", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "panda-image-command-data-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-image-command-work-"));
    try {
      const referencePath = path.join(workspace, "reference.png");
      await mkdir(path.dirname(referencePath), {recursive: true});
      await writeFile(referencePath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

      const store = new TestThreadRuntimeStore();
      await store.createThread({
        id: "thread-1",
        sessionId: "session-main",
      });
      const jobService = new BackgroundToolJobService({store});
      let capturedRequest: GenerateOpenAIImageRequest | undefined;
      const command = createImageGenerateCommand({
        jobService,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          OPENAI_OAUTH_TOKEN: "codex-token",
        },
        client: {
          generate: vi.fn(async (request: GenerateOpenAIImageRequest) => {
            capturedRequest = request;
            return {
              provider: "openai" as const,
              authKind: "codex-oauth" as const,
              model: request.model,
              images: [{
                buffer: Buffer.from("generated-image"),
                mimeType: "image/png",
                fileName: "image-1.png",
              }],
            };
          }),
        },
      }, {
        async resolveReadablePath({file}) {
          return {
            displayPath: file.path,
            path: path.join(workspace, file.path),
          };
        },
      });

      const result = await command.execute({
        command: IMAGE_GENERATE_COMMAND_NAME,
        input: {
          prompt: "Generate a sticker.",
          images: ["reference.png"],
          quality: "high",
        },
        scope: {
          agentKey: "panda",
          sessionId: "session-main",
          threadId: "thread-1",
        },
      });

      expect(result.output).toMatchObject({
        kind: "image_generate",
        status: "running",
        summary: "Generate a sticker.",
      });
      const record = await jobService.wait("thread-1", String(result.output.jobId), 1_000);
      expect(record.status).toBe("completed");
      expect(capturedRequest?.images).toHaveLength(1);
      const artifact = record.result?.details?.artifact as {path?: string} | undefined;
      expect(artifact?.path).toContain(path.join(dataDir, "agents", "panda", "media", "image-generation", "thread-1"));
      await expect(readFile(String(artifact?.path), "utf8")).resolves.toBe("generated-image");
    } finally {
      await rm(dataDir, {recursive: true, force: true});
      await rm(workspace, {recursive: true, force: true});
    }
  });
});
