import {randomUUID} from "node:crypto";
import {createServer, type IncomingMessage, type Server} from "node:http";
import type {AddressInfo} from "node:net";

import {WebSocketServer, type WebSocket} from "ws";

import type {TelepathyDeviceStore} from "../../domain/telepathy/index.js";
import {telepathyTokenMatches} from "../../domain/telepathy/index.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {trimToNull} from "../../lib/strings.js";
import type {
  TelepathyContextItem,
  TelepathyContextSubmit,
  TelepathyReceiverMessage,
  TelepathyServerMessage,
  TelepathyScreenshotResult,
} from "./protocol.js";
import {
  parseTelepathyReceiverMessage,
} from "./protocol.js";

const DEFAULT_TELEPATHY_HOST = "127.0.0.1";
const DEFAULT_TELEPATHY_PORT = 8787;
const DEFAULT_TELEPATHY_PATH = "/telepathy";
const DEFAULT_TELEPATHY_TIMEOUT_MS = 20_000;
const DEFAULT_TELEPATHY_DEVICE_WAIT_MS = 3_000;
const DEVICE_WAIT_POLL_MS = 100;
const RECEIVER_CLOSE_CODE_POLICY_VIOLATION = 1008;
const RECEIVER_CLOSE_CODE_TRY_AGAIN = 1013;

interface ConnectedDevice {
  agentKey: string;
  deviceId: string;
  label?: string;
  authenticatedTokenHash: string;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
}

interface PendingScreenshotRequest {
  agentKey: string;
  deviceId: string;
  timeout: NodeJS.Timeout;
  resolve: (value: TelepathyScreenshotCapture) => void;
  reject: (error: unknown) => void;
}

export interface TelepathyScreenshotCapture {
  deviceId: string;
  label?: string;
  mimeType: string;
  data: string;
  bytes?: number;
}

export interface TelepathyConnectedDeviceInfo {
  agentKey: string;
  deviceId: string;
  label?: string;
  connectedAt: number;
  lastSeenAt: number;
}

export interface TelepathyHubOptions {
  env?: NodeJS.ProcessEnv;
  host?: string;
  onContextSubmit?: TelepathyContextSubmitHandler;
  path?: string;
  port?: number;
  store: TelepathyDeviceStore;
}

export interface TelepathyContextSubmitMetadata {
  submittedAt?: number;
  frontmostApp?: string;
  windowTitle?: string;
  trigger?: string;
}

export interface TelepathyContextSubmitInput {
  agentKey: string;
  deviceId: string;
  label?: string;
  requestId: string;
  mode: string;
  items: readonly TelepathyContextItem[];
  metadata?: TelepathyContextSubmitMetadata;
}

export type TelepathyContextSubmitHandler = (
  input: TelepathyContextSubmitInput,
) => Promise<void> | void;

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return `/${trimmed}`;
  }

  return trimmed;
}

function readPort(value: string | null): number {
  if (!value) {
    return DEFAULT_TELEPATHY_PORT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid telepathy port: ${value}`);
  }

  return parsed;
}

function buildDeviceKey(agentKey: string, deviceId: string): string {
  return `${agentKey}::${deviceId}`;
}

function isUpgradeRequestForPath(request: IncomingMessage, expectedPath: string): boolean {
  if (!request.url) {
    return false;
  }

  const pathname = new URL(request.url, "http://telepathy.local").pathname.replace(/\/+$/, "") || "/";
  const normalizedExpectedPath = expectedPath.replace(/\/+$/, "") || "/";
  return pathname === normalizedExpectedPath;
}

function safeJsonParse(message: WebSocket.RawData): unknown {
  const text = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ToolError("Telepathy receiver sent invalid JSON.");
  }
}

function sendJson(socket: WebSocket, payload: TelepathyServerMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(JSON.stringify(payload), (error: Error | undefined) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function closeSocket(socket: WebSocket, code: number, reason: string): Promise<void> {
  if (socket.readyState === socket.CLOSING || socket.readyState === socket.CLOSED) {
    return;
  }

  socket.close(code, reason);
}

export function resolveTelepathyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = trimToNull(env.TELEPATHY_ENABLED);
  if (raw) {
    return /^(1|true|yes|on)$/i.test(raw);
  }

  return trimToNull(env.TELEPATHY_PORT) !== null;
}

function resolveTelepathyHost(env: NodeJS.ProcessEnv = process.env): string {
  return trimToNull(env.TELEPATHY_HOST) ?? DEFAULT_TELEPATHY_HOST;
}

function resolveTelepathyPort(env: NodeJS.ProcessEnv = process.env): number {
  return readPort(trimToNull(env.TELEPATHY_PORT));
}

function resolveTelepathyPath(env: NodeJS.ProcessEnv = process.env): string {
  return normalizePath(trimToNull(env.TELEPATHY_PATH) ?? DEFAULT_TELEPATHY_PATH);
}

export class TelepathyHub {
  private readonly host: string;
  private onContextSubmit: TelepathyContextSubmitHandler | null;
  private readonly path: string;
  private readonly port: number;
  private readonly store: TelepathyDeviceStore;
  private readonly devices = new Map<string, ConnectedDevice>();
  private readonly pending = new Map<string, PendingScreenshotRequest>();

  private server: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(options: TelepathyHubOptions) {
    const env = options.env ?? process.env;
    this.host = options.host ?? resolveTelepathyHost(env);
    this.onContextSubmit = options.onContextSubmit ?? null;
    this.path = options.path ? normalizePath(options.path) : resolveTelepathyPath(env);
    this.port = options.port ?? resolveTelepathyPort(env);
    this.store = options.store;
  }

  get url(): string {
    return `ws://${this.host}:${this.port}${this.path}`;
  }

  get boundPort(): number {
    const address = this.server?.address();
    return typeof address === "object" && address !== null
      ? (address as AddressInfo).port
      : this.port;
  }

  setContextSubmitHandler(handler: TelepathyContextSubmitHandler | null): void {
    this.onContextSubmit = handler;
  }

  listConnectedDevices(agentKey?: string): readonly TelepathyConnectedDeviceInfo[] {
    return [...this.devices.values()]
      .filter((device) => !agentKey || device.agentKey === agentKey)
      .map((device) => ({
        agentKey: device.agentKey,
        deviceId: device.deviceId,
        ...(device.label ? {label: device.label} : {}),
        connectedAt: device.connectedAt,
        lastSeenAt: device.lastSeenAt,
      }));
  }

  async start(): Promise<void> {
    if (this.server && this.wsServer) {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = null;
      });
    }

    await this.startPromise;
  }

  async requestScreenshot(input: {
    agentKey: string;
    deviceId: string;
    timeoutMs?: number;
    connectWaitMs?: number;
  }): Promise<TelepathyScreenshotCapture> {
    await this.start();

    const deviceKey = buildDeviceKey(input.agentKey, input.deviceId);
    const device = await this.waitForConnectedDevice(
      input.agentKey,
      input.deviceId,
      input.connectWaitMs ?? DEFAULT_TELEPATHY_DEVICE_WAIT_MS,
    );
    if (!device) {
      throw new ToolError(`Telepathy device ${input.deviceId} is not connected for agent ${input.agentKey}.`);
    }
    const registeredDevice = await this.store.getDevice(input.agentKey, input.deviceId);
    if (!registeredDevice.enabled || registeredDevice.tokenHash !== device.authenticatedTokenHash) {
      this.devices.delete(deviceKey);
      this.rejectPendingForDevice(device.agentKey, device.deviceId, "Telepathy device credentials changed.");
      void closeSocket(device.socket, RECEIVER_CLOSE_CODE_TRY_AGAIN, "Telepathy device credentials changed");
      throw new ToolError(`Telepathy device ${input.deviceId} is no longer authorized for agent ${input.agentKey}.`);
    }

    const requestId = randomUUID();
    const timeoutMs = Math.max(100, Math.floor(input.timeoutMs ?? DEFAULT_TELEPATHY_TIMEOUT_MS));

    return await new Promise<TelepathyScreenshotCapture>(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ToolError(`Telepathy screenshot from ${input.deviceId} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timeout.unref();

      this.pending.set(requestId, {
        agentKey: input.agentKey,
        deviceId: input.deviceId,
        timeout,
        resolve,
        reject,
      });

      try {
        await sendJson(device.socket, {
          type: "screenshot.request",
          requestId,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private async waitForConnectedDevice(
    agentKey: string,
    deviceId: string,
    timeoutMs: number,
  ): Promise<ConnectedDevice | null> {
    const deviceKey = buildDeviceKey(agentKey, deviceId);
    const existingDevice = this.devices.get(deviceKey);
    if (existingDevice) {
      return existingDevice;
    }

    const boundedTimeoutMs = Math.max(0, Math.floor(timeoutMs));
    if (boundedTimeoutMs === 0) {
      return null;
    }

    const deadline = Date.now() + boundedTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(DEVICE_WAIT_POLL_MS, deadline - Date.now()));
      });

      const device = this.devices.get(deviceKey);
      if (device) {
        return device;
      }
    }

    return null;
  }

  async close(): Promise<void> {
    const server = this.server;
    const wsServer = this.wsServer;
    this.server = null;
    this.wsServer = null;

    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new ToolError("Telepathy hub is shutting down."));
      this.pending.delete(requestId);
    }

    for (const device of this.devices.values()) {
      await closeSocket(device.socket, RECEIVER_CLOSE_CODE_TRY_AGAIN, "Telepathy hub shutting down");
    }
    this.devices.clear();

    if (wsServer) {
      await new Promise<void>((resolve, reject) => {
        wsServer.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }).catch(() => {});
    }

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }).catch(() => {});
    }
  }

  private async startInternal(): Promise<void> {
    await this.store.clearConnectedStates();

    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url) {
        const pathname = new URL(request.url, "http://telepathy.local").pathname;
        if (pathname === "/health") {
          const body = JSON.stringify({
            ok: true,
            devices: this.listConnectedDevices().length,
          });
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          });
          response.end(body);
          return;
        }
      }

      response.writeHead(404);
      response.end();
    });

    const wsServer = new WebSocketServer({noServer: true});
    server.on("upgrade", (request, socket, head) => {
      if (!isUpgradeRequestForPath(request, this.path)) {
        socket.destroy();
        return;
      }

      wsServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wsServer.emit("connection", ws, request);
      });
    });
    wsServer.on("connection", (socket: WebSocket) => {
      this.attachSocket(socket);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.wsServer = wsServer;
  }

  private attachSocket(socket: WebSocket): void {
    let currentKey: string | null = null;

    socket.on("message", async (rawMessage: WebSocket.RawData) => {
      let message: TelepathyReceiverMessage;
      try {
        message = parseTelepathyReceiverMessage(safeJsonParse(rawMessage));
      } catch (error) {
        await closeSocket(
          socket,
          RECEIVER_CLOSE_CODE_POLICY_VIOLATION,
          error instanceof Error ? error.message : "Invalid telepathy message",
        );
        return;
      }

      if (message.type === "device.hello") {
        let registeredDevice;
        try {
          registeredDevice = await this.store.getDevice(message.agentKey, message.deviceId);
        } catch {
          await closeSocket(socket, RECEIVER_CLOSE_CODE_POLICY_VIOLATION, "Unknown telepathy device");
          return;
        }

        if (!registeredDevice.enabled || !telepathyTokenMatches(message.token, registeredDevice.tokenHash)) {
          await closeSocket(socket, RECEIVER_CLOSE_CODE_POLICY_VIOLATION, "Invalid telepathy token");
          return;
        }

        const deviceKey = buildDeviceKey(message.agentKey, message.deviceId);
        const existing = this.devices.get(deviceKey);
        if (existing && existing.socket !== socket) {
          this.rejectPendingForDevice(existing.agentKey, existing.deviceId, "Telepathy device reconnected.");
          void closeSocket(existing.socket, RECEIVER_CLOSE_CODE_TRY_AGAIN, "Telepathy device replaced");
        }

        currentKey = deviceKey;
        const storedDevice = await this.store.markConnected(message.agentKey, message.deviceId, message.label);
        this.devices.set(deviceKey, {
          agentKey: storedDevice.agentKey,
          deviceId: storedDevice.deviceId,
          ...(storedDevice.label ? {label: storedDevice.label} : {}),
          authenticatedTokenHash: storedDevice.tokenHash,
          socket,
          connectedAt: storedDevice.connectedAt ?? Date.now(),
          lastSeenAt: storedDevice.lastSeenAt ?? Date.now(),
        });
        await sendJson(socket, {
          type: "device.ready",
          agentKey: message.agentKey,
          deviceId: message.deviceId,
        });
        return;
      }

      if (!currentKey) {
        await closeSocket(socket, RECEIVER_CLOSE_CODE_POLICY_VIOLATION, "Telepathy hello required first");
        return;
      }

      const device = this.devices.get(currentKey);
      if (!device || device.socket !== socket) {
        await closeSocket(socket, RECEIVER_CLOSE_CODE_TRY_AGAIN, "Telepathy device is no longer active");
        return;
      }
      device.lastSeenAt = Date.now();
      await this.store.touchLastSeen(device.agentKey, device.deviceId);

      if (message.type === "context.submit") {
        await this.handleContextSubmit(device, message, socket);
        return;
      }

      this.handleScreenshotResult(device, message);
    });

    socket.on("close", () => {
      if (!currentKey) {
        return;
      }

      const device = this.devices.get(currentKey);
      if (!device || device.socket !== socket) {
        return;
      }

      this.devices.delete(currentKey);
      void this.store.markDisconnected(device.agentKey, device.deviceId);
      this.rejectPendingForDevice(device.agentKey, device.deviceId, "Telepathy device disconnected.");
    });

    socket.on("error", () => {
      // Close handling does the real cleanup.
    });
  }

  private async handleContextSubmit(
    device: ConnectedDevice,
    message: TelepathyContextSubmit,
    socket: WebSocket,
  ): Promise<void> {
    if (!this.onContextSubmit) {
      await sendJson(socket, {
        type: "request.error",
        requestId: message.requestId,
        error: "Telepathy context submit is not configured on the server.",
      });
      return;
    }

    try {
      await this.onContextSubmit({
        agentKey: device.agentKey,
        deviceId: device.deviceId,
        ...(device.label ? {label: device.label} : {}),
        requestId: message.requestId,
        mode: message.mode,
        items: message.items,
        ...(message.metadata ? {metadata: message.metadata} : {}),
      });
      await sendJson(socket, {
        type: "context.accepted",
        requestId: message.requestId,
      });
    } catch (error) {
      await sendJson(socket, {
        type: "request.error",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : "Telepathy context submit failed.",
      });
    }
  }

  private handleScreenshotResult(device: ConnectedDevice, message: TelepathyScreenshotResult): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }

    if (pending.agentKey !== device.agentKey || pending.deviceId !== device.deviceId) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);

    if (!message.ok) {
      pending.reject(new ToolError(message.error));
      return;
    }

    pending.resolve({
      deviceId: device.deviceId,
      ...(device.label ? {label: device.label} : {}),
      mimeType: message.mimeType,
      data: message.data,
      ...(message.bytes !== undefined ? {bytes: message.bytes} : {}),
    });
  }

  private rejectPendingForDevice(agentKey: string, deviceId: string, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.agentKey !== agentKey || pending.deviceId !== deviceId) {
        continue;
      }

      clearTimeout(pending.timeout);
      pending.reject(new ToolError(reason));
      this.pending.delete(requestId);
    }
  }
}
