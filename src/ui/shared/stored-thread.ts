import type {ThinkingLevel} from "@earendil-works/pi-ai";

import type {Tool} from "../../kernel/agent/tool.js";
import {resolveStoredContext} from "../../app/runtime/thread-definition.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {SessionRuntimeConfigRecord} from "../../domain/sessions/types.js";
import type {ThreadMessageRecord, ThreadRecord, ThreadRunRecord, ThreadToolJobRecord,} from "../../domain/threads/runtime/types.js";
import {resolveDefaultAgentModelSelector} from "../../panda/defaults.js";
import {type RunPhase, type TranscriptEntry,} from "../tui/chat-shared.js";
import {renderTranscriptEntries} from "../tui/transcript.js";

export function resolveRuntimeDisplayedCwd(
  agentKey: string | undefined,
  fallbackCwd: string,
): string {
  return resolveStoredContext(
    {cwd: fallbackCwd},
    agentKey,
  ).cwd ?? fallbackCwd;
}

export function resolveStoredThreadDisplayConfig(runtimeConfig?: Pick<
  SessionRuntimeConfigRecord,
  "model" | "thinking" | "thinkingConfigured"
>): {
  model: string;
  thinking?: ThinkingLevel;
} {
  return {
    model: runtimeConfig?.model ?? resolveDefaultAgentModelSelector(),
    thinking: runtimeConfig?.thinkingConfigured ? runtimeConfig.thinking : undefined,
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
      entries.push({
        id: nextEntryId,
        role: entry.role,
        title: entry.title,
        body: entry.body,
      });
      nextEntryId += 1;
    }
  }

  return {
    entries,
    nextEntryId,
    acknowledgedPendingInputIds,
  };
}

export function observeLatestStoredRun(input: {
  latestRun: ThreadRunRecord | null;
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
  const latestRun = input.latestRun;
  const runKey = latestRun ? `${latestRun.id}:${latestRun.status}` : null;
  const changed = runKey !== input.lastObservedRunStatusKey;
  const running = latestRun?.status === "running";

  return {
    changed,
    lastObservedRunStatusKey: runKey,
    runPhase: running ? "thinking" : "idle",
    runStartedAt: running ? latestRun.startedAt : input.currentRunStartedAt,
    errorNotice: changed && latestRun?.status === "failed" ? latestRun.error : undefined,
    shouldScheduleCloseAfterRun: !running,
  };
}

export async function loadStoredThreadSnapshot(input: {
  store: Pick<ThreadRuntimeStore, "getThread" | "listTranscriptPage" | "getLatestRun"> & Partial<Pick<ThreadRuntimeStore, "listToolJobs">>;
  threadId: string;
  includeToolJobs?: boolean;
  transcriptLimit?: number;
  afterSequence?: number;
}): Promise<{
  thread: ThreadRecord;
  transcript: readonly ThreadMessageRecord[];
  nextTranscriptBeforeSequence?: number;
  latestRun: ThreadRunRecord | null;
  toolJobs: readonly ThreadToolJobRecord[];
}> {
  const loadTranscriptPageWindow = async () => {
    if (input.afterSequence !== undefined) {
      const pages: ThreadMessageRecord[][] = [];
      let afterSequence: number | undefined = input.afterSequence;

      while (afterSequence !== undefined) {
        const page = await input.store.listTranscriptPage(input.threadId, {
          afterSequence,
          limit: 500,
        });
        pages.push([...page.records]);
        afterSequence = page.nextAfterSequence;
      }

      return {records: pages.flat()};
    }

    const page = await input.store.listTranscriptPage(input.threadId, {
      limit: input.transcriptLimit,
    });

    return {
      records: page.records,
      nextTranscriptBeforeSequence: page.nextBeforeSequence,
    };
  };

  const [thread, transcriptPage, latestRun, toolJobs] = await Promise.all([
    input.store.getThread(input.threadId),
    loadTranscriptPageWindow(),
    input.store.getLatestRun(input.threadId),
    input.includeToolJobs && input.store.listToolJobs
      ? input.store.listToolJobs(input.threadId)
      : Promise.resolve([]),
  ]);

  return {
    thread,
    transcript: transcriptPage.records,
    nextTranscriptBeforeSequence: transcriptPage.nextTranscriptBeforeSequence,
    latestRun,
    toolJobs,
  };
}
