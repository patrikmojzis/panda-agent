import type {IncomingMessage} from "node:http";

import {
  GatewayDeviceCommandError,
  type PostgresGatewayStore,
} from "../../domain/gateway/postgres.js";
import {
  parseGatewayDeviceCommandKind,
} from "../../domain/gateway/postgres-rows.js";
import type {GatewayDeviceCommandKind} from "../../domain/gateway/types.js";
import {requireJsonValue, type JsonValue} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull, truncateText} from "../../lib/strings.js";
import {allowedCommandKindsForDevice, requireDeviceCapability, requireGatewayDevicePrincipal} from "./device-auth.js";
import {GatewayHttpError, readGatewayJsonBody} from "./http-body.js";

const COMMAND_BODY_MAX_BYTES = 64 * 1024;
const COMMAND_POLL_INTERVAL_MS = 250;
const COMMAND_ERROR_MAX_CHARS = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DeviceCommandHttpResult = {status: 200; body: unknown};

function mapDeviceCommandError(error: unknown): never {
  if (error instanceof GatewayDeviceCommandError) {
    const statusCode = error.reason === "bad_request"
      ? 400
      : error.reason === "forbidden"
        ? 403
        : error.reason === "not_found"
          ? 404
          : 409;
    throw new GatewayHttpError(statusCode, error.message);
  }
  throw error;
}

async function withCommandErrorMapping<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    mapDeviceCommandError(error);
  }
}

async function readCommandBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readGatewayJsonBody(request, COMMAND_BODY_MAX_BYTES);
  if (!isRecord(body)) {
    throw new GatewayHttpError(400, "Command request body must be an object.");
  }
  return body;
}

function parseWaitMs(value: unknown, maxWaitMs: number): number {
  if (value === undefined || value === null) {
    return maxWaitMs;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new GatewayHttpError(400, "waitMs must be a non-negative integer.");
  }
  if (value < 0) {
    throw new GatewayHttpError(400, "waitMs must be non-negative.");
  }
  return Math.min(maxWaitMs, value);
}

function requireCommandUuid(value: string): string {
  const trimmed = trimToNull(value);
  if (!trimmed || !UUID_PATTERN.test(trimmed)) {
    throw new GatewayHttpError(400, "Command id must be a UUID.");
  }
  return trimmed;
}

function parseOptionalAttachmentId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new GatewayHttpError(400, "resultAttachmentId must be a UUID.");
  }
  return value.trim();
}

function parseClaimId(value: unknown): string {
  const claimId = trimToNull(value);
  if (!claimId) {
    throw new GatewayHttpError(400, "claimId is required.");
  }
  return claimId;
}

function parseResult(value: unknown, present: boolean): JsonValue | undefined {
  return present ? requireJsonValue(value, "Command result") : undefined;
}

function parseFailureStatus(value: unknown): "failed" | "rejected" {
  if (value === undefined || value === null) {
    return "failed";
  }
  if (value === "failed" || value === "rejected") {
    return value;
  }
  throw new GatewayHttpError(400, "Command failure status must be failed or rejected.");
}

function parseFailureError(value: unknown): string {
  const message = trimToNull(value) ?? "Command failed.";
  return truncateText(message, COMMAND_ERROR_MAX_CHARS);
}

function parseRequestedKinds(input: {
  allowedKinds: readonly GatewayDeviceCommandKind[];
  value: unknown;
}): readonly GatewayDeviceCommandKind[] {
  if (input.value === undefined || input.value === null) {
    return input.allowedKinds;
  }
  if (!Array.isArray(input.value) || input.value.length === 0) {
    throw new GatewayHttpError(400, "kinds must contain at least one command kind.");
  }

  const requested: GatewayDeviceCommandKind[] = [];
  for (const entry of input.value) {
    if (typeof entry !== "string") {
      throw new GatewayHttpError(400, "kinds entries must be strings.");
    }
    let kind: GatewayDeviceCommandKind;
    try {
      kind = parseGatewayDeviceCommandKind(entry);
    } catch {
      throw new GatewayHttpError(400, `Unknown command kind ${entry}.`);
    }
    if (!input.allowedKinds.includes(kind)) {
      throw new GatewayHttpError(403, `Device token is missing the ${kind} capability.`);
    }
    if (!requested.includes(kind)) {
      requested.push(kind);
    }
  }
  return requested;
}

function formatClaimedCommand(command: {
  id: string;
  kind: GatewayDeviceCommandKind;
  payload?: JsonValue;
  claimId?: string;
  createdAt: number;
}): {
  id: string;
  kind: GatewayDeviceCommandKind;
  payload: JsonValue;
  claimId: string;
  createdAt: string;
} {
  if (!command.claimId) {
    throw new GatewayHttpError(500, "Claimed command is missing claim id.");
  }
  return {
    id: command.id,
    kind: command.kind,
    payload: command.payload ?? {},
    claimId: command.claimId,
    createdAt: new Date(command.createdAt).toISOString(),
  };
}

function requestAborted(request: IncomingMessage): boolean {
  return (request as {aborted?: boolean}).aborted === true;
}

async function waitForNextPoll(request: IncomingMessage, waitMs: number): Promise<void> {
  if (waitMs <= 0 || requestAborted(request)) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, waitMs);
    const onAborted = () => done();
    function done(): void {
      clearTimeout(timer);
      request.off("aborted", onAborted);
      resolve();
    }
    request.once("aborted", onAborted);
  });
}

async function claimWithOptionalWait(input: {
  allowedKinds: readonly GatewayDeviceCommandKind[];
  deviceId: string;
  maxWaitMs: number;
  request: IncomingMessage;
  sourceId: string;
  store: PostgresGatewayStore;
}): Promise<DeviceCommandHttpResult> {
  const body = await readCommandBody(input.request);
  const waitMs = parseWaitMs(body.waitMs, input.maxWaitMs);
  const requestedKinds = parseRequestedKinds({allowedKinds: input.allowedKinds, value: body.kinds});
  const deadline = Date.now() + waitMs;

  while (true) {
    const claimed = await withCommandErrorMapping(() => input.store.claimNextDeviceCommand({
      sourceId: input.sourceId,
      deviceId: input.deviceId,
      allowedKinds: requestedKinds,
    }));
    if (claimed.claimed) {
      return {
        status: 200,
        body: {
          ok: true,
          claimed: true,
          command: formatClaimedCommand(claimed.command),
        },
      };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || requestAborted(input.request)) {
      return {status: 200, body: {ok: true, claimed: false}};
    }
    await waitForNextPoll(input.request, Math.min(COMMAND_POLL_INTERVAL_MS, remainingMs));
  }
}

export async function acceptGatewayDeviceCommandRequest(input: {
  attachmentRetentionMs: number;
  maxWaitMs: number;
  request: IncomingMessage;
  requestUrl: URL;
  store: PostgresGatewayStore;
}): Promise<DeviceCommandHttpResult | null> {
  if (input.request.method !== "POST") {
    return null;
  }

  const principal = await (async () => {
    if (
      input.requestUrl.pathname === "/v1/device/heartbeat"
      || input.requestUrl.pathname === "/v1/device/commands/claim"
      || /^\/v1\/device\/commands\/[^/]+\/(heartbeat|complete|fail)$/.test(input.requestUrl.pathname)
    ) {
      return requireGatewayDevicePrincipal({request: input.request, store: input.store});
    }
    return null;
  })();
  if (!principal) {
    return null;
  }

  if (input.requestUrl.pathname === "/v1/device/heartbeat") {
    await readCommandBody(input.request);
    return {
      status: 200,
      body: {
        ok: true,
        sourceId: principal.source.sourceId,
        deviceId: principal.device.deviceId,
        seenAt: new Date().toISOString(),
      },
    };
  }

  requireDeviceCapability(principal.device, "claim_commands");
  const allowedKinds = allowedCommandKindsForDevice(principal.device);
  if (allowedKinds.length === 0) {
    throw new GatewayHttpError(403, "Device token is missing a command kind capability.");
  }

  if (input.requestUrl.pathname === "/v1/device/commands/claim") {
    return claimWithOptionalWait({
      allowedKinds,
      deviceId: principal.device.deviceId,
      maxWaitMs: Math.max(0, Math.floor(input.maxWaitMs)),
      request: input.request,
      sourceId: principal.source.sourceId,
      store: input.store,
    });
  }

  const match = /^\/v1\/device\/commands\/([^/]+)\/(heartbeat|complete|fail)$/.exec(input.requestUrl.pathname);
  if (!match) {
    return null;
  }

  const commandId = requireCommandUuid(match[1] ?? "");
  const action = match[2];
  const body = await readCommandBody(input.request);
  const claimId = parseClaimId(body.claimId);

  if (action === "heartbeat") {
    const command = await withCommandErrorMapping(() => input.store.heartbeatDeviceCommand({
      sourceId: principal.source.sourceId,
      deviceId: principal.device.deviceId,
      commandId,
      claimId,
      allowedKinds,
    }));
    return {status: 200, body: {ok: true, commandId: command.id, status: command.status}};
  }

  if (action === "complete") {
    const command = await withCommandErrorMapping(() => input.store.completeDeviceCommand({
      sourceId: principal.source.sourceId,
      deviceId: principal.device.deviceId,
      commandId,
      claimId,
      allowedKinds,
      result: parseResult(body.result, Object.hasOwn(body, "result")),
      resultAttachmentId: parseOptionalAttachmentId(body.resultAttachmentId),
      attachmentRetentionMs: input.attachmentRetentionMs,
    }));
    return {status: 200, body: {ok: true, commandId: command.id, status: command.status}};
  }

  if (action === "fail") {
    const command = await withCommandErrorMapping(() => input.store.failDeviceCommand({
      sourceId: principal.source.sourceId,
      deviceId: principal.device.deviceId,
      commandId,
      claimId,
      allowedKinds,
      status: parseFailureStatus(body.status),
      error: parseFailureError(body.error),
    }));
    return {status: 200, body: {ok: true, commandId: command.id, status: command.status}};
  }

  return null;
}
