import {randomUUID} from "node:crypto";
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";

import {WebSocketServer, type WebSocket} from "ws";

import type {TelepathyDeviceRecord} from "../../domain/telepathy/types.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {
  TelepathyContextItem,
  TelepathyContextSubmit,
  TelepathyReceiverMessage,
  TelepathyScreenshotResult,
} from "./protocol.js";
import {TELEPATHY_MAX_WEBSOCKET_PAYLOAD_BYTES, readTelepathyMessageRequestId} from "./protocol.js";
import {
  closeTelepathySocket,
  createTelepathySocketBudget,
  isTelepathyUpgradeRequestAllowed,
  parseTelepathySocketReceiverMessage,
  sendTelepathySocketJson,
} from "./websocket.js";
import {
  normalizeTelepathyPath,
  resolveTelepathyHost,
  resolveTelepathyPath,
  resolveTelepathyPort,
} from "./config.js";
import {
  acceptTelepathyDeviceHello,
  buildTelepathyDeviceKey,
  type ConnectedTelepathyDevice,
} from "./device-hello.js";

const DEFAULT_TELEPATHY_TIMEOUT_MS = 20_000;
const DEFAULT_TELEPATHY_DEVICE_WAIT_MS = 3_000;
const DEVICE_WAIT_POLL_MS = 100;
const RECEIVER_CLOSE_CODE_POLICY_VIOLATION = 1008;
const RECEIVER_CLOSE_CODE_TRY_AGAIN = 1013;

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
  store: TelepathyHubStore;
}

export interface TelepathyHubStore {
  clearConnectedStates(): Promise<void>;
  getDevice(agentKey: string, deviceId: string): Promise<TelepathyDeviceRecord>;
  markConnected(agentKey: string, deviceId: string, label?: string): Promise<TelepathyDeviceRecord>;
  markDisconnected(agentKey: string, deviceId: string): Promise<void>;
  touchLastSeen(agentKey: string, deviceId: string): Promise<void>;
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

export class TelepathyHub {
  private readonly host: string;
  private onContextSubmit: TelepathyContextSubmitHandler | null;
  private readonly path: string;
  private readonly port: number;
  private readonly store: TelepathyHubStore;
  private readonly devices = new Map<string, ConnectedTelepathyDevice>();
  private readonly pending = new Map<string, PendingScreenshotRequest>();

  private server: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(options: TelepathyHubOptions) {
    const env = options.env ?? process.env;
    this.host = options.host ?? resolveTelepathyHost(env);
    this.onContextSubmit = options.onContextSubmit ?? null;
    this.path = options.path ? normalizeTelepathyPath(options.path) : resolveTelepathyPath(env);
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

    const deviceKey = buildTelepathyDeviceKey(input.agentKey, input.deviceId);
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
      void closeTelepathySocket(device.socket, RECEIVER_CLOSE_CODE_TRY_AGAIN, "Telepathy device credentials changed");
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
        await sendTelepathySocketJson(device.socket, {
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
  ): Promise<ConnectedTelepathyDevice | null> {
    const deviceKey = buildTelepathyDeviceKey(agentKey, deviceId);
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
      await closeTelepathySocket(device.socket, RECEIVER_CLOSE_CODE_TRY_AGAIN, "Telepathy hub shutting down");
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

    const wsServer = new WebSocketServer({
      maxPayload: TELEPATHY_MAX_WEBSOCKET_PAYLOAD_BYTES,
      noServer: true,
    });
    server.on("upgrade", (request, socket, head) => {
      if (!isTelepathyUpgradeRequestAllowed(request, this.path)) {
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
    const consumeSocketBudget = createTelepathySocketBudget();

    socket.on("message", async (rawMessage: WebSocket.RawData) => {
      let message: TelepathyReceiverMessage;
      let parsedMessage: unknown;
      try {
        const budgetError = consumeSocketBudget(rawMessage);
        if (budgetError) {
          await closeTelepathySocket(socket, RECEIVER_CLOSE_CODE_POLICY_VIOLATION, budgetError);
          return;
        }

        const parsed = parseTelepathySocketReceiverMessage(rawMessage);
        parsedMessage = parsed.raw;
        message = parsed.message;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Invalid telepathy message";
        if (currentKey) {
          const requestId = readTelepathyMessageRequestId(parsedMessage);
          await sendTelepathySocketJson(socket, {
            type: "request.error",
            ...(requestId ? {requestId} : {}),
            error: errorMessage,
          });
          return;
        }

        await closeTelepathySocket(socket, RECEIVER_CLOSE_CODE_POLICY_VIOLATION, "Invalid telepathy message");
        return;
      }

      if (message.type === "device.hello") {
        const accepted = await acceptTelepathyDeviceHello({
          message,
          socket,
          store: this.store,
        });
        if (!accepted.ok) {
          await closeTelepathySocket(socket, RECEIVER_CLOSE_CODE_POLICY_VIOLATION, accepted.closeReason);
          return;
        }

        const existing = this.devices.get(accepted.deviceKey);
        if (existing && existing.socket !== socket) {
          this.rejectPendingForDevice(existing.agentKey, existing.deviceId, "Telepathy device reconnected.");
          void closeTelepathySocket(existing.socket, RECEIVER_CLOSE_CODE_TRY_AGAIN, "Telepathy device replaced");
        }

        currentKey = accepted.deviceKey;
        this.devices.set(accepted.deviceKey, accepted.device);
        await sendTelepathySocketJson(socket, {
          type: "device.ready",
          agentKey: message.agentKey,
          deviceId: message.deviceId,
        });
        return;
      }

      if (!currentKey) {
        await closeTelepathySocket(socket, RECEIVER_CLOSE_CODE_POLICY_VIOLATION, "Telepathy hello required first");
        return;
      }

      const device = this.devices.get(currentKey);
      if (!device || device.socket !== socket) {
        await closeTelepathySocket(socket, RECEIVER_CLOSE_CODE_TRY_AGAIN, "Telepathy device is no longer active");
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
    device: ConnectedTelepathyDevice,
    message: TelepathyContextSubmit,
    socket: WebSocket,
  ): Promise<void> {
    if (!this.onContextSubmit) {
      await sendTelepathySocketJson(socket, {
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
      await sendTelepathySocketJson(socket, {
        type: "context.accepted",
        requestId: message.requestId,
      });
    } catch (error) {
      await sendTelepathySocketJson(socket, {
        type: "request.error",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : "Telepathy context submit failed.",
      });
    }
  }

  private handleScreenshotResult(device: ConnectedTelepathyDevice, message: TelepathyScreenshotResult): void {
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
