import type {ThinkingLevel} from "../../kernel/agent/index.js";
import type {ThreadRecord} from "../../domain/threads/runtime/index.js";
import type {ChatRuntimeServices} from "./runtime.js";
import {type PendingLocalInput,} from "./chat-shared.js";
import type {SessionRecord} from "../../domain/sessions/index.js";
import {
  appendStoredTranscriptMessages,
  createStoredTranscriptEntry,
  loadStoredThreadSnapshot,
  observeLatestStoredRun,
  resolveStoredThreadDisplayConfig,
  resolveStoredThreadDisplayedCwd,
} from "../shared/stored-thread.js";

export interface ChatSessionDefaults {
  sessionId?: string;
  agentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export const resolveChatDisplayedCwd = resolveStoredThreadDisplayedCwd;

export function buildChatSessionDefaults(input: {
  defaultAgentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  overrides?: Partial<ChatSessionDefaults>;
}): ChatSessionDefaults {
  return {
    sessionId: input.overrides?.sessionId,
    agentKey: input.overrides?.agentKey ?? input.defaultAgentKey,
    model: input.overrides?.model ?? input.model,
    thinking: input.overrides?.thinking ?? input.thinking,
  };
}

export const resolveStoredChatDisplayConfig = resolveStoredThreadDisplayConfig;

export async function resolveInitialChatSessionThread(input: {
  services: ChatRuntimeServices;
  sessionId?: string;
  defaults: ChatSessionDefaults;
}): Promise<ThreadRecord> {
  if (input.sessionId) {
    return await input.services.openSession(input.sessionId);
  }

  return await input.services.openMainSession(input.defaults);
}

export const createChatTranscriptEntry = createStoredTranscriptEntry;

export const appendStoredChatMessages = appendStoredTranscriptMessages;

export function queuePendingChatInput(
  pendingLocalInputs: PendingLocalInput[],
  threadId: string,
  text: string,
  id: string,
): void {
  pendingLocalInputs.push({
    id,
    threadId,
    text,
    createdAt: Date.now(),
  });
}

export function removePendingChatInput(
  pendingLocalInputs: PendingLocalInput[],
  id: string,
): boolean {
  const index = pendingLocalInputs.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return false;
  }

  pendingLocalInputs.splice(index, 1);
  return true;
}

export function pendingChatInputsForThread(
  pendingLocalInputs: readonly PendingLocalInput[],
  threadId: string,
): readonly PendingLocalInput[] {
  return pendingLocalInputs.filter((entry) => entry.threadId === threadId);
}

export const observeLatestChatRun = observeLatestStoredRun;

export function resolveSessionPickerSelection(input: {
  sessions: readonly SessionRecord[];
  selectedSessionId: string;
  currentSessionId: string;
}): number {
  if (input.sessions.length === 0) {
    return 0;
  }

  const selectedIndex = input.sessions.findIndex((session) => session.id === input.selectedSessionId);
  if (selectedIndex >= 0) {
    return selectedIndex;
  }

  const fallbackIndex = input.sessions.findIndex((session) => session.id === input.currentSessionId);
  return fallbackIndex >= 0 ? fallbackIndex : 0;
}

export async function loadChatThreadSnapshot(input: {
  services: ChatRuntimeServices;
  threadId: string;
}) {
  return loadStoredThreadSnapshot({
    store: input.services.store,
    threadId: input.threadId,
  });
}
