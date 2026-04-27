import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import type {AssistantMessage} from "@mariozechner/pi-ai";
import {afterEach, describe, expect, it, vi} from "vitest";

import {
  Agent,
  type DefaultAgentSessionContext,
  ImageGenerateTool,
  RunContext,
  stringToUserMessage,
  type ToolResultPayload,
} from "../src/index.js";
import type {GenerateOpenAIImageRequest} from "../src/integrations/providers/openai-image/client.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6WQAAAAASUVORK5CYII=";

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{type: "text", text}],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({name: "test", instructions: "Use tools"}),
    turn: 1,
    maxTurns: 5,
    messages: [
      stringToUserMessage("The mascot should wear a red scarf."),
      assistantText("Keep the image bright and friendly."),
    ],
    context,
  });
}

describe("ImageGenerateTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("stores generated images under the agent media directory and returns a redacted artifact", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "panda-image-tool-data-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-image-tool-work-"));
    try {
      const referencePath = path.join(workspace, "reference.png");
      await mkdir(path.dirname(referencePath), {recursive: true});
      await writeFile(referencePath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

      let capturedRequest: GenerateOpenAIImageRequest | undefined;
      const client = {
        generate: vi.fn(async (request: GenerateOpenAIImageRequest) => {
          capturedRequest = request;
          return {
            provider: "openai" as const,
            authKind: "codex-oauth" as const,
            model: request.model,
            responsesModel: "gpt-test",
            images: [{
              buffer: Buffer.from("generated-image"),
              mimeType: "image/png",
              fileName: "image-1.png",
            }],
          };
        }),
      };
      const runtime = {
        complete: vi.fn().mockResolvedValue(assistantText("Mascot: red scarf, bright friendly style.")),
      };
      const tool = new ImageGenerateTool({
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          OPENAI_OAUTH_TOKEN: "codex-token",
        },
        client,
        runtime,
      });

      const result = await tool.run({
        prompt: "Generate a square sticker.",
        images: ["reference.png"],
        size: "auto",
        quality: "high",
        outputFormat: "png",
      }, createRunContext({
        cwd: workspace,
        agentKey: "panda",
        sessionId: "session-1",
        threadId: "thread-1",
      })) as ToolResultPayload;

      expect(capturedRequest?.prompt).toContain("Conversation brief:");
      expect(capturedRequest?.prompt).toContain("red scarf");
      expect(capturedRequest?.images).toHaveLength(1);
      expect(capturedRequest).toMatchObject({
        model: "gpt-image-2",
        size: "auto",
        quality: "high",
        outputFormat: "png",
        background: "auto",
        moderation: "auto",
        count: 1,
      });

      const details = result.details as Record<string, any>;
      expect(details.artifact).toMatchObject({
        kind: "image",
        source: "image_generate",
        mimeType: "image/png",
      });
      expect(details.artifact.path).toContain(path.join(
        dataDir,
        "agents",
        "panda",
        "media",
        "image-generation",
        "thread-1",
      ));
      await expect(stat(details.artifact.path)).resolves.toBeTruthy();
      await expect(readFile(details.artifact.path, "utf8")).resolves.toBe("generated-image");
      expect(result.content.some((part) => part.type === "image")).toBe(true);

      const redacted = tool.redactResultMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "image_generate",
        isError: false,
        timestamp: Date.now(),
        content: result.content,
        details: result.details,
      });
      expect(redacted.content.some((part) => part.type === "image")).toBe(false);
      expect(redacted.details).toEqual(result.details);
    } finally {
      await rm(dataDir, {recursive: true, force: true});
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("rejects missing local reference images before calling the provider", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-image-tool-missing-"));
    try {
      const client = {
        generate: vi.fn(),
      };
      const tool = new ImageGenerateTool({client});

      await expect(tool.run({
        prompt: "Generate from this reference.",
        images: ["missing.png"],
      }, createRunContext({
        cwd: workspace,
        agentKey: "panda",
        sessionId: "session-1",
        threadId: "thread-1",
      }))).rejects.toThrow(/No readable reference image/);
      expect(client.generate).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("enforces output count and compression caps in the schema/options", async () => {
    const tool = new ImageGenerateTool({
      client: {
        generate: vi.fn(),
      },
    });

    await expect(tool.run({
      prompt: "too many",
      count: 5,
    }, createRunContext({
      cwd: process.cwd(),
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    }))).rejects.toThrow(/Too big/);

    await expect(tool.run({
      prompt: "bad compression",
      outputCompression: 80,
      outputFormat: "png",
    }, createRunContext({
      cwd: process.cwd(),
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
    }))).rejects.toThrow(/outputCompression requires outputFormat jpeg or webp/);
  });
});
