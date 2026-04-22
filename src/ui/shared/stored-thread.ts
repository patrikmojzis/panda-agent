import type {ThinkingLevel, Tool} from "../../kernel/agent/index.js";
import {resolveStoredContext} from "../../app/runtime/create-runtime.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {ThreadMessageRecord, ThreadRecord, ThreadRunRecord,} from "../../domain/threads/runtime/types.js";
import {resolveDefaultAgentModelSelector} from "../../panda/defaults.js";
import {type EntryRole, type RunPhase, type TranscriptEntry,} from "../tui/chat-shared.js";
import {renderTranscriptEntries} from "../tui/transcript.js";

export function resolveStoredThreadDisplayedCwd(
  thread: ThreadRecord | null,
  fallbackCwd: string,
): string {
  const context = thread?.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return fallbackCwd;
  }

  const agentKey = typeof (context as {agentKey?: unknown}).agentKey === "string"
    ? (context as {agentKey: string}).agentKey
    : undefined;
  return resolveStoredContext(
    context,
    {cwd: fallbackCwd},
    agentKey,
  ).cwd ?? fallbackCwd;
}

export function resolveStoredThreadDisplayConfig(thread: Pick<ThreadRecord, "model" | "thinking">): {
  model: string;
  thinking?: ThinkingLevel;
} {
  return {
    model: thread.model ?? resolveDefaultAgentModelSelector(),
    thinking: thread.thinking,
  };
}

export function createStoredTranscriptEntry(input: {
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

export function appendStoredTranscriptMessages(input: {
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
      const created = createStoredTranscriptEntry({
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

export function observeLatestStoredRun(input: {
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

export async function loadStoredThreadSnapshot(input: {
  store: Pick<ThreadRuntimeStore, "getThread" | "loadTranscript" | "listRuns">;
  threadId: string;
}): Promise<{
  thread: ThreadRecord;
  transcript: readonly ThreadMessageRecord[];
  runs: readonly ThreadRunRecord[];
}> {
  const [thread, transcript, runs] = await Promise.all([
    input.store.getThread(input.threadId),
    input.store.loadTranscript(input.threadId),
    input.store.listRuns(input.threadId),
  ]);

  return {
    thread,
    transcript,
    runs,
  };
}
