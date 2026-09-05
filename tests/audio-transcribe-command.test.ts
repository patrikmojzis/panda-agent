import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {describe, expect, it, vi} from "vitest";

import {
  createWhisperTranscribeCommand,
  createWhisperTranslateCommand,
  WHISPER_TRANSCRIBE_COMMAND_NAME,
  WHISPER_TRANSLATE_COMMAND_NAME,
} from "../src/integrations/audio/commands.js";

describe("whisper audio commands", () => {
  describe.each([
    ["transcribe", createWhisperTranscribeCommand],
    ["translate", createWhisperTranslateCommand],
  ] as const)("%s cancellation", (operation, createCommand) => {
    it.each(["before execution", "during fetch", "timeout"] as const)("handles %s", async (when) => {
      const workspace = await mkdtemp(path.join(tmpdir(), "panda-audio-cancellation-"));
      try {
        const audioPath = path.join(workspace, "voice.mp3");
        await writeFile(audioPath, "fake-audio-data");
        const controller = new AbortController();
        if (when === "before execution") controller.abort();
        const fetchImpl = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Expected a cancellation signal.");
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, {once: true});
          if (when === "during fetch") controller.abort();
        }));
        const command = createCommand({apiKey: "openai-test-key", fetchImpl, timeoutMs: 20});
        await expect(command.execute({
          command: command.descriptor.name,
          input: {path: audioPath},
          scope: {agentKey: "panda", sessionId: "session-main"},
          signal: controller.signal,
        })).rejects.toThrow(when === "timeout"
          ? `Whisper ${operation} timed out after 20ms.`
          : `Whisper ${operation} was aborted.`);
        expect(fetchImpl).toHaveBeenCalledOnce();
      } finally {
        await rm(workspace, {recursive: true, force: true});
      }
    });
  });

  it("transcribes a resolved local audio file", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-audio-command-"));
    const audioBytes = Buffer.from("fake-audio-data");
    try {
      await writeFile(path.join(workspace, "voice.mp3"), audioBytes);
      const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.openai.com/v1/audio/transcriptions");
        const body = init?.body;
        expect(body).toBeInstanceOf(FormData);
        if (!(body instanceof FormData)) {
          throw new Error("Expected FormData body");
        }
        expect(body.get("language")).toBe("sk");
        const file = body.get("file");
        expect(file).not.toBeNull();
        expect(typeof file).not.toBe("string");

        return new Response(JSON.stringify({
          text: "ahoj panda",
          language: "sk",
          duration: 1.5,
        }), {
          status: 200,
          headers: {"content-type": "application/json"},
        });
      });
      const command = createWhisperTranscribeCommand({
        apiKey: "openai-test-key",
        fetchImpl,
      }, {
        async resolveReadablePath({file}) {
          return {
            displayPath: file.path,
            path: path.join(workspace, file.path),
          };
        },
      });

      const result = await command.execute({
        command: WHISPER_TRANSCRIBE_COMMAND_NAME,
        input: {
          path: "voice.mp3",
          language: "sk",
        },
        scope: {
          agentKey: "panda",
          sessionId: "session-main",
        },
      });

      expect(result.output).toMatchObject({
        text: "ahoj panda",
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
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("translates a resolved local audio file to English", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-audio-command-"));
    const audioBytes = Buffer.from("fake-audio-data");
    try {
      await writeFile(path.join(workspace, "voice.mp3"), audioBytes);
      const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.openai.com/v1/audio/translations");
        const body = init?.body;
        expect(body).toBeInstanceOf(FormData);
        if (!(body instanceof FormData)) {
          throw new Error("Expected FormData body");
        }
        expect(body.get("language")).toBeNull();
        expect(body.get("prompt")).toBe("Panda vocabulary");
        const file = body.get("file");
        expect(file).not.toBeNull();
        expect(typeof file).not.toBe("string");

        return new Response(JSON.stringify({
          text: "hello panda",
        }), {
          status: 200,
          headers: {"content-type": "application/json"},
        });
      });
      const command = createWhisperTranslateCommand({
        apiKey: "openai-test-key",
        fetchImpl,
      }, {
        async resolveReadablePath({file}) {
          return {
            displayPath: file.path,
            path: path.join(workspace, file.path),
          };
        },
      });

      const result = await command.execute({
        command: WHISPER_TRANSLATE_COMMAND_NAME,
        input: {
          path: "voice.mp3",
          prompt: "Panda vocabulary",
          language: "sk",
        },
        scope: {
          agentKey: "panda",
          sessionId: "session-main",
        },
      });

      expect(result).toMatchObject({
        ok: true,
        command: WHISPER_TRANSLATE_COMMAND_NAME,
        output: {
          text: "hello panda",
          provider: "openai",
          model: "whisper-1",
          originalPath: "voice.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: audioBytes.length,
          targetLanguage: "en",
          translationChars: 11,
        },
      });
      expect(result.output).not.toHaveProperty("transcriptChars");
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });
});
