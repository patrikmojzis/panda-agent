import process from "node:process";

import {createPostgresPool, requireDatabaseUrl} from "../../app/runtime/create-runtime.js";
import {listenThreadRuntimeNotifications} from "../../app/runtime/store-notifications.js";
import {PostgresSessionStore, type SessionStore} from "../../domain/sessions/index.js";
import {readThreadAgentKey} from "../../domain/threads/runtime/context.js";
import {
    PostgresThreadRuntimeStore,
    type ThreadMessageRecord,
    type ThreadRecord,
    type ThreadRunRecord,
} from "../../domain/threads/runtime/index.js";
import type {ThreadRuntimeNotification} from "../../domain/threads/runtime/postgres.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {buildDefaultAgentTools} from "../../panda/definition.js";
import {buildStoredTranscriptLines} from "../shared/transcript-lines.js";
import {
    appendStoredTranscriptMessages,
    loadStoredThreadSnapshot,
    observeLatestStoredRun,
    resolveStoredThreadDisplayConfig,
    resolveStoredThreadDisplayedCwd,
} from "../shared/stored-thread.js";
import {formatThinkingLevel, type TranscriptLineCacheEntry,} from "../tui/chat-shared.js";
import {stripAnsi, theme} from "../tui/theme.js";

const DEFAULT_TAIL_MESSAGES = 40;
const SYNC_DEBOUNCE_MS = 150;

export type ObserveTarget =
  | { kind: "agent"; agentKey: string }
  | { kind: "session"; sessionId: string }
  | { kind: "thread"; threadId: string };

export interface ObserveRunOptions {
  target: ObserveTarget;
  dbUrl?: string;
  once?: boolean;
  tail?: number;
}

export interface ObserveServices {
  sessionStore: Pick<SessionStore, "getMainSession" | "getSession">;
  store: Pick<ThreadRuntimeStore, "getThread" | "loadTranscript" | "listRuns">;
  subscribe(
    listener: (notification: ThreadRuntimeNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

interface ObserveOutput {
  columns?: number;
  isTTY?: boolean;
  write(chunk: string): boolean;
}

interface ObserveDependencies {
  createServices?: (dbUrl?: string) => Promise<ObserveServices>;
  output?: ObserveOutput;
}

interface ResolvedObserveTarget {
  sessionId: string;
  threadId: string;
}

export async function createObserveServices(dbUrl?: string): Promise<ObserveServices> {
  const pool = createPostgresPool({
    connectionString: requireDatabaseUrl(dbUrl),
    applicationName: "panda/observe",
    max: 2,
  });
  const sessionStore = new PostgresSessionStore({pool});
  const store = new PostgresThreadRuntimeStore({pool});

  return {
    // Observe is intentionally read-only; it should inspect an initialized
    // runtime, not try to create or mutate schema on the way in.
    sessionStore,
    store,
    subscribe: (listener) => listenThreadRuntimeNotifications({pool, listener}),
    close: async () => {
      await pool.end();
    },
  };
}

export async function runObserveApp(options: ObserveRunOptions): Promise<void> {
  const app = new ObserveApp(options);
  await app.run();
}

export class ObserveApp {
  private readonly target: ObserveTarget;
  private readonly dbUrl?: string;
  private readonly once: boolean;
  private readonly tail: number;
  private readonly output: ObserveOutput;
  private readonly createServices: (dbUrl?: string) => Promise<ObserveServices>;
  private readonly currentTools = buildDefaultAgentTools();
  private readonly seenStoredMessageIds = new Set<string>();
  private readonly transcriptLineCache = new Map<number, TranscriptLineCacheEntry>();
  private readonly fallbackCwd = process.cwd();
  private services: ObserveServices | null = null;
  private unsubscribe: (() => Promise<void>) | null = null;
  private currentThread: ThreadRecord | null = null;
  private nextEntryId = 1;
  private lastObservedRunStatusKey: string | null = null;
  private currentRunStartedAt = 0;
  private syncDebounceTimer: NodeJS.Timeout | null = null;
  private syncInFlight = false;
  private syncRequestedWhileBusy = false;
  private closed = false;
  private waitResolver: (() => void) | null = null;
  private readonly handleSigint = (): void => {
    this.close();
  };
  private readonly handleSigterm = (): void => {
    this.close();
  };

  constructor(options: ObserveRunOptions, dependencies: ObserveDependencies = {}) {
    this.target = options.target;
    this.dbUrl = options.dbUrl;
    this.once = options.once === true;
    this.tail = options.tail ?? DEFAULT_TAIL_MESSAGES;
    this.output = dependencies.output ?? process.stdout;
    this.createServices = dependencies.createServices ?? createObserveServices;
  }

  async run(): Promise<void> {
    this.services = await this.createServices(this.dbUrl);

    try {
      if (!this.once) {
        this.unsubscribe = await this.services.subscribe((notification) => this.handleStoreNotification(notification.threadId));
      }

      await this.syncStoredState(true);

      if (this.once) {
        return;
      }

      process.once("SIGINT", this.handleSigint);
      process.once("SIGTERM", this.handleSigterm);
      await new Promise<void>((resolve) => {
        this.waitResolver = resolve;
      });
    } finally {
      process.off("SIGINT", this.handleSigint);
      process.off("SIGTERM", this.handleSigterm);
      this.clearSyncTimer();
      await this.unsubscribe?.().catch(() => {});
      await this.services?.close().catch(() => {});
      this.unsubscribe = null;
      this.services = null;
    }
  }

  async handleStoreNotification(threadId: string): Promise<void> {
    if (this.closed) {
      return;
    }

    // Session and agent targets must re-resolve on every runtime event so we
    // notice resets that swap the session's current thread under our feet.
    if (this.target.kind === "thread" && threadId !== this.target.threadId) {
      return;
    }

    this.scheduleSync();
  }

  async syncStoredState(force = false): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.syncInFlight) {
      if (force) {
        this.syncRequestedWhileBusy = true;
      }
      return;
    }

    if (force) {
      this.clearSyncTimer();
    }

    this.syncInFlight = true;

    try {
      await this.applySnapshot(await this.loadCurrentSnapshot());
    } finally {
      this.syncInFlight = false;
      if (this.syncRequestedWhileBusy) {
        this.syncRequestedWhileBusy = false;
        queueMicrotask(() => {
          void this.syncStoredState(true);
        });
      }
    }
  }

  private close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.waitResolver?.();
  }

  private clearSyncTimer(): void {
    if (!this.syncDebounceTimer) {
      return;
    }

    clearTimeout(this.syncDebounceTimer);
    this.syncDebounceTimer = null;
  }

  private scheduleSync(delayMs = SYNC_DEBOUNCE_MS): void {
    this.clearSyncTimer();
    this.syncDebounceTimer = setTimeout(() => {
      this.syncDebounceTimer = null;
      void this.syncStoredState(true);
    }, delayMs);
  }

  private requireServices(): ObserveServices {
    if (!this.services) {
      throw new Error("Panda observe has not initialized its services.");
    }

    return this.services;
  }

  private async resolveTarget(): Promise<ResolvedObserveTarget> {
    const services = this.requireServices();
    if (this.target.kind === "agent") {
      const session = await services.sessionStore.getMainSession(this.target.agentKey);
      if (!session) {
        throw new Error(`Agent ${this.target.agentKey} does not have a main session.`);
      }

      return {
        sessionId: session.id,
        threadId: session.currentThreadId,
      };
    }

    if (this.target.kind === "session") {
      const session = await services.sessionStore.getSession(this.target.sessionId);
      return {
        sessionId: session.id,
        threadId: session.currentThreadId,
      };
    }

    const thread = await services.store.getThread(this.target.threadId);
    return {
      sessionId: thread.sessionId,
      threadId: thread.id,
    };
  }

  private async loadCurrentSnapshot(): Promise<{
    resolved: ResolvedObserveTarget;
    thread: ThreadRecord;
    transcript: readonly ThreadMessageRecord[];
    runs: readonly ThreadRunRecord[];
  }> {
    const services = this.requireServices();
    const resolved = await this.resolveTarget();
    const snapshot = await loadStoredThreadSnapshot({
      store: services.store,
      threadId: resolved.threadId,
    });

    return {
      resolved,
      ...snapshot,
    };
  }

  private async applySnapshot(snapshot: {
    resolved: ResolvedObserveTarget;
    thread: ThreadRecord;
    transcript: readonly ThreadMessageRecord[];
    runs: readonly ThreadRunRecord[];
  }): Promise<void> {
    const previousThreadId = this.currentThread?.id ?? "";
    const threadSwitched = Boolean(previousThreadId) && previousThreadId !== snapshot.thread.id;

    if (threadSwitched) {
      this.writeLines([
        this.renderStatusLine(
          `session ${snapshot.resolved.sessionId} switched from thread ${previousThreadId} to ${snapshot.thread.id}`,
          "info",
        ),
      ], {leadingBlank: true});
      this.resetThreadViewState();
    }

    const isInitial = !this.currentThread || threadSwitched;
    this.currentThread = snapshot.thread;

    if (isInitial) {
      this.renderHeader(snapshot.thread, snapshot.resolved.sessionId, snapshot.runs);
      this.renderInitialTranscript(snapshot.transcript);
      this.seedRunState(snapshot.runs);
      return;
    }

    const appended = appendStoredTranscriptMessages({
      records: snapshot.transcript,
      visibleStoredMessageIds: this.seenStoredMessageIds,
      currentTools: this.currentTools,
      nextEntryId: this.nextEntryId,
    });
    this.nextEntryId = appended.nextEntryId;

    if (appended.entries.length > 0) {
      this.writeLines(this.renderTranscriptEntries(appended.entries));
    }

    this.renderRunTransition(snapshot.runs);
  }

  private resetThreadViewState(): void {
    this.seenStoredMessageIds.clear();
    this.transcriptLineCache.clear();
    this.nextEntryId = 1;
    this.lastObservedRunStatusKey = null;
    this.currentRunStartedAt = 0;
  }

  private seedRunState(runs: readonly ThreadRunRecord[]): void {
    const observed = observeLatestStoredRun({
      runs,
      lastObservedRunStatusKey: this.lastObservedRunStatusKey,
      currentRunStartedAt: this.currentRunStartedAt,
    });
    this.lastObservedRunStatusKey = observed.lastObservedRunStatusKey;
    this.currentRunStartedAt = observed.runStartedAt;
  }

  private renderRunTransition(runs: readonly ThreadRunRecord[]): void {
    const latestRun = runs.at(-1);
    const observed = observeLatestStoredRun({
      runs,
      lastObservedRunStatusKey: this.lastObservedRunStatusKey,
      currentRunStartedAt: this.currentRunStartedAt,
    });
    this.lastObservedRunStatusKey = observed.lastObservedRunStatusKey;
    this.currentRunStartedAt = observed.runStartedAt;

    if (!observed.changed || !latestRun) {
      return;
    }

    if (latestRun.status === "running") {
      this.writeLines([
        this.renderStatusLine(`run ${latestRun.id} started`, "info"),
      ]);
      return;
    }

    if (latestRun.status === "completed") {
      this.writeLines([
        this.renderStatusLine(`run ${latestRun.id} completed`, "info"),
      ]);
      return;
    }

    const lines = [
      this.renderStatusLine(`run ${latestRun.id} failed`, "error"),
    ];
    if (observed.errorNotice) {
      lines.push(this.renderStatusLine(observed.errorNotice, "error"));
    }
    this.writeLines(lines);
  }

  private renderInitialTranscript(records: readonly ThreadMessageRecord[]): void {
    if (records.length === 0) {
      this.writeLines([
        this.renderStatusLine("no stored transcript yet", "info"),
      ]);
      return;
    }

    const tailCount = Math.max(1, this.tail);
    const cutoff = Math.max(0, records.length - tailCount);
    for (const record of records.slice(0, cutoff)) {
      this.seenStoredMessageIds.add(record.id);
    }

    const appended = appendStoredTranscriptMessages({
      records,
      visibleStoredMessageIds: this.seenStoredMessageIds,
      currentTools: this.currentTools,
      nextEntryId: this.nextEntryId,
    });
    this.nextEntryId = appended.nextEntryId;

    if (appended.entries.length === 0) {
      this.writeLines([
        this.renderStatusLine("no visible transcript entries in the current tail", "info"),
      ]);
      return;
    }

    this.writeLines(this.renderTranscriptEntries(appended.entries));
  }

  private renderTranscriptEntries(entries: Parameters<typeof buildStoredTranscriptLines>[0]["transcript"]): string[] {
    return buildStoredTranscriptLines({
      width: this.resolveWidth(),
      transcript: entries,
      transcriptLineCache: this.transcriptLineCache,
    }).map((line) => line.rendered);
  }

  private renderHeader(
    thread: ThreadRecord,
    sessionId: string,
    runs: readonly ThreadRunRecord[],
  ): void {
    const displayConfig = resolveStoredThreadDisplayConfig(thread);
    const latestRun = runs.at(-1);
    this.writeLines([
      this.renderHeaderLine("target", this.describeTarget()),
      this.renderHeaderLine("agent", readThreadAgentKey(thread) ?? "unknown"),
      this.renderHeaderLine("session", sessionId),
      this.renderHeaderLine("thread", thread.id),
      this.renderHeaderLine("model", displayConfig.model),
      this.renderHeaderLine("thinking", formatThinkingLevel(displayConfig.thinking)),
      this.renderHeaderLine("cwd", resolveStoredThreadDisplayedCwd(thread, this.fallbackCwd)),
      this.renderHeaderLine("run", latestRun?.status ?? "idle"),
      this.renderHeaderLine("tail", this.formatTailDescription()),
    ], {trailingBlank: true});
  }

  private renderHeaderLine(label: string, value: string): string {
    return `${theme.bold(theme.gold(label.padEnd(8)))} ${theme.slate(">")} ${theme.white(value)}`;
  }

  private formatTailDescription(): string {
    const tailCount = Math.max(1, this.tail);
    const noun = tailCount === 1 ? "message" : "messages";
    return `last ${tailCount} stored ${noun} on initial snapshot`;
  }

  private renderStatusLine(message: string, tone: "info" | "error"): string {
    const color = tone === "error" ? theme.coral : theme.slate;
    return `${theme.bold(color("observe".padEnd(8)))} ${theme.slate(">")} ${tone === "error" ? theme.coral(message) : theme.white(message)}`;
  }

  private describeTarget(): string {
    if (this.target.kind === "agent") {
      return `agent ${this.target.agentKey}`;
    }

    if (this.target.kind === "session") {
      return `session ${this.target.sessionId}`;
    }

    return `thread ${this.target.threadId}`;
  }

  private resolveWidth(): number {
    return Math.max(72, Math.min(this.output.columns ?? 100, 140));
  }

  private writeLines(lines: readonly string[], options: {
    leadingBlank?: boolean;
    trailingBlank?: boolean;
  } = {}): void {
    const rendered = lines.map((line) => this.output.isTTY === false ? stripAnsi(line) : line);
    const chunks: string[] = [];
    if (options.leadingBlank) {
      chunks.push("");
    }
    chunks.push(...rendered);
    if (options.trailingBlank) {
      chunks.push("");
    }
    this.output.write(chunks.join("\n") + "\n");
  }
}
