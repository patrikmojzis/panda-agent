import type {IncomingMessage} from "node:http";

import type {WebSocket} from "ws";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {isLoopbackHttpHostname} from "../../lib/http.js";
import type {TelepathyReceiverMessage, TelepathyServerMessage} from "./protocol.js";
import {parseTelepathyReceiverMessage} from "./protocol.js";
import {TELEPATHY_MAX_WEBSOCKET_PAYLOAD_BYTES} from "./protocol.js";

const MESSAGE_RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 60;
const MAX_BYTES_PER_WINDOW = TELEPATHY_MAX_WEBSOCKET_PAYLOAD_BYTES * 2;

type RawSocketMessage = WebSocket.RawData;

export interface ParsedTelepathySocketReceiverMessage {
  message: TelepathyReceiverMessage;
  raw: unknown;
}

export function isTelepathyUpgradeRequestAllowed(
  request: Pick<IncomingMessage, "headers" | "url">,
  expectedPath: string,
): boolean {
  if (!request.url) {
    return false;
  }

  const pathname = new URL(request.url, "http://telepathy.local").pathname.replace(/\/+$/, "") || "/";
  const normalizedExpectedPath = expectedPath.replace(/\/+$/, "") || "/";
  if (pathname !== normalizedExpectedPath) {
    return false;
  }

  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  if (Array.isArray(origin)) {
    return false;
  }

  try {
    return isLoopbackHttpHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function rawMessageByteLength(message: RawSocketMessage): number {
  if (typeof message === "string") {
    return Buffer.byteLength(message, "utf8");
  }

  if (Array.isArray(message)) {
    return message.reduce((total, chunk) => total + chunk.byteLength, 0);
  }

  return message.byteLength;
}

export function createTelepathySocketBudget(): (message: RawSocketMessage) => string | null {
  let windowStartedAt = Date.now();
  let messageCount = 0;
  let byteCount = 0;

  return (message) => {
    const now = Date.now();
    if (now - windowStartedAt > MESSAGE_RATE_WINDOW_MS) {
      windowStartedAt = now;
      messageCount = 0;
      byteCount = 0;
    }

    const messageBytes = rawMessageByteLength(message);
    if (messageBytes > TELEPATHY_MAX_WEBSOCKET_PAYLOAD_BYTES) {
      return "Telepathy message is too large.";
    }

    messageCount += 1;
    byteCount += messageBytes;
    if (messageCount > MAX_MESSAGES_PER_WINDOW) {
      return "Telepathy message rate limit exceeded.";
    }

    if (byteCount > MAX_BYTES_PER_WINDOW) {
      return "Telepathy message byte rate limit exceeded.";
    }

    return null;
  };
}

function rawMessageToUtf8Text(message: RawSocketMessage): string {
  if (typeof message === "string") {
    return message;
  }

  if (Array.isArray(message)) {
    return Buffer.concat(message).toString("utf8");
  }

  if (Buffer.isBuffer(message)) {
    return message.toString("utf8");
  }

  return Buffer.from(new Uint8Array(message)).toString("utf8");
}

export function parseTelepathySocketJson(message: RawSocketMessage): unknown {
  const text = rawMessageToUtf8Text(message);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ToolError("Telepathy receiver sent invalid JSON.");
  }
}

export function parseTelepathySocketReceiverMessage(
  message: RawSocketMessage,
): ParsedTelepathySocketReceiverMessage {
  const raw = parseTelepathySocketJson(message);
  return {
    raw,
    message: parseTelepathyReceiverMessage(raw),
  };
}

export function sendTelepathySocketJson(socket: WebSocket, payload: TelepathyServerMessage): Promise<void> {
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

export function compactTelepathyCloseReason(reason: string): string {
  const maxBytes = 120;
  const bytes = Buffer.from(reason, "utf8");
  if (bytes.length <= maxBytes) {
    return reason;
  }

  return `${bytes.subarray(0, maxBytes - 3).toString("utf8").replace(/\uFFFD+$/u, "")}...`;
}

export async function closeTelepathySocket(socket: WebSocket, code: number, reason: string): Promise<void> {
  if (socket.readyState === socket.CLOSING || socket.readyState === socket.CLOSED) {
    return;
  }

  socket.close(code, compactTelepathyCloseReason(reason));
}
