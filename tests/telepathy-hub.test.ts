import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it} from "vitest";
import WebSocket from "ws";

import {hashTelepathyToken} from "../src/domain/telepathy/index.js";
import {Agent, type DefaultAgentSessionContext, RunContext} from "../src/index.js";
import {TelepathyHub} from "../src/integrations/telepathy/hub.js";
import {parseTelepathyReceiverMessage} from "../src/integrations/telepathy/protocol.js";
import {TelepathyScreenshotTool} from "../src/panda/tools/telepathy-screenshot-tool.js";

function createAgent() {
  return new Agent({
    name: "telepathy-test-agent",
    instructions: "Use tools.",
  });
}

function createRunContext(
  context: DefaultAgentSessionContext,
): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: createAgent(),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

async function waitForMessage(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    socket.once("message", (payload) => {
      try {
        resolve(JSON.parse(payload.toString("utf8")) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function createFakeTelepathyStore() {
  const devices = new Map<string, {
    agentKey: string;
    deviceId: string;
    label?: string;
    tokenHash: string;
    enabled: boolean;
    connected: boolean;
    createdAt: number;
    updatedAt: number;
    connectedAt?: number;
    lastSeenAt?: number;
    lastDisconnectedAt?: number;
  }>();
  const keyFor = (agentKey: string, deviceId: string) => `${agentKey}::${deviceId}`;

  return {
    async ensureSchema() {},
    async clearConnectedStates() {
      for (const device of devices.values()) {
        device.connected = false;
      }
    },
    async registerDevice(input: {agentKey: string; deviceId: string; tokenHash: string; label?: string}) {
      const now = Date.now();
      const key = keyFor(input.agentKey, input.deviceId);
      const next = {
        agentKey: input.agentKey,
        deviceId: input.deviceId,
        label: input.label,
        tokenHash: input.tokenHash,
        enabled: true,
        connected: false,
        createdAt: devices.get(key)?.createdAt ?? now,
        updatedAt: now,
        connectedAt: devices.get(key)?.connectedAt,
        lastSeenAt: devices.get(key)?.lastSeenAt,
        lastDisconnectedAt: devices.get(key)?.lastDisconnectedAt,
      };
      devices.set(key, next);
      return next;
    },
    async getDevice(agentKey: string, deviceId: string) {
      const found = devices.get(keyFor(agentKey, deviceId));
      if (!found) {
        throw new Error("missing device");
      }

      return found;
    },
    async listDevices(agentKey: string) {
      return [...devices.values()].filter((device) => device.agentKey === agentKey);
    },
    async setDeviceEnabled(agentKey: string, deviceId: string, enabled: boolean) {
      const found = await this.getDevice(agentKey, deviceId);
      found.enabled = enabled;
      found.connected = enabled ? found.connected : false;
      found.updatedAt = Date.now();
      found.lastDisconnectedAt = enabled ? found.lastDisconnectedAt : found.updatedAt;
      return found;
    },
    async markConnected(agentKey: string, deviceId: string, label?: string) {
      const found = await this.getDevice(agentKey, deviceId);
      const now = Date.now();
      found.connected = true;
      found.connectedAt = now;
      found.lastSeenAt = now;
      found.updatedAt = now;
      found.lastDisconnectedAt = undefined;
      if (label) {
        found.label = label;
      }
      return found;
    },
    async touchLastSeen(agentKey: string, deviceId: string) {
      const found = await this.getDevice(agentKey, deviceId);
      const now = Date.now();
      found.lastSeenAt = now;
      found.updatedAt = now;
    },
    async markDisconnected(agentKey: string, deviceId: string) {
      const found = await this.getDevice(agentKey, deviceId);
      const now = Date.now();
      found.connected = false;
      found.updatedAt = now;
      found.lastDisconnectedAt = now;
    },
  };
}

describe("telepathy hub", () => {
  const tempDirs: string[] = [];
  const hubs: TelepathyHub[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    while (sockets.length > 0) {
      const socket = sockets.pop();
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        continue;
      }

      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    }

    while (hubs.length > 0) {
      await hubs.pop()?.close();
    }

    while (tempDirs.length > 0) {
      await rm(tempDirs.pop() ?? "", {recursive: true, force: true});
    }
  });

  it("routes screenshot requests to the connected device", async () => {
    const telepathyStore = createFakeTelepathyStore();
    await telepathyStore.registerDevice({
      agentKey: "panda",
      deviceId: "home-mac",
      tokenHash: hashTelepathyToken("secret-123"),
      label: "Home Mac",
    });
    const hub = new TelepathyHub({
      host: "127.0.0.1",
      port: 0,
      path: "/telepathy",
      store: telepathyStore,
    });
    hubs.push(hub);
    await hub.start();

    const socket = new WebSocket(`ws://127.0.0.1:${hub.boundPort}/telepathy`);
    sockets.push(socket);
    await waitForOpen(socket);
    socket.send(JSON.stringify({
      type: "device.hello",
      agentKey: "panda",
      deviceId: "home-mac",
      token: "secret-123",
      label: "Home Mac",
    }));

    await expect(waitForMessage(socket)).resolves.toMatchObject({
      type: "device.ready",
      agentKey: "panda",
      deviceId: "home-mac",
    });

    socket.on("message", (payload) => {
      const message = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
      if (message.type !== "screenshot.request") {
        return;
      }

      socket.send(JSON.stringify({
        type: "screenshot.result",
        requestId: message.requestId,
        ok: true,
        mimeType: "image/png",
        data: Buffer.from("telepathy-image").toString("base64"),
        bytes: 15,
      }));
    });

    await expect(hub.requestScreenshot({
      agentKey: "panda",
      deviceId: "home-mac",
      timeoutMs: 2_000,
    })).resolves.toMatchObject({
      deviceId: "home-mac",
      label: "Home Mac",
      mimeType: "image/png",
      data: Buffer.from("telepathy-image").toString("base64"),
      bytes: 15,
    });
  });

  it("waits briefly for a device that connects just after the request starts", async () => {
    const telepathyStore = createFakeTelepathyStore();
    await telepathyStore.registerDevice({
      agentKey: "panda",
      deviceId: "late-mac",
      tokenHash: hashTelepathyToken("secret-123"),
      label: "Late Mac",
    });
    const hub = new TelepathyHub({
      host: "127.0.0.1",
      port: 0,
      path: "/telepathy",
      store: telepathyStore,
    });
    hubs.push(hub);
    await hub.start();

    const screenshotPromise = hub.requestScreenshot({
      agentKey: "panda",
      deviceId: "late-mac",
      timeoutMs: 2_000,
      connectWaitMs: 1_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    const socket = new WebSocket(`ws://127.0.0.1:${hub.boundPort}/telepathy`);
    sockets.push(socket);
    await waitForOpen(socket);
    socket.send(JSON.stringify({
      type: "device.hello",
      agentKey: "panda",
      deviceId: "late-mac",
      token: "secret-123",
      label: "Late Mac",
    }));

    await expect(waitForMessage(socket)).resolves.toMatchObject({
      type: "device.ready",
      agentKey: "panda",
      deviceId: "late-mac",
    });

    socket.on("message", (payload) => {
      const message = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
      if (message.type !== "screenshot.request") {
        return;
      }

      socket.send(JSON.stringify({
        type: "screenshot.result",
        requestId: message.requestId,
        ok: true,
        mimeType: "image/jpeg",
        data: Buffer.from("late-telepathy-image").toString("base64"),
        bytes: 20,
      }));
    });

    await expect(screenshotPromise).resolves.toMatchObject({
      deviceId: "late-mac",
      label: "Late Mac",
      mimeType: "image/jpeg",
      data: Buffer.from("late-telepathy-image").toString("base64"),
      bytes: 20,
    });
  });

  it("accepts pushed context items from an authenticated device", async () => {
    const submitted: Array<Record<string, unknown>> = [];
    const telepathyStore = createFakeTelepathyStore();
    await telepathyStore.registerDevice({
      agentKey: "panda",
      deviceId: "voice-mac",
      tokenHash: hashTelepathyToken("secret-123"),
      label: "Voice Mac",
    });
    const hub = new TelepathyHub({
      host: "127.0.0.1",
      port: 0,
      path: "/telepathy",
      store: telepathyStore,
      onContextSubmit: async (input) => {
        submitted.push(input as unknown as Record<string, unknown>);
      },
    });
    hubs.push(hub);
    await hub.start();

    const socket = new WebSocket(`ws://127.0.0.1:${hub.boundPort}/telepathy`);
    sockets.push(socket);
    await waitForOpen(socket);
    socket.send(JSON.stringify({
      type: "device.hello",
      agentKey: "panda",
      deviceId: "voice-mac",
      token: "secret-123",
      label: "Voice Mac",
    }));

    await expect(waitForMessage(socket)).resolves.toMatchObject({
      type: "device.ready",
      agentKey: "panda",
      deviceId: "voice-mac",
    });

    socket.send(JSON.stringify({
      type: "context.submit",
      requestId: "ctx-1",
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
          data: Buffer.from("audio-bytes").toString("base64"),
          bytes: 11,
        },
        {
          type: "image",
          mimeType: "image/jpeg",
          data: Buffer.from("image-bytes").toString("base64"),
          bytes: 11,
        },
      ],
    }));

    await expect(waitForMessage(socket)).resolves.toMatchObject({
      type: "context.accepted",
      requestId: "ctx-1",
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      agentKey: "panda",
      deviceId: "voice-mac",
      label: "Voice Mac",
      requestId: "ctx-1",
      mode: "push_to_talk",
      metadata: {
        frontmostApp: "Telegram",
        trigger: "voice_with_screenshot_hotkey",
      },
    });
  });

  it("rejects unsupported pushed context media types", async () => {
    const telepathyStore = createFakeTelepathyStore();
    await telepathyStore.registerDevice({
      agentKey: "panda",
      deviceId: "voice-mac",
      tokenHash: hashTelepathyToken("secret-123"),
      label: "Voice Mac",
    });
    const hub = new TelepathyHub({
      host: "127.0.0.1",
      port: 0,
      path: "/telepathy",
      store: telepathyStore,
      onContextSubmit: async () => {
        throw new Error("should not ingest invalid context");
      },
    });
    hubs.push(hub);
    await hub.start();

    const socket = new WebSocket(`ws://127.0.0.1:${hub.boundPort}/telepathy`);
    sockets.push(socket);
    await waitForOpen(socket);
    socket.send(JSON.stringify({
      type: "device.hello",
      agentKey: "panda",
      deviceId: "voice-mac",
      token: "secret-123",
      label: "Voice Mac",
    }));

    await expect(waitForMessage(socket)).resolves.toMatchObject({
      type: "device.ready",
      agentKey: "panda",
      deviceId: "voice-mac",
    });

    socket.send(JSON.stringify({
      type: "context.submit",
      requestId: "ctx-invalid",
      mode: "push_to_talk",
      items: [
        {
          type: "audio",
          mimeType: "application/octet-stream",
          data: Buffer.from("audio-bytes").toString("base64"),
        },
      ],
    }));

    await expect(waitForMessage(socket)).resolves.toMatchObject({
      type: "request.error",
      error: expect.stringContaining("Invalid telepathy receiver message"),
    });
  });

  it("rejects unsafe screenshot result payloads", () => {
    expect(() => parseTelepathyReceiverMessage({
      type: "screenshot.result",
      requestId: "shot-1",
      ok: true,
      mimeType: "text/html",
      data: Buffer.from("<script>").toString("base64"),
      bytes: 8,
    })).toThrow(/Invalid telepathy receiver message/);

    expect(() => parseTelepathyReceiverMessage({
      type: "screenshot.result",
      requestId: "shot-2",
      ok: true,
      mimeType: "image/jpeg",
      data: "not base64!",
      bytes: 10,
    })).toThrow(/Invalid base64 payload/);
  });

  it("persists screenshot artifacts into Panda media paths", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-telepathy-tool-"));
    tempDirs.push(tempDir);
    const imageBase64 = Buffer.from("telepathy-image").toString("base64");
    const tool = new TelepathyScreenshotTool({
      env: {
        ...process.env,
        DATA_DIR: tempDir,
      },
      service: {
        requestScreenshot: async () => ({
          deviceId: "home-mac",
          label: "Home Mac",
          mimeType: "image/jpeg",
          data: imageBase64,
          bytes: 15,
        }),
      },
    });

    const result = await tool.handle({
      deviceId: "home-mac",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
      cwd: "/workspace/panda",
    }));

    expect(result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
      data: imageBase64,
    });
    const screenshotPath = String((result.details as Record<string, unknown>).path);
    expect(screenshotPath).toContain(path.join("agents", "panda", "media", "telepathy", "thread-1", "home-mac"));
    await expect(stat(screenshotPath)).resolves.toBeTruthy();
    await expect(readFile(screenshotPath, "utf8")).resolves.toBe("telepathy-image");
  });

  it("rejects screenshot artifacts when declared byte count does not match decoded bytes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-telepathy-tool-"));
    tempDirs.push(tempDir);
    const tool = new TelepathyScreenshotTool({
      env: {
        ...process.env,
        DATA_DIR: tempDir,
      },
      service: {
        requestScreenshot: async () => ({
          deviceId: "home-mac",
          label: "Home Mac",
          mimeType: "image/jpeg",
          data: Buffer.from("telepathy-image").toString("base64"),
          bytes: 999,
        }),
      },
    });

    await expect(tool.handle({
      deviceId: "home-mac",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
      cwd: "/workspace/panda",
    }))).rejects.toThrow(/declared 999 bytes/);
  });
});
