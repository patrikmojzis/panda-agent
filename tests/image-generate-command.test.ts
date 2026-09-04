import {mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {describe, expect, it, vi} from "vitest";

import {RuntimeCommandFileResolver} from "../src/app/runtime/command-files.js";
import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import type {GenerateOpenAIImageRequest} from "../src/integrations/providers/openai-image/client.js";
import {createImageGenerateCommand, IMAGE_GENERATE_COMMAND_NAME} from "../src/panda/commands/image-generate-command.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6WQAAAAASUVORK5CYII=";

describe("image generate command", () => {
  it("starts an image generation background job and resolves reference files", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "panda-image-command-data-"));
    const workspace = path.join(dataDir, "agents", "panda");
    try {
      const referencePath = path.join(workspace, "reference.png");
      await mkdir(path.dirname(referencePath), {recursive: true});
      await writeFile(referencePath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
      await writeFile(path.join(workspace, "second.png"), Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

      const store = new TestThreadRuntimeStore();
      await store.createThread({
        id: "thread-1",
        sessionId: "session-main",
      });
      const run = await store.createRun("thread-1");
      const jobService = new BackgroundToolJobService({store});
      const env = {
        DATA_DIR: dataDir,
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}",
      };
      let capturedRequest: GenerateOpenAIImageRequest | undefined;
      const command = createImageGenerateCommand({
        jobService,
        env,
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
      }, new RuntimeCommandFileResolver(env));

      const result = await command.execute({
        command: IMAGE_GENERATE_COMMAND_NAME,
        workingDirectory: "/root/.panda/agents/panda",
        input: {
          prompt: "Generate a sticker.",
          images: ["reference.png", "second.png"],
          quality: "high",
        },
        scope: {
          agentKey: "panda",
          sessionId: "session-main",
          threadId: "thread-1",
          runId: run.id,
        },
      });

      expect(result.output).toMatchObject({
        kind: "image_generate",
        status: "running",
        summary: "Generate a sticker.",
      });
      const record = await jobService.wait("thread-1", String(result.output.jobId), 1_000);
      expect(record.runId).toBe(run.id);
      expect(record.status).toBe("completed");
      expect(capturedRequest?.images?.map((image) => image.buffer)).toEqual([
        Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"), Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"),
      ]);
      const artifact = record.result?.details?.artifact as {path?: string} | undefined;
      expect(artifact?.path).toContain(path.join(dataDir, "agents", "panda", "media", "image-generation", "thread-1"));
      await expect(readFile(String(artifact?.path), "utf8")).resolves.toBe("generated-image");
      await jobService.close();
    } finally {
      await rm(dataDir, {recursive: true, force: true});
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it.each(["other-agent", "symlink", "spool", "missing", "no-resolver"] as const)(
    "rejects %s reference access before calling the image provider",
    async (scenario) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "panda-image-access-"));
      const store = new TestThreadRuntimeStore();
      const jobService = new BackgroundToolJobService({store});
      try {
        await store.createThread({id: "thread-1", sessionId: "session-main"});
        const run = await store.createRun("thread-1");
        const agentRoot = path.join(dataDir, "agents", "panda");
        const otherRoot = path.join(dataDir, "agents", "other");
        await mkdir(agentRoot, {recursive: true});
        await mkdir(otherRoot, {recursive: true});
        const privateImage = path.join(otherRoot, "private.png");
        await writeFile(privateImage, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
        await symlink(privateImage, path.join(agentRoot, "escape.png"));
        const spoolImage = path.join(dataDir, "outbound-file-spool", "private.png");
        await mkdir(path.dirname(spoolImage), {recursive: true});
        await writeFile(spoolImage, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
        const paths = {
          "other-agent": "/root/.panda/agents/other/private.png",
          symlink: "/root/.panda/agents/panda/escape.png",
          spool: spoolImage,
          missing: "/root/.panda/agents/panda/missing.png",
          "no-resolver": privateImage,
        };
        const env = {DATA_DIR: dataDir, BASH_EXECUTION_MODE: "remote", BASH_SERVER_CWD_TEMPLATE: "/root/.panda/agents/{agentKey}"};
        const generate = vi.fn();
        const command = createImageGenerateCommand({jobService, env, client: {generate}},
          scenario === "no-resolver" ? undefined : new RuntimeCommandFileResolver(env));
        await expect(command.execute({
          command: IMAGE_GENERATE_COMMAND_NAME,
          input: {prompt: "Edit the reference", images: [paths[scenario]]},
          scope: {agentKey: "panda", sessionId: "session-main", threadId: "thread-1", runId: run.id},
        })).rejects.toThrow(scenario === "no-resolver" ? "require a command file resolver" : /outside|Could not open/);
        expect(generate).not.toHaveBeenCalled();
      } finally {
        await jobService.close();
        await rm(dataDir, {recursive: true, force: true});
      }
    },
  );

  it("records an oversized resolved reference as a failed job without calling the provider", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "panda-image-size-"));
    const store = new TestThreadRuntimeStore();
    const jobService = new BackgroundToolJobService({store});
    try {
      await store.createThread({id: "thread-1", sessionId: "session-main"});
      const run = await store.createRun("thread-1");
      const imagePath = path.join(dataDir, "large.png");
      await writeFile(imagePath, "");
      await truncate(imagePath, 15 * 1024 * 1024 + 1);
      const generate = vi.fn();
      const command = createImageGenerateCommand({jobService, env: {DATA_DIR: dataDir}, client: {generate}},
        new RuntimeCommandFileResolver({DATA_DIR: dataDir, BASH_EXECUTION_MODE: "local"}));
      const result = await command.execute({
        command: IMAGE_GENERATE_COMMAND_NAME,
        input: {prompt: "Edit the reference", images: [imagePath]},
        scope: {agentKey: "panda", sessionId: "session-main", threadId: "thread-1", runId: run.id},
      });
      expect(await jobService.wait("thread-1", String(result.output.jobId), 1_000)).toMatchObject({
        status: "failed", error: expect.stringContaining("up to 15 MB"),
      });
      expect(generate).not.toHaveBeenCalled();
    } finally {
      await jobService.close();
      await rm(dataDir, {recursive: true, force: true});
    }
  });
});
