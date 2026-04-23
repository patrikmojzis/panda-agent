import {randomUUID} from "node:crypto";

import {FileSystemMediaStore, type MediaDescriptor} from "../../domain/channels/index.js";
import {createSessionWithInitialThread, PostgresSessionStore, type SessionStore} from "../../domain/sessions/index.js";
import {PostgresThreadRuntimeStore, type ThreadRuntimeCoordinator, type ThreadRecord} from "../../domain/threads/runtime/index.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {stringToUserMessage} from "../../kernel/agent/index.js";
import type {DefaultAgentSessionContext} from "./panda-session-context.js";
import {resolveAgentMediaDir} from "./data-dir.js";
import type {Pool} from "pg";
import type {TelepathyContextSubmitInput} from "../../integrations/telepathy/hub.js";
import type {
  TelepathyContextAudioItem,
  TelepathyContextImageItem,
  TelepathyContextItem,
} from "../../integrations/telepathy/protocol.js";
import {buildTelepathyInboundMetadata, buildTelepathyInboundText} from "../../integrations/telepathy/helpers.js";
import {TELEPATHY_SOURCE} from "../../integrations/telepathy/config.js";

const EXTENSIONS_BY_MIME_TYPE = new Map<string, string>([
  ["audio/m4a", ".m4a"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/ogg", ".ogg"],
  ["audio/opus", ".opus"],
  ["audio/wav", ".wav"],
  ["audio/webm", ".webm"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);
const MAX_CONTEXT_MEDIA_BYTES = 24 * 1024 * 1024;

export interface TelepathyContextIngressOptions {
  coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
  env?: NodeJS.ProcessEnv;
  fallbackContext: Pick<DefaultAgentSessionContext, "cwd">;
  pool: Pool;
  sessionStore: SessionStore;
  store: ThreadRuntimeStore;
}

function inferExtension(mimeType: string): string {
  return EXTENSIONS_BY_MIME_TYPE.get(mimeType.toLowerCase()) ?? ".bin";
}

function buildHintFilename(
  item: TelepathyContextAudioItem | TelepathyContextImageItem,
  requestId: string,
  index: number,
): string {
  if (item.filename?.trim()) {
    return item.filename.trim();
  }

  return `${requestId}-${item.type}-${index + 1}${inferExtension(item.mimeType)}`;
}

function decodeContextMedia(item: TelepathyContextAudioItem | TelepathyContextImageItem): Buffer {
  const bytes = Buffer.from(item.data, "base64");
  if (item.bytes !== undefined && item.bytes !== bytes.length) {
    throw new Error(`Telepathy ${item.type} item declared ${item.bytes} bytes but decoded to ${bytes.length} bytes.`);
  }

  if (bytes.length > MAX_CONTEXT_MEDIA_BYTES) {
    throw new Error(`Telepathy ${item.type} item is too large (${bytes.length} bytes).`);
  }

  return bytes;
}

function buildInitialThreadInput(options: {
  sessionId: string;
  threadId: string;
  agentKey: string;
  fallbackContext: Pick<DefaultAgentSessionContext, "cwd">;
}): {
  id: string;
  sessionId: string;
  context: {
    cwd: string;
    agentKey: string;
    sessionId: string;
  };
} {
  return {
    id: options.threadId,
    sessionId: options.sessionId,
    context: {
      cwd: options.fallbackContext.cwd ?? process.cwd(),
      agentKey: options.agentKey,
      sessionId: options.sessionId,
    },
  };
}

async function ensureAgentMainThread(options: {
  agentKey: string;
  fallbackContext: Pick<DefaultAgentSessionContext, "cwd">;
  pool: Pool;
  sessionStore: SessionStore;
  store: ThreadRuntimeStore;
}): Promise<ThreadRecord> {
  const existing = await options.sessionStore.getMainSession(options.agentKey);
  if (existing) {
    return await options.store.getThread(existing.currentThreadId);
  }

  const sessionId = randomUUID();
  const threadId = randomUUID();
  if (
    options.sessionStore instanceof PostgresSessionStore
    && options.store instanceof PostgresThreadRuntimeStore
  ) {
    const created = await createSessionWithInitialThread({
      pool: options.pool,
      sessionStore: options.sessionStore,
      threadStore: options.store,
      session: {
        id: sessionId,
        agentKey: options.agentKey,
        kind: "main",
        currentThreadId: threadId,
      },
      thread: buildInitialThreadInput({
        sessionId,
        threadId,
        agentKey: options.agentKey,
        fallbackContext: options.fallbackContext,
      }),
    });
    return created.thread;
  }

  await options.sessionStore.createSession({
    id: sessionId,
    agentKey: options.agentKey,
    kind: "main",
    currentThreadId: threadId,
  });
  return await options.store.createThread(buildInitialThreadInput({
    sessionId,
    threadId,
    agentKey: options.agentKey,
    fallbackContext: options.fallbackContext,
  }));
}

async function persistContextItems(options: {
  agentKey: string;
  deviceId: string;
  requestId: string;
  mode: string;
  label?: string;
  metadata?: TelepathyContextSubmitInput["metadata"];
  items: readonly TelepathyContextItem[];
  env?: NodeJS.ProcessEnv;
}): Promise<{
  media: readonly MediaDescriptor[];
  textParts: readonly string[];
}> {
  const mediaStore = new FileSystemMediaStore({
    rootDir: resolveAgentMediaDir(options.agentKey, options.env),
  });
  const media: MediaDescriptor[] = [];
  const textParts: string[] = [];

  for (const [index, item] of options.items.entries()) {
    if (item.type === "text") {
      textParts.push(item.text);
      continue;
    }

    const bytes = decodeContextMedia(item);
    const descriptor = await mediaStore.writeMedia({
      bytes,
      source: TELEPATHY_SOURCE,
      connectorKey: options.deviceId,
      mimeType: item.mimeType,
      hintFilename: buildHintFilename(item, options.requestId, index),
      metadata: {
        requestId: options.requestId,
        deviceId: options.deviceId,
        agentKey: options.agentKey,
        label: options.label ?? null,
        mode: options.mode,
        itemType: item.type,
        itemIndex: index,
        frontmostApp: options.metadata?.frontmostApp ?? null,
        windowTitle: options.metadata?.windowTitle ?? null,
        trigger: options.metadata?.trigger ?? null,
      },
    });
    media.push(descriptor);
  }

  return {
    media,
    textParts,
  };
}

export class TelepathyContextIngress {
  private readonly coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fallbackContext: Pick<DefaultAgentSessionContext, "cwd">;
  private readonly pool: Pool;
  private readonly sessionStore: SessionStore;
  private readonly store: ThreadRuntimeStore;

  constructor(options: TelepathyContextIngressOptions) {
    this.coordinator = options.coordinator;
    this.env = options.env ?? process.env;
    this.fallbackContext = options.fallbackContext;
    this.pool = options.pool;
    this.sessionStore = options.sessionStore;
    this.store = options.store;
  }

  async ingest(input: TelepathyContextSubmitInput): Promise<void> {
    const thread = await ensureAgentMainThread({
      agentKey: input.agentKey,
      fallbackContext: this.fallbackContext,
      pool: this.pool,
      sessionStore: this.sessionStore,
      store: this.store,
    });
    const persisted = await persistContextItems({
      agentKey: input.agentKey,
      deviceId: input.deviceId,
      requestId: input.requestId,
      mode: input.mode,
      ...(input.label ? {label: input.label} : {}),
      ...(input.metadata ? {metadata: input.metadata} : {}),
      items: input.items,
      env: this.env,
    });
    const sentAt = new Date(input.metadata?.submittedAt ?? Date.now()).toISOString();
    const connectorKey = input.deviceId;

    await this.coordinator.submitInput(thread.id, {
      source: TELEPATHY_SOURCE,
      channelId: input.deviceId,
      externalMessageId: input.requestId,
      actorId: input.deviceId,
      message: stringToUserMessage(buildTelepathyInboundText({
        agentKey: input.agentKey,
        connectorKey,
        sentAt,
        externalConversationId: input.deviceId,
        externalActorId: input.deviceId,
        externalMessageId: input.requestId,
        deviceId: input.deviceId,
        deviceLabel: input.label,
        mode: input.mode,
        frontmostApp: input.metadata?.frontmostApp,
        windowTitle: input.metadata?.windowTitle,
        trigger: input.metadata?.trigger,
        textParts: persisted.textParts,
        media: persisted.media,
      })),
      metadata: buildTelepathyInboundMetadata({
        agentKey: input.agentKey,
        connectorKey,
        sentAt,
        externalConversationId: input.deviceId,
        externalActorId: input.deviceId,
        externalMessageId: input.requestId,
        deviceId: input.deviceId,
        deviceLabel: input.label,
        mode: input.mode,
        frontmostApp: input.metadata?.frontmostApp,
        windowTitle: input.metadata?.windowTitle,
        trigger: input.metadata?.trigger,
        media: persisted.media,
      }),
    });
  }
}
