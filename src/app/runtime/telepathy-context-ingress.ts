import {randomUUID} from "node:crypto";

import {FileSystemMediaStore} from "../../domain/channels/media-store.js";
import {createSessionWithInitialThread} from "../../domain/sessions/lifecycle.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {requireCurrentSessionThread, submitCurrentSessionInput} from "../../domain/sessions/current-thread.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import type {ThreadRecord} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import type {DefaultAgentSessionContext} from "./panda-session-context.js";
import {resolveAgentMediaDir} from "./data-dir.js";
import type {Pool} from "pg";
import type {TelepathyContextSubmitInput} from "../../integrations/telepathy/hub.js";
import {persistTelepathyContextItems} from "../../integrations/telepathy/context-media.js";
import {buildTelepathyInboundMetadata, buildTelepathyInboundText} from "../../integrations/telepathy/helpers.js";
import {TELEPATHY_SOURCE} from "../../integrations/telepathy/config.js";

interface TelepathyContextIngressOptions {
  coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
  env?: NodeJS.ProcessEnv;
  fallbackContext: Pick<DefaultAgentSessionContext, "cwd">;
  pool?: Pool;
  sessionStore: TelepathyContextSessionStore;
  store: TelepathyContextThreadStore;
}

type TelepathyContextSessionStore = Pick<SessionStore, "createSession" | "getMainSession" | "getSession">;
type TelepathyContextThreadStore = Pick<ThreadRuntimeStore, "createThread" | "getThread">;

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
  pool?: Pool;
  sessionStore: TelepathyContextSessionStore;
  store: TelepathyContextThreadStore;
}): Promise<ThreadRecord> {
  const existing = await options.sessionStore.getMainSession(options.agentKey);
  if (existing) {
    return options.store.getThread(requireCurrentSessionThread(existing).threadId);
  }

  const sessionId = randomUUID();
  const threadId = randomUUID();
  if (
    options.pool
    &&
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
  return options.store.createThread(buildInitialThreadInput({
    sessionId,
    threadId,
    agentKey: options.agentKey,
    fallbackContext: options.fallbackContext,
  }));
}

export class TelepathyContextIngress {
  private readonly coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fallbackContext: Pick<DefaultAgentSessionContext, "cwd">;
  private readonly pool?: Pool;
  private readonly sessionStore: TelepathyContextSessionStore;
  private readonly store: TelepathyContextThreadStore;

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
    const mediaStore = new FileSystemMediaStore({
      rootDir: resolveAgentMediaDir(input.agentKey, this.env),
    });
    const persisted = await persistTelepathyContextItems({
      agentKey: input.agentKey,
      deviceId: input.deviceId,
      requestId: input.requestId,
      mode: input.mode,
      ...(input.label ? {label: input.label} : {}),
      ...(input.metadata ? {metadata: input.metadata} : {}),
      items: input.items,
      mediaStore,
    });
    const sentAt = new Date(input.metadata?.submittedAt ?? Date.now()).toISOString();
    const connectorKey = input.deviceId;

    await submitCurrentSessionInput({
      sessions: this.sessionStore,
      sessionId: thread.sessionId,
      coordinator: this.coordinator,
      payload: {
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
      },
    });
  }
}
