import type {ThinkingLevel} from "@mariozechner/pi-ai";

import type {Tool} from "../agent-core/tool.js";
import type {ProviderName} from "../agent-core/types.js";
import {createPandaClient} from "../panda/client.js";
import type {ThreadRecord, ThreadSummaryRecord, ThreadUpdate} from "../thread-runtime/index.js";
import type {ThreadRuntimeNotification} from "../thread-runtime/postgres.js";
import type {ThreadRuntimeStore} from "../thread-runtime/store.js";
import type {IdentityRecord} from "../identity/index.js";

export interface ChatRuntimeOptions {
  cwd: string;
  provider?: ProviderName;
  model?: string;
  identity?: string;
  agent?: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
  tablePrefix?: string;
  onStoreNotification?: (notification: ThreadRuntimeNotification) => Promise<void> | void;
}

export interface CreateChatThreadOptions {
  id?: string;
  agentKey?: string;
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface ChatRuntimeServices {
  identity: IdentityRecord;
  store: ThreadRuntimeStore;
  extraTools: readonly Tool[];
  createThread(options?: CreateChatThreadOptions): Promise<ThreadRecord>;
  resolveOrCreateHomeThread(options?: CreateChatThreadOptions): Promise<ThreadRecord>;
  resetHomeThread(options?: Omit<CreateChatThreadOptions, "id" | "agentKey">): Promise<ThreadRecord>;
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
    cwd: options.cwd,
    identity: options.identity,
    dbUrl: options.dbUrl,
    tablePrefix: options.tablePrefix,
    onStoreNotification: options.onStoreNotification,
  });

  const applyDefaults = (threadOptions: CreateChatThreadOptions = {}): CreateChatThreadOptions => {
    return {
      id: threadOptions.id,
      agentKey: trimNonEmptyString(threadOptions.agentKey) ?? trimNonEmptyString(options.agent),
      provider: threadOptions.provider ?? options.provider,
      model: threadOptions.model ?? options.model,
      thinking: threadOptions.thinking,
    };
  };

  return {
    identity: client.identity,
    store: client.store,
    extraTools: [],
    createThread: (threadOptions) => client.createThread(applyDefaults(threadOptions)),
    resolveOrCreateHomeThread: (threadOptions) => client.resolveOrCreateHomeThread(applyDefaults(threadOptions)),
    resetHomeThread: (threadOptions) => client.resetHomeThread({
      provider: threadOptions?.provider ?? options.provider,
      model: threadOptions?.model ?? options.model,
      thinking: threadOptions?.thinking,
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
