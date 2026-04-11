import type {ThinkingLevel} from "@mariozechner/pi-ai";

import type {AgentRecord} from "../../domain/agents/index.js";
import {createPandaClient} from "../../app/runtime/client.js";
import type {
    InferenceProjection,
    ThreadRecord,
    ThreadSummaryRecord,
    ThreadUpdate
} from "../../domain/threads/runtime/index.js";
import type {ThreadRuntimeNotification} from "../../domain/threads/runtime/postgres.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {IdentityRecord} from "../../domain/identity/index.js";

export interface ChatRuntimeOptions {
  model?: string;
  identity?: string;
  agent?: string;
  dbUrl?: string;
  tablePrefix?: string;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}

export interface CreateChatThreadOptions {
  id?: string;
  agentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
}

export interface ChatRuntimeServices {
  identity: IdentityRecord;
  store: ThreadRuntimeStore;
  getAgent(agentKey: string): Promise<AgentRecord>;
  createThread(options?: CreateChatThreadOptions): Promise<ThreadRecord>;
  resolveOrCreateHomeThread(options?: CreateChatThreadOptions): Promise<ThreadRecord>;
  resetHomeThread(options?: Omit<CreateChatThreadOptions, "id">): Promise<ThreadRecord>;
  getThread(threadId: string): Promise<ThreadRecord>;
  listThreadSummaries(limit?: number): Promise<readonly ThreadSummaryRecord[]>;
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

export async function createChatRuntime(options: ChatRuntimeOptions): Promise<ChatRuntimeServices> {
  const client = await createPandaClient({
    identity: options.identity,
    dbUrl: options.dbUrl,
    tablePrefix: options.tablePrefix,
    onStoreNotification: options.onStoreNotification,
  });

  const applyDefaults = (threadOptions: CreateChatThreadOptions = {}): CreateChatThreadOptions => {
    return {
      id: threadOptions.id,
      agentKey: trimNonEmptyString(threadOptions.agentKey) ?? trimNonEmptyString(options.agent),
      model: threadOptions.model ?? options.model,
      thinking: threadOptions.thinking,
      ...(threadOptions.inferenceProjection ? {inferenceProjection: threadOptions.inferenceProjection} : {}),
    };
  };

  return {
    identity: client.identity,
    store: client.store,
    getAgent: (agentKey) => client.getAgent(agentKey),
    createThread: (threadOptions) => client.createThread(applyDefaults(threadOptions)),
    resolveOrCreateHomeThread: (threadOptions) => client.resolveOrCreateHomeThread(applyDefaults(threadOptions)),
    resetHomeThread: (threadOptions) => client.resetHomeThread({
      agentKey: trimNonEmptyString(threadOptions?.agentKey) ?? trimNonEmptyString(options.agent),
      model: threadOptions?.model ?? options.model,
      thinking: threadOptions?.thinking,
      ...(threadOptions?.inferenceProjection ? {inferenceProjection: threadOptions.inferenceProjection} : {}),
    }),
    getThread: (threadId) => client.getThread(threadId),
    listThreadSummaries: (limit = 20) => client.listThreadSummaries(limit),
    submitTextInput: (input) => client.submitTextInput(input),
    abortThread: (threadId, reason) => client.abortThread(threadId, reason),
    waitForCurrentRun: (threadId, timeoutMs) => client.waitForCurrentRun(threadId, timeoutMs),
    updateThread: (threadId, update) => client.updateThread(threadId, update),
    compactThread: (threadId, customInstructions) => client.compactThread(threadId, customInstructions),
    close: client.close,
  };
}
