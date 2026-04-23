import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {TelepathyContextIngress} from "../src/app/runtime/telepathy-context-ingress.js";

describe("telepathy context ingress", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop() ?? "", {recursive: true, force: true});
    }
  });

  it("persists pushed audio and image items then wakes the agent main session", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "runtime-telepathy-context-"));
    tempDirs.push(dataDir);

    const sessions = new Map<string, {
      id: string;
      agentKey: string;
      kind: "main" | "branch";
      currentThreadId: string;
      createdByIdentityId?: string;
    }>();
    const threads = new Map<string, {
      id: string;
      sessionId: string;
      context?: unknown;
    }>();
    const submittedInputs: Array<{
      threadId: string;
      payload: Record<string, unknown>;
    }> = [];

    const ingress = new TelepathyContextIngress({
      coordinator: {
        submitInput: async (threadId, payload) => {
          submittedInputs.push({
            threadId,
            payload: payload as unknown as Record<string, unknown>,
          });
        },
      } as never,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
      },
      fallbackContext: {
        cwd: "/workspace/panda-agent",
      },
      pool: {} as never,
      sessionStore: {
        ensureSchema: async () => {},
        createSession: async (input) => {
          const session = {
            ...input,
          };
          sessions.set(session.id, session);
          return session;
        },
        getSession: async (sessionId) => {
          const session = sessions.get(sessionId);
          if (!session) {
            throw new Error(`Unknown session ${sessionId}`);
          }

          return session;
        },
        getMainSession: async (agentKey) => {
          return [...sessions.values()].find((session) => session.agentKey === agentKey && session.kind === "main") ?? null;
        },
        listAgentSessions: async (agentKey) => [...sessions.values()].filter((session) => session.agentKey === agentKey),
        updateCurrentThread: async (input) => {
          const session = sessions.get(input.sessionId);
          if (!session) {
            throw new Error(`Unknown session ${input.sessionId}`);
          }

          session.currentThreadId = input.currentThreadId;
          return session;
        },
        getHeartbeat: async () => null,
        listDueHeartbeats: async () => [],
        claimHeartbeat: async () => null,
        recordHeartbeatResult: async () => {
          throw new Error("not used");
        },
        updateHeartbeatConfig: async () => {
          throw new Error("not used");
        },
      },
      store: {
        createThread: async (input) => {
          const thread = {
            ...input,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          threads.set(thread.id, thread);
          return thread;
        },
        getThread: async (threadId) => {
          const thread = threads.get(threadId);
          if (!thread) {
            throw new Error(`Unknown thread ${threadId}`);
          }

          return thread as never;
        },
      } as never,
    });

    await ingress.ingest({
      agentKey: "panda",
      deviceId: "tunnel-mac-patrik",
      label: "Tunnel Mac Patrik",
      requestId: "ctx-123",
      mode: "push_to_talk",
      metadata: {
        submittedAt: Date.now(),
        frontmostApp: "Telegram",
        trigger: "voice_with_screenshot_hotkey",
      },
      items: [
        {
          type: "audio",
          mimeType: "audio/m4a",
          data: Buffer.from("voice-note").toString("base64"),
          bytes: 10,
        },
        {
          type: "image",
          mimeType: "image/jpeg",
          data: Buffer.from("screen-shot").toString("base64"),
          bytes: 11,
        },
      ],
    });

    expect(sessions.size).toBe(1);
    expect(threads.size).toBe(1);
    expect(submittedInputs).toHaveLength(1);

    const queued = submittedInputs[0]!;
    const payload = queued.payload;
    expect(payload.source).toBe("telepathy");
    expect(payload.channelId).toBe("tunnel-mac-patrik");
    expect(payload.externalMessageId).toBe("ctx-123");
    expect(payload.actorId).toBe("tunnel-mac-patrik");
    expect(payload.message).toMatchObject({
      role: "user",
    });

    const messageText = String((payload.message as {content: string}).content);
    expect(messageText).toContain("This context came from Panda Telepathy.");
    expect(messageText).toContain("Use whisper on audio attachment paths");
    expect(messageText).toContain("Use view_media on image attachment paths");
    expect(messageText).toContain("Tunnel Mac Patrik");

    const metadata = payload.metadata as {
      telepathy: {
        media: Array<{localPath: string; mimeType: string}>;
      };
    };
    expect(metadata.telepathy.media).toHaveLength(2);

    const audio = metadata.telepathy.media.find((item) => item.mimeType === "audio/m4a");
    const image = metadata.telepathy.media.find((item) => item.mimeType === "image/jpeg");
    expect(audio?.localPath).toContain(path.join("agents", "panda", "media", "telepathy", "tunnel-mac-patrik"));
    expect(image?.localPath).toContain(path.join("agents", "panda", "media", "telepathy", "tunnel-mac-patrik"));
    await expect(readFile(audio!.localPath, "utf8")).resolves.toBe("voice-note");
    await expect(readFile(image!.localPath, "utf8")).resolves.toBe("screen-shot");
  });

  it("rejects pushed media when declared byte count does not match decoded bytes", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "runtime-telepathy-context-"));
    tempDirs.push(dataDir);

    const ingress = new TelepathyContextIngress({
      coordinator: {
        submitInput: async () => {
          throw new Error("should not wake agent for invalid media");
        },
      } as never,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
      },
      fallbackContext: {
        cwd: "/workspace/panda-agent",
      },
      pool: {} as never,
      sessionStore: {
        ensureSchema: async () => {},
        createSession: async (input) => input as never,
        getSession: async () => {
          throw new Error("not used");
        },
        getMainSession: async () => ({
          id: "session-1",
          agentKey: "panda",
          kind: "main",
          currentThreadId: "thread-1",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }) as never,
        listAgentSessions: async () => [],
        updateCurrentThread: async () => {
          throw new Error("not used");
        },
        getHeartbeat: async () => null,
        listDueHeartbeats: async () => [],
        claimHeartbeat: async () => null,
        recordHeartbeatResult: async () => {
          throw new Error("not used");
        },
        updateHeartbeatConfig: async () => {
          throw new Error("not used");
        },
      },
      store: {
        getThread: async () => ({
          id: "thread-1",
          sessionId: "session-1",
          context: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }) as never,
      } as never,
    });

    await expect(ingress.ingest({
      agentKey: "panda",
      deviceId: "tunnel-mac-patrik",
      requestId: "ctx-bad-bytes",
      mode: "push_to_talk",
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
