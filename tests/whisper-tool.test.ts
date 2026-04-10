import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Agent,
  RunContext,
  ToolError,
  WhisperTool,
  type PandaSessionContext,
  type ToolResultPayload,
} from "../src/index.js";

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

describe("WhisperTool", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("fails fast when OPENAI_API_KEY is missing", async () => {
    const tool = new WhisperTool({
      env: {},
    });

    await expect(tool.run(
      { path: "voice.mp3" },
      createRunContext({ cwd: "/workspace/panda" }),
    )).rejects.toBeInstanceOf(ToolError);
  });

  it("uploads a local audio file to whisper-1 and returns the transcript", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-whisper-"));
    const audioBytes = Buffer.from("fake-audio-data");

    try {
      const audioPath = path.join(workspace, "voice.mp3");
      await writeFile(audioPath, audioBytes);

      const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer openai-test-key",
        });

        const body = init?.body;
        expect(body).toBeInstanceOf(FormData);
        if (!(body instanceof FormData)) {
          throw new Error("Expected FormData body");
        }

        expect(body.get("model")).toBe("whisper-1");
        expect(body.get("response_format")).toBe("json");
        expect(body.get("language")).toBe("sk");
        expect(body.get("prompt")).toBe("Product name is Panda");

        const file = body.get("file");
        expect(file).not.toBeNull();
        expect(typeof file).not.toBe("string");
        if (!file || typeof file === "string") {
          throw new Error("Expected file upload");
        }

        expect(file.name).toBe("voice.mp3");
        expect(file.type).toBe("audio/mpeg");
        expect(Buffer.from(await file.arrayBuffer())).toEqual(audioBytes);

        return new Response(JSON.stringify({
          text: "ahoj panda",
          language: "sk",
          duration: 1.5,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      });
      global.fetch = fetchMock as typeof global.fetch;

      const tool = new WhisperTool({
        env: {
          OPENAI_API_KEY: "openai-test-key",
        },
      });

      const result = await tool.run(
        {
          path: "voice.mp3",
          language: "sk",
          prompt: "Product name is Panda",
        },
        createRunContext({ cwd: workspace }),
      ) as ToolResultPayload;

      expect(result.content).toEqual([
        {
          type: "text",
          text: "Transcript:\nahoj panda",
        },
      ]);
      expect(result.details).toMatchObject({
        provider: "openai",
        model: "whisper-1",
        originalPath: "voice.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: audioBytes.length,
        language: "sk",
        durationSeconds: 1.5,
        transcriptChars: 10,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects files larger than the OpenAI upload limit", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-whisper-limit-"));

    try {
      const audioPath = path.join(workspace, "huge.wav");
      await writeFile(audioPath, Buffer.alloc(25 * 1024 * 1024 + 1));

      const tool = new WhisperTool({
        env: {
          OPENAI_API_KEY: "openai-test-key",
        },
      });

      await expect(tool.run(
        { path: "huge.wav" },
        createRunContext({ cwd: workspace }),
      )).rejects.toThrow("accepts files up to 25 MB");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
