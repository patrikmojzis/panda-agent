import type {ThinkingLevel} from "@mariozechner/pi-ai";

import {createRuntimeClient} from "../../app/runtime/client.js";
import type {InferenceProjection, ThreadRecord, ThreadUpdate} from "../../domain/threads/runtime/index.js";
import type {ThreadRuntimeNotification} from "../../domain/threads/runtime/postgres.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {IdentityRecord} from "../../domain/identity/index.js";
import type {SessionRecord} from "../../domain/sessions/index.js";

export interface ChatRuntimeOptions {
  model?: string;
  identity?: string;
  agent?: string;
  dbUrl?: string;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}

export interface CreateChatSessionOptions {
  sessionId?: string;
  agentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
}

export interface ChatRuntimeServices {
  identity: IdentityRecord;
  store: ThreadRuntimeStore;
  createBranchSession(options?: CreateChatSessionOptions): Promise<ThreadRecord>;
  openMainSession(options?: CreateChatSessionOptions): Promise<ThreadRecord>;
  resetSession(options?: CreateChatSessionOptions): Promise<ThreadRecord>;
  openSession(sessionId: string): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  resolveThreadRunConfig(threadId: string): Promise<{
    model: string;
    thinking?: ThinkingLevel;
  }>;
  listAgentSessions(agentKey: string): Promise<readonly SessionRecord[]>;
  submitTextInput(input: {
    threadId?: string;
    text: string;
    actorId: string;
    externalMessageId: string;
  }): Promise<{threadId: string}>;
  abortThread(threadId: string, reason?: string): Promise<boolean>;
  waitForCurrentRun(threadId: string, timeoutMs?: number): Promise<void>;
  updateThread(threadId: string, update: ThreadUpdate): Promise<ThreadRecord>;
  compactThread(threadId: string, customInstructions: string): Promise<{
    compacted: boolean;
    tokensBefore?: number;
    tokensAfter?: number;
  }>;
  close(): Promise<void>;
}

function trimNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function requireChatIdentityHandle(value: string | undefined): string {
  const identity = trimNonEmptyString(value);
  if (!identity) {
    throw new Error("Panda chat requires --identity <handle>. Create one with `panda identity create <handle>`.");
  }

  return identity;
}

export async function createChatRuntime(options: ChatRuntimeOptions): Promise<ChatRuntimeServices> {
  const client = await createRuntimeClient({
    identity: requireChatIdentityHandle(options.identity),
    dbUrl: options.dbUrl,
    onStoreNotification: options.onStoreNotification,
  });

  const applyDefaults = (sessionOptions: CreateChatSessionOptions = {}): CreateChatSessionOptions => {
    return {
      sessionId: sessionOptions.sessionId,
      agentKey: trimNonEmptyString(sessionOptions.agentKey) ?? trimNonEmptyString(options.agent),
      model: sessionOptions.model ?? options.model,
      thinking: sessionOptions.thinking,
      ...(sessionOptions.inferenceProjection ? {inferenceProjection: sessionOptions.inferenceProjection} : {}),
    };
  };

  return {
    identity: client.identity,
    store: client.store,
    createBranchSession: (sessionOptions) => client.createBranchSession(applyDefaults(sessionOptions)),
    openMainSession: (sessionOptions) => client.openMainSession(applyDefaults(sessionOptions)),
    resetSession: (sessionOptions) => client.resetSession(applyDefaults(sessionOptions)),
    openSession: (sessionId) => client.openSession(sessionId),
    getThread: (threadId) => client.getThread(threadId),
    resolveThreadRunConfig: (threadId) => client.resolveThreadRunConfig(threadId),
    listAgentSessions: (agentKey) => client.listAgentSessions(agentKey),
    submitTextInput: (input) => client.submitTextInput(input),
    abortThread: (threadId, reason) => client.abortThread(threadId, reason),
    waitForCurrentRun: (threadId, timeoutMs) => client.waitForCurrentRun(threadId, timeoutMs),
    updateThread: (threadId, update) => client.updateThread(threadId, update),
    compactThread: (threadId, customInstructions) => client.compactThread(threadId, customInstructions),
    close: client.close,
  };
}
