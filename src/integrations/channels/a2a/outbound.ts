import {basename, extname} from "node:path";
import {readFile} from "node:fs/promises";

import type {JsonValue} from "../../../kernel/agent/types.js";
import type {
    ChannelOutboundAdapter,
    FileSystemMediaStore,
    OutboundRequest,
    OutboundResult,
    OutboundSentItem
} from "../../../domain/channels/index.js";
import type {
    A2AMessageItem,
    A2AMessageRequestPayload,
    A2ASenderEnvironmentSnapshot,
    RuntimeRequestRepo
} from "../../../domain/threads/requests/index.js";
import type {ExecutionEnvironmentKind} from "../../../domain/execution-environments/index.js";
import {requireA2AString} from "../../../domain/a2a/shared.js";
import type {SessionStore} from "../../../domain/sessions/index.js";
import {A2A_CONNECTOR_KEY, A2A_SOURCE} from "./config.js";

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);

interface A2ADeliveryMetadata {
  a2a: {
    messageId: string;
    fromAgentKey: string;
    fromSessionId: string;
    fromThreadId: string;
    fromRunId?: string | null;
    toAgentKey: string;
    toSessionId: string;
    sentAt: number;
    senderEnvironment?: A2ASenderEnvironmentSnapshot;
  };
}

export interface CreateA2AOutboundAdapterOptions {
  requests: RuntimeRequestRepo;
  sessionStore: SessionStore;
  createMediaStore(rootDir: string): FileSystemMediaStore;
  resolveAgentMediaDir(agentKey: string): string;
}

const requireTrimmed = requireA2AString;

const EXECUTION_ENVIRONMENT_KINDS = new Set<ExecutionEnvironmentKind>([
  "persistent_agent_runner",
  "disposable_container",
  "local",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOptionalTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function readPathHints(value: unknown): A2ASenderEnvironmentSnapshot["parentRunnerPaths"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const root = readOptionalTrimmedString(value, "root");
  const workspace = readOptionalTrimmedString(value, "workspace");
  const inbox = readOptionalTrimmedString(value, "inbox");
  const artifacts = readOptionalTrimmedString(value, "artifacts");
  const hints = {
    ...(root ? {root} : {}),
    ...(workspace ? {workspace} : {}),
    ...(inbox ? {inbox} : {}),
    ...(artifacts ? {artifacts} : {}),
  };

  return Object.keys(hints).length === 0 ? undefined : hints;
}

function readSenderEnvironment(value: unknown): A2ASenderEnvironmentSnapshot | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("A2A sender environment metadata must be an object.");
  }

  const id = requireTrimmed("sender environment id", readOptionalTrimmedString(value, "id"));
  const kind = requireTrimmed("sender environment kind", readOptionalTrimmedString(value, "kind"));
  if (!EXECUTION_ENVIRONMENT_KINDS.has(kind as ExecutionEnvironmentKind)) {
    throw new Error(`Unsupported A2A sender environment kind ${kind}.`);
  }

  const envDir = readOptionalTrimmedString(value, "envDir");
  const parentRunnerPaths = readPathHints(value.parentRunnerPaths);
  const workerPaths = readPathHints(value.workerPaths);

  return {
    id,
    kind: kind as ExecutionEnvironmentKind,
    ...(envDir ? {envDir} : {}),
    ...(parentRunnerPaths ? {parentRunnerPaths} : {}),
    ...(workerPaths ? {workerPaths} : {}),
  };
}

function requireMetadata(value: JsonValue | undefined): A2ADeliveryMetadata["a2a"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A2A delivery metadata is missing.");
  }

  const root = value as Record<string, unknown>;
  if (!root.a2a || typeof root.a2a !== "object" || Array.isArray(root.a2a)) {
    throw new Error("A2A delivery metadata is missing the a2a payload.");
  }

  const a2a = root.a2a as Record<string, unknown>;
  const messageId = requireTrimmed("message id", typeof a2a.messageId === "string" ? a2a.messageId : undefined);
  const fromAgentKey = requireTrimmed("from agent key", typeof a2a.fromAgentKey === "string" ? a2a.fromAgentKey : undefined);
  const fromSessionId = requireTrimmed("from session id", typeof a2a.fromSessionId === "string" ? a2a.fromSessionId : undefined);
  const fromThreadId = requireTrimmed("from thread id", typeof a2a.fromThreadId === "string" ? a2a.fromThreadId : undefined);
  const toAgentKey = requireTrimmed("to agent key", typeof a2a.toAgentKey === "string" ? a2a.toAgentKey : undefined);
  const toSessionId = requireTrimmed("to session id", typeof a2a.toSessionId === "string" ? a2a.toSessionId : undefined);
  const sentAt = typeof a2a.sentAt === "number" && Number.isFinite(a2a.sentAt) ? a2a.sentAt : Date.now();
  const senderEnvironment = readSenderEnvironment(a2a.senderEnvironment);

  return {
    messageId,
    fromAgentKey,
    fromSessionId,
    fromThreadId,
    fromRunId: typeof a2a.fromRunId === "string" && a2a.fromRunId.trim() ? a2a.fromRunId : undefined,
    toAgentKey,
    toSessionId,
    sentAt,
    ...(senderEnvironment ? {senderEnvironment} : {}),
  };
}

function inferImageMimeType(filePath: string): string {
  const mimeType = IMAGE_MIME_BY_EXTENSION.get(extname(filePath).toLowerCase());
  if (!mimeType) {
    throw new Error(`Unsupported image extension for A2A media: ${filePath}`);
  }

  return mimeType;
}

async function buildInboundItems(
  request: OutboundRequest,
  mediaStore: FileSystemMediaStore,
): Promise<readonly A2AMessageItem[]> {
  const items: A2AMessageItem[] = [];

  for (const item of request.items) {
    switch (item.type) {
      case "text":
        items.push({
          type: "text",
          text: item.text,
        });
        break;
      case "image": {
        const bytes = await readFile(item.path);
        const media = await mediaStore.writeMedia({
          bytes,
          source: A2A_SOURCE,
          connectorKey: A2A_CONNECTOR_KEY,
          mimeType: inferImageMimeType(item.path),
          hintFilename: basename(item.path),
        });
        items.push({
          type: "image",
          media,
          caption: item.caption,
        });
        break;
      }
      case "file": {
        const bytes = await readFile(item.path);
        const filename = item.filename?.trim() || basename(item.path);
        const media = await mediaStore.writeMedia({
          bytes,
          source: A2A_SOURCE,
          connectorKey: A2A_CONNECTOR_KEY,
          mimeType: item.mimeType?.trim() || "application/octet-stream",
          hintFilename: filename,
        });
        items.push({
          type: "file",
          media,
          filename,
          caption: item.caption,
          mimeType: item.mimeType,
        });
        break;
      }
    }
  }

  return items;
}

function sentItem(type: OutboundSentItem["type"], externalMessageId: string): OutboundSentItem {
  return {
    type,
    externalMessageId,
  };
}

export function createA2AOutboundAdapter(
  options: CreateA2AOutboundAdapterOptions,
): ChannelOutboundAdapter {
  return {
    channel: A2A_SOURCE,
    async send(request: OutboundRequest): Promise<OutboundResult> {
      requireTrimmed("connector key", request.target.connectorKey);
      if (request.target.connectorKey !== A2A_CONNECTOR_KEY) {
        throw new Error(`A2A outbound requires connector key ${A2A_CONNECTOR_KEY}.`);
      }

      const a2a = requireMetadata(request.metadata);
      const session = await options.sessionStore.getSession(a2a.toSessionId);
      if (session.agentKey !== a2a.toAgentKey) {
        throw new Error(`A2A recipient session ${a2a.toSessionId} belongs to ${session.agentKey}, not ${a2a.toAgentKey}.`);
      }

      const mediaStore = options.createMediaStore(options.resolveAgentMediaDir(session.agentKey));
      const items = await buildInboundItems(request, mediaStore);
      const payload: A2AMessageRequestPayload = {
        connectorKey: A2A_CONNECTOR_KEY,
        externalMessageId: a2a.messageId,
        fromAgentKey: a2a.fromAgentKey,
        fromSessionId: a2a.fromSessionId,
        fromThreadId: a2a.fromThreadId,
        ...(a2a.fromRunId ? {fromRunId: a2a.fromRunId} : {}),
        toAgentKey: a2a.toAgentKey,
        toSessionId: a2a.toSessionId,
        sentAt: a2a.sentAt,
        ...(a2a.senderEnvironment ? {senderEnvironment: a2a.senderEnvironment} : {}),
        items,
      };

      await options.requests.enqueueRequest({
        kind: "a2a_message",
        payload,
      });

      return {
        ok: true,
        channel: request.channel,
        target: request.target,
        sent: request.items.map((item) => sentItem(item.type, a2a.messageId)),
      };
    },
  };
}
