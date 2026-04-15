import type {ThinkingLevel, Tool} from "../../kernel/agent/index.js";
import type {ThreadMessageRecord, ThreadRecord, ThreadRunRecord,} from "../../domain/threads/runtime/index.js";
import type {ChatRuntimeServices} from "./runtime.js";
import {type EntryRole, type PendingLocalInput, type RunPhase, type TranscriptEntry,} from "./chat-shared.js";
import {renderTranscriptEntries} from "./transcript.js";
import type {SessionRecord} from "../../domain/sessions/index.js";

export interface ChatSessionDefaults {
  sessionId?: string;
  agentKey?: string;
  model: string;
  thinking?: ThinkingLevel;
}

export function resolveChatDisplayedCwd(
  thread: ThreadRecord | null,
  fallbackCwd: string,
): string {
  const context = thread?.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return fallbackCwd;
  }

  const cwd = (context as {cwd?: unknown}).cwd;
  return typeof cwd === "string" && cwd.trim().length > 0
    ? cwd
    : fallbackCwd;
}

export function buildChatSessionDefaults(input: {
  defaultAgentKey?: string;
  model: string;
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

export function createChatTranscriptEntry(input: {
  nextEntryId: number;
  role: EntryRole;
  title: string;
  body: string;
}): {entry: TranscriptEntry; nextEntryId: number} {
  return {
    entry: {
      id: input.nextEntryId,
      role: input.role,
      title: input.title,
      body: input.body,
    },
    nextEntryId: input.nextEntryId + 1,
  };
}

export function appendStoredChatMessages(input: {
  records: readonly ThreadMessageRecord[];
  visibleStoredMessageIds: Set<string>;
  currentTools: readonly Tool[];
  nextEntryId: number;
}): {
  entries: TranscriptEntry[];
  nextEntryId: number;
  acknowledgedPendingInputIds: string[];
} {
  const entries: TranscriptEntry[] = [];
  const acknowledgedPendingInputIds: string[] = [];
  let nextEntryId = input.nextEntryId;

  for (const record of input.records) {
    if (input.visibleStoredMessageIds.has(record.id)) {
      continue;
    }

    input.visibleStoredMessageIds.add(record.id);
    if (record.source === "tui" && record.actorId === "local-user" && record.externalMessageId) {
      acknowledgedPendingInputIds.push(record.externalMessageId);
    }

    for (const entry of renderTranscriptEntries(record.message, record, input.currentTools)) {
      const created = createChatTranscriptEntry({
        nextEntryId,
        role: entry.role,
        title: entry.title,
        body: entry.body,
      });
      entries.push(created.entry);
      nextEntryId = created.nextEntryId;
    }
  }

  return {
    entries,
    nextEntryId,
    acknowledgedPendingInputIds,
  };
}

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

export function observeLatestChatRun(input: {
  runs: readonly ThreadRunRecord[];
  lastObservedRunStatusKey: string | null;
  currentRunStartedAt: number;
}): {
  changed: boolean;
  lastObservedRunStatusKey: string | null;
  runPhase: RunPhase;
  runStartedAt: number;
  errorNotice?: string;
  shouldScheduleCloseAfterRun: boolean;
} {
  const latestRun = input.runs.at(-1);
  const runKey = latestRun ? `${latestRun.id}:${latestRun.status}` : null;

  if (runKey === input.lastObservedRunStatusKey) {
    return {
      changed: false,
      lastObservedRunStatusKey: input.lastObservedRunStatusKey,
      runPhase: latestRun?.status === "running" ? "thinking" : "idle",
      runStartedAt: latestRun?.status === "running"
        ? latestRun.startedAt
        : input.currentRunStartedAt,
      shouldScheduleCloseAfterRun: latestRun?.status !== "running",
    };
  }

  if (!latestRun) {
    return {
      changed: true,
      lastObservedRunStatusKey: null,
      runPhase: "idle",
      runStartedAt: input.currentRunStartedAt,
      shouldScheduleCloseAfterRun: true,
    };
  }

  if (latestRun.status === "running") {
    return {
      changed: true,
      lastObservedRunStatusKey: runKey,
      runPhase: "thinking",
      runStartedAt: latestRun.startedAt,
      shouldScheduleCloseAfterRun: false,
    };
  }

  return {
    changed: true,
    lastObservedRunStatusKey: runKey,
    runPhase: "idle",
    runStartedAt: input.currentRunStartedAt,
    errorNotice: latestRun.status === "failed" ? latestRun.error : undefined,
    shouldScheduleCloseAfterRun: true,
  };
}

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
}): Promise<{
  thread: ThreadRecord;
  transcript: readonly ThreadMessageRecord[];
  runs: readonly ThreadRunRecord[];
}> {
  const store = input.services.store;
  const [thread, transcript, runs] = await Promise.all([
    store.getThread(input.threadId),
    store.loadTranscript(input.threadId),
    store.listRuns(input.threadId),
  ]);

  return {
    thread,
    transcript,
    runs,
  };
}
