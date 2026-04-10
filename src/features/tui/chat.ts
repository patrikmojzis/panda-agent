import path from "node:path";
import readline from "node:readline";
import {randomUUID} from "node:crypto";
import {stdin as input, stdout as output} from "node:process";

import {
  assertProviderName,
  formatProviderNameList,
  getProviderConfig,
  parseProviderName,
  resolveProviderApiKey,
  stringToUserMessage,
  type ThinkingLevel,
  Tool,
  type ToolProgressEvent,
} from "../agent-core/index.js";
import type {ProviderName} from "../agent-core/types.js";
import {buildPandaTools} from "../panda/agent.js";
import {summarizeMessageText} from "../panda/message-preview.js";
import {resolveDefaultPandaModel, resolveDefaultPandaProvider} from "../panda/provider-defaults.js";
import {type ChatRuntimeServices, createChatRuntime,} from "./runtime.js";
import {buildChatHelpText, describeUnknownCommand, runChatCommandLine,} from "./chat-commands.js";
import {renderTranscriptEntries,} from "./transcript.js";
import {applySlashCompletion, getSlashCompletionContext, type SlashCompletionContext,} from "./commands.js";
import {
  backspace,
  type ComposerState,
  createComposerState,
  deleteForward,
  deleteWordBackward,
  insertText,
  moveCursorDown,
  moveCursorLeft,
  moveCursorLineEnd,
  moveCursorLineStart,
  moveCursorRight,
  moveCursorUp,
  moveCursorWordLeft,
  moveCursorWordRight,
  setComposerValue,
} from "./composer.js";
import {
  COMPOSER_NEWLINE_HINT,
  extendedKeysModeSequence,
  isPrintableKey,
  type KeyLike,
  normalizeTerminalKeySequence,
  replaceTrailingBackslashWithNewline,
  resolveComposerEnterAction,
  resolveComposerMetaAction,
} from "./input.js";
import {
  buildChatViewModel,
  buildWelcomeTranscriptLines,
  type ComposerLayout,
  normalizeInlineText,
  type NoticeState,
  THREAD_PICKER_VISIBLE_COUNT,
  type TranscriptLine,
  type ViewModel,
} from "./chat-view.js";
import {renderMarkdownLines} from "./markdown.js";
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  clamp,
  CLEAR_SCREEN,
  cursorTo,
  formatDuration,
  HIDE_CURSOR,
  padAnsiEnd,
  SHOW_CURSOR,
  truncatePlainText,
  wrapPlainText,
} from "./screen.js";
import {stripAnsi, theme} from "./theme.js";
import type {
  ThreadMessageRecord,
  ThreadRecord,
  ThreadRunRecord,
  ThreadRuntimeEvent,
  ThreadSummaryRecord,
} from "../thread-runtime/index.js";
import {compactThread, isMissingThreadError,} from "../thread-runtime/index.js";

type EntryRole = "assistant" | "user" | "tool" | "meta" | "error";
type RunPhase = "idle" | "thinking";

interface TranscriptEntry {
  id: number;
  role: EntryRole;
  title: string;
  body: string;
}

interface TranscriptLineCacheEntry {
  role: EntryRole;
  title: string;
  body: string;
  bodyWidth: number;
  lines: readonly TranscriptLine[];
}

interface SearchState {
  active: boolean;
  query: string;
  selected: number;
}

interface ThreadPickerState {
  active: boolean;
  loading: boolean;
  selected: number;
  summaries: readonly ThreadSummaryRecord[];
  error: string | null;
}

interface PendingLocalInput {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
}

const LABEL_WIDTH = 16;
const TRANSCRIPT_GUTTER_WIDTH = 2;
const TICK_MS = 100;
const SPINNER_FRAME_COUNT = 10;
const STORED_SYNC_MS = 750;
const MAX_VISIBLE_PENDING_LOCAL_INPUTS = 3;
const NOTICE_MS = 3_600;
const BRACKETED_PASTE_ON = "\u001b[?2004h";
const BRACKETED_PASTE_OFF = "\u001b[?2004l";
const WELCOME_ENTRY_TEXT = [
  "Type your request and press Enter to start a run with Panda.",
  "Start with a code change, a debugging question, or a quick explanation of this repo.",
].join("\n");

export interface ChatCliOptions {
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingLevel;
  identity?: string;
  agent?: string;
  cwd?: string;
  resume?: string;
  threadId?: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
}

export interface ChatCliResult {
  threadId?: string;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

function parseThinkingCommandValue(value: string): ThinkingLevel | "off" | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "off" || normalized === "none") {
    return "off";
  }

  const matched = THINKING_LEVELS.find((level) => level === normalized);
  return matched ?? null;
}

function formatThinkingLevel(value?: ThinkingLevel): string {
  return value ?? "off";
}

function thinkingCommandUsage(): string {
  return `/thinking <${THINKING_LEVELS.join("|")}|off>`;
}

function thinkingCommandValuesText(): string {
  return `${THINKING_LEVELS.join(", ")}, or off`;
}

function missingApiKeyMessage(provider: ProviderName): string | null {
  return resolveProviderApiKey(provider) ? null : getProviderConfig(provider).missingApiKeyMessage;
}

export class PandaChatApp {
  private providerName: ProviderName;
  private model: string;
  private thinking?: ThinkingLevel;
  private readonly cwd: string;
  private readonly identity?: string;
  private readonly defaultAgentKey?: string;
  private readonly resumeThreadId?: string;
  private readonly explicitThreadId?: string;
  private readonly dbUrl?: string;
  private readonly readOnlyDbUrl?: string;
  private readonly locale: string;
  private readonly timezone: string;
  private readonly transcript: TranscriptEntry[] = [];
  private readonly pendingLocalInputs: PendingLocalInput[] = [];
  private readonly inputHistory: string[] = [];
  private composer: ComposerState = createComposerState();
  private readonly historySearch: SearchState = { active: false, query: "", selected: 0 };
  private readonly transcriptSearch: SearchState = { active: false, query: "", selected: 0 };
  private readonly threadPicker: ThreadPickerState = {
    active: false,
    loading: false,
    selected: 0,
    summaries: [],
    error: null,
  };
  private services: ChatRuntimeServices | null = null;
  private currentThreadId = "";
  private currentThread: ThreadRecord | null = null;
  private currentTools: readonly Tool[] = [];
  private readonly visibleStoredMessageIds = new Set<string>();
  private readonly transcriptLineCache = new Map<number, TranscriptLineCacheEntry>();
  private runPhase: RunPhase = "idle";
  private runStartedAt = 0;
  private notice: NoticeState | null = null;
  private nextEntryId = 1;
  private activeProgressEntryId: number | null = null;
  private followTranscript = true;
  private scrollTop = 0;
  private slashCompletionIndex = 0;
  private lastSlashToken = "";
  private ticker: NodeJS.Timeout | null = null;
  private syncTicker: NodeJS.Timeout | null = null;
  private mainLoopResolver: (() => void) | null = null;
  private closed = false;
  private syncInFlight = false;
  private syncRequestedWhileBusy = false;
  private lastStoredSyncAt = 0;
  private lastObservedRunStatusKey: string | null = null;
  private threadPickerRefreshInFlight = false;
  private threadPickerRefreshRequested = false;
  private closeAfterRun = false;
  private closeAfterRunWaitInFlight = false;
  private dirty = false;
  private renderQueued = false;
  private lastSpinnerFrame = -1;
  private syncDebounceTimer: NodeJS.Timeout | null = null;
  private inBracketedPaste = false;
  private pendingExtendedKeySequence = "";

  private readonly keypressHandler = (sequence: string | undefined, key: KeyLike): void => {
    void this.handleKeypress(sequence, key);
  };

  private readonly resizeHandler = (): void => {
    this.render();
  };

  constructor(options: ChatCliOptions = {}) {
    this.providerName = options.provider === undefined
      ? resolveDefaultPandaProvider()
      : assertProviderName(options.provider);
    this.model = options.model ?? resolveDefaultPandaModel(this.providerName);
    this.thinking = options.thinking;
    this.identity = options.identity;
    this.defaultAgentKey = options.agent;
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.resumeThreadId = options.resume;
    this.explicitThreadId = options.threadId;
    this.dbUrl = options.dbUrl;
    this.readOnlyDbUrl = options.readOnlyDbUrl;
    this.locale = Intl.DateTimeFormat().resolvedOptions().locale;
    this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  }

  async run(): Promise<ChatCliResult> {
    if (!input.isTTY || !output.isTTY) {
      throw new Error("Panda chat requires an interactive terminal.");
    }

    await this.initializeRuntime();

    readline.emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    input.on("keypress", this.keypressHandler);
    output.on("resize", this.resizeHandler);
    this.startTicker();
    this.enterScreen();
    this.setBracketedPasteMode(true);
    this.setExtendedKeysMode(true);

    if (this.transcript.length === 0) {
      this.pushEntry(
        "meta",
        "welcome",
        WELCOME_ENTRY_TEXT,
      );
    } else {
      this.pushEntry(
        "meta",
        "session",
        `Resumed thread ${this.currentThreadId}. Loaded ${this.transcript.length} transcript entries.`,
      );
    }
    this.setNotice(`Ctrl-F find · Ctrl-R history · ${COMPOSER_NEWLINE_HINT} · Ctrl-C exit`, "info", 5_000);
    this.render();

    try {
      await new Promise<void>((resolve) => {
        this.mainLoopResolver = resolve;
      });
    } finally {
      await this.cleanup();
    }

    return {
      threadId: this.currentThreadId || undefined,
    };
  }

  private async cleanup(): Promise<void> {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }

    if (this.syncTicker) {
      clearInterval(this.syncTicker);
      this.syncTicker = null;
    }

    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
      this.syncDebounceTimer = null;
    }

    this.setBracketedPasteMode(false);
    this.setExtendedKeysMode(false);
    input.off("keypress", this.keypressHandler);
    input.pause();
    output.off("resize", this.resizeHandler);
    input.setRawMode?.(false);

    if (this.runPhase === "thinking" && this.currentThreadId) {
      try {
        if (await this.services?.coordinator.abort(this.currentThreadId, "TUI closed.")) {
          await this.services?.coordinator.waitForCurrentRun(this.currentThreadId);
        }
      } catch {
        // Closing the TUI should still continue even if abort/wait cleanup fails.
      }
    }
    output.write(HIDE_CURSOR + CLEAR_SCREEN + SHOW_CURSOR + ALT_SCREEN_OFF);
    await this.services?.close();
  }

  private close(): void {
    if (this.closed) {
      return;
    }

    this.closeAfterRun = false;
    this.closed = true;
    this.mainLoopResolver?.();
  }

  private scheduleCloseAfterRun(): void {
    if (!this.closeAfterRun || this.closed || this.isRunning || this.closeAfterRunWaitInFlight) {
      return;
    }

    const coordinator = this.services?.coordinator;
    const threadId = this.currentThreadId;
    this.closeAfterRunWaitInFlight = true;

    setTimeout(() => {
      if (!this.closeAfterRun || this.closed) {
        this.closeAfterRunWaitInFlight = false;
        return;
      }

      if (!coordinator) {
        this.closeAfterRunWaitInFlight = false;
        this.close();
        return;
      }

      void coordinator.waitForCurrentRun(threadId)
        .catch(() => {
          // Ignore shutdown races and fall through to closing the TUI.
        })
        .finally(() => {
          this.closeAfterRunWaitInFlight = false;

          if (this.closeAfterRun && !this.closed) {
            this.close();
          }
        });
    }, 0);
  }

  private startTicker(): void {
    this.ticker = setInterval(() => {
      if (this.closed) {
        return;
      }

      const nextSpinnerFrame = this.spinnerFrameIndex();
      const noticeExpired = Boolean(this.notice && this.notice.expiresAt <= Date.now());
      if (this.dirty || noticeExpired || nextSpinnerFrame !== this.lastSpinnerFrame) {
        this.render();
      }
    }, TICK_MS);

  }

  private requireServices(): ChatRuntimeServices {
    if (!this.services) {
      throw new Error("Panda chat runtime has not been initialized yet.");
    }

    return this.services;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private requestRender(): void {
    this.markDirty();

    if (this.renderQueued || this.closed) {
      return;
    }

    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (this.closed || !this.dirty) {
        return;
      }

      this.render();
    });
  }

  private spinnerFrameIndex(): number {
    if (!this.isRunning) {
      return -1;
    }

    return Math.floor(Date.now() / TICK_MS) % SPINNER_FRAME_COUNT;
  }

  private scheduleSyncStoredThreadState(delayMs = 150): void {
    if (!this.currentThreadId || !this.services) {
      return;
    }

    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }

    this.syncDebounceTimer = setTimeout(() => {
      this.syncDebounceTimer = null;
      void this.syncStoredThreadState(true);
    }, delayMs);
  }

  private refreshToolCatalog(): void {
    this.currentTools = buildPandaTools(this.services?.extraTools ?? []);
  }

  private async initializeRuntime(): Promise<void> {
    this.services = await createChatRuntime({
      cwd: this.cwd,
      locale: this.locale,
      timezone: this.timezone,
      provider: this.providerName,
      model: this.model,
      identity: this.identity,
      agent: this.defaultAgentKey,
      dbUrl: this.dbUrl,
      readOnlyDbUrl: this.readOnlyDbUrl,
      onEvent: (event) => this.handleRuntimeEvent(event),
      onStoreNotification: (notification) => this.handleStoreNotification(notification.threadId),
    });
    await this.services.recoverOrphanedRuns("Run marked failed before recovery.");

    await this.switchThread(await this.resolveInitialThread());
  }

  private async resolveInitialThread(): Promise<ThreadRecord> {
    const services = this.requireServices();

    if (this.resumeThreadId) {
      return await services.getThread(this.resumeThreadId);
    }

    if (this.explicitThreadId) {
      return await this.getOrCreateExplicitThread(this.explicitThreadId);
    }

    return await services.resolveOrCreateHomeThread(this.buildThreadDefaults());
  }

  private buildThreadDefaults(overrides: Partial<{
    id: string;
    agentKey: string;
    provider: ProviderName;
    model: string;
    thinking: ThinkingLevel;
  }> = {}): {
    id?: string;
    agentKey?: string;
    provider: ProviderName;
    model: string;
    thinking?: ThinkingLevel;
  } {
    return {
      id: overrides.id,
      agentKey: overrides.agentKey ?? this.currentThread?.agentKey ?? this.defaultAgentKey ?? "panda",
      provider: overrides.provider ?? this.providerName,
      model: overrides.model ?? this.model,
      thinking: overrides.thinking ?? this.thinking,
    };
  }

  private async getOrCreateExplicitThread(threadId: string): Promise<ThreadRecord> {
    const services = this.requireServices();

    try {
      return await services.getThread(threadId);
    } catch (error) {
      if (!isMissingThreadError(error, threadId)) {
        throw error;
      }

      return await services.createThread(this.buildThreadDefaults({ id: threadId }));
    }
  }

  private async switchThread(thread: ThreadRecord): Promise<void> {
    this.currentThread = thread;
    this.currentThreadId = thread.id;
    this.providerName = thread.provider ?? this.providerName;
    this.model = thread.model ?? this.model;
    this.thinking = thread.thinking;
    this.runPhase = "idle";
    this.lastObservedRunStatusKey = null;
    this.refreshToolCatalog();
    await this.reloadVisibleTranscript();
    await this.syncStoredThreadState(true);
  }

  private createTranscriptEntry(role: EntryRole, title: string, body: string): TranscriptEntry {
    const entry = {
      id: this.nextEntryId,
      role,
      title,
      body,
    };
    this.nextEntryId += 1;
    return entry;
  }

  private appendStoredMessages(records: readonly ThreadMessageRecord[]): void {
    const nextEntries: TranscriptEntry[] = [];

    for (const record of records) {
      if (this.visibleStoredMessageIds.has(record.id)) {
        continue;
      }

      this.visibleStoredMessageIds.add(record.id);
      this.reconcilePendingLocalInput(record);
      for (const entry of renderTranscriptEntries(record.message, record, this.currentTools)) {
        nextEntries.push(this.createTranscriptEntry(entry.role, entry.title, entry.body));
      }
    }

    if (nextEntries.length === 0) {
      return;
    }

    this.transcript.push(...nextEntries);
    this.markDirty();
  }

  private async reloadVisibleTranscript(): Promise<void> {
    this.resetTranscriptView({ keepSeenMessages: false });
    if (!this.currentThreadId) {
      return;
    }

    const transcript = await this.requireServices().store.loadTranscript(this.currentThreadId);
    this.appendStoredMessages(transcript);
  }

  private formatCompactTokenCount(tokens: number): string {
    if (tokens >= 10_000) {
      return `${(tokens / 1_000).toFixed(0)}k`;
    }

    if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(1)}k`;
    }

    return String(tokens);
  }

  private async compactCurrentThread(customInstructions: string): Promise<void> {
    if (!this.currentThreadId) {
      throw new Error("No active thread to compact.");
    }

    const threadId = this.currentThreadId;
    const services = this.requireServices();
    const compacted = await services.coordinator.runExclusively(threadId, async () => {
      const store = services.store;
      const thread = await store.getThread(threadId);
      const providerName = thread.provider ?? this.providerName;
      const model = thread.model ?? this.model;
      const thinking = thread.thinking;

      const apiKeyMessage = missingApiKeyMessage(providerName);
      if (apiKeyMessage) {
        throw new Error(apiKeyMessage);
      }

      if (await store.hasRunnableInputs(threadId)) {
        throw new Error("Wait for queued input to run before compacting.");
      }

      const runningRun = (await store.listRuns(threadId)).some((run) => run.status === "running");
      if (runningRun) {
        throw new Error("Thread is already active. Abort or wait before compacting.");
      }

      this.currentThread = thread;
      this.providerName = providerName;
      this.model = model;
      this.thinking = thinking;
      this.setNotice("Compacting conversation...", "info");
      this.requestRender();

      const compacted = await compactThread({
        store,
        thread,
        providerName,
        model,
        thinking,
        customInstructions,
        trigger: "manual",
      });
      if (!compacted) {
        return null;
      }

      return {
        tokensBefore: compacted.tokensBefore,
        tokensAfter: compacted.tokensAfter,
      };
    });

    if (!compacted) {
      this.setNotice("Not enough older context to compact yet.", "info");
      return;
    }

    await this.syncStoredThreadState(true);
    const compactLabel =
      `Compacted older context (${this.formatCompactTokenCount(compacted.tokensBefore)} -> ${this.formatCompactTokenCount(compacted.tokensAfter)}).`;
    this.pushEntry("meta", "compact", `${compactLabel} Preserved the most recent user turns verbatim.`);
    this.setNotice(compactLabel, "info", 6_000);
  }

  private observeLatestRun(runs: readonly ThreadRunRecord[]): void {
    const latestRun = runs.at(-1);
    const runKey = latestRun ? `${latestRun.id}:${latestRun.status}` : null;

    if (runKey === this.lastObservedRunStatusKey) {
      return;
    }

    this.lastObservedRunStatusKey = runKey;
    this.markDirty();

    if (!latestRun) {
      this.runPhase = "idle";
      this.scheduleCloseAfterRun();
      return;
    }

    if (latestRun.status === "running") {
      this.runPhase = "thinking";
      this.runStartedAt = latestRun.startedAt;
      return;
    }

    if (latestRun.status === "failed" && latestRun.error) {
      this.setNotice(latestRun.error, "error", 6_000);
    }

    this.runPhase = "idle";
    this.scheduleCloseAfterRun();
  }

  private queuePendingLocalInput(threadId: string, text: string, id: string): void {
    this.pendingLocalInputs.push({
      id,
      threadId,
      text,
      createdAt: Date.now(),
    });
    this.markDirty();
  }

  private removePendingLocalInput(id: string): void {
    const index = this.pendingLocalInputs.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.pendingLocalInputs.splice(index, 1);
      this.markDirty();
    }
  }

  private reconcilePendingLocalInput(record: ThreadMessageRecord): void {
    if (record.source !== "tui" || record.actorId !== "local-user" || !record.externalMessageId) {
      return;
    }

    this.removePendingLocalInput(record.externalMessageId);
  }

  private pendingInputsForCurrentThread(): readonly PendingLocalInput[] {
    return this.pendingLocalInputs.filter((entry) => entry.threadId === this.currentThreadId);
  }

  private async syncStoredThreadState(force = false): Promise<void> {
    if (!this.currentThreadId || !this.services) {
      return;
    }

    if (this.syncInFlight) {
      if (force) {
        this.syncRequestedWhileBusy = true;
      }
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastStoredSyncAt < STORED_SYNC_MS) {
      return;
    }

    if (force && this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
      this.syncDebounceTimer = null;
    }

    const threadId = this.currentThreadId;
    this.syncInFlight = true;
    this.lastStoredSyncAt = Date.now();

    try {
      const store = this.requireServices().store;
      const [thread, transcript, runs] = await Promise.all([
        store.getThread(threadId),
        store.loadTranscript(threadId),
        store.listRuns(threadId),
      ]);

      if (threadId !== this.currentThreadId) {
        return;
      }

      this.currentThread = thread;
      this.providerName = thread.provider ?? this.providerName;
      this.model = thread.model ?? this.model;
      this.thinking = thread.thinking;
      this.refreshToolCatalog();
      this.markDirty();
      this.appendStoredMessages(transcript);
      this.observeLatestRun(runs);
      this.requestRender();
    } catch {
      // Ignore background sync failures in the TUI; foreground actions still surface errors.
    } finally {
      this.syncInFlight = false;
      if (this.syncRequestedWhileBusy) {
        this.syncRequestedWhileBusy = false;
        queueMicrotask(() => {
          void this.syncStoredThreadState(true);
        });
      }
    }
  }

  private async handleStoreNotification(threadId: string): Promise<void> {
    if (this.closed) {
      return;
    }

    if (threadId === this.currentThreadId) {
      this.scheduleSyncStoredThreadState();
    }

    if (this.threadPicker.active) {
      await this.refreshThreadPicker();
      this.requestRender();
    }
  }

  private async refreshThreadPicker(): Promise<void> {
    if (this.threadPickerRefreshInFlight) {
      this.threadPickerRefreshRequested = true;
      return;
    }

    this.threadPickerRefreshInFlight = true;
    const selectedThreadId =
      this.threadPicker.summaries[this.threadPicker.selected]?.thread.id ?? this.currentThreadId;
    this.threadPicker.loading = true;
    this.threadPicker.error = null;
    this.render();

    try {
      const summaries = await this.requireServices().listThreadSummaries(16);
      this.threadPicker.summaries = summaries;

      if (summaries.length === 0) {
        this.threadPicker.selected = 0;
        return;
      }

      const selectedIndex = summaries.findIndex((summary) => summary.thread.id === selectedThreadId);
      const fallbackIndex = summaries.findIndex((summary) => summary.thread.id === this.currentThreadId);
      this.threadPicker.selected = selectedIndex >= 0
        ? selectedIndex
        : fallbackIndex >= 0
          ? fallbackIndex
          : 0;
    } catch (error) {
      this.threadPicker.error = error instanceof Error ? error.message : String(error);
      this.threadPicker.summaries = [];
      this.threadPicker.selected = 0;
    } finally {
      this.threadPicker.loading = false;
      this.threadPickerRefreshInFlight = false;
      if (this.threadPicker.active && this.threadPickerRefreshRequested) {
        this.threadPickerRefreshRequested = false;
        queueMicrotask(() => {
          void this.refreshThreadPicker();
        });
      }
    }
  }

  private async openThreadPicker(): Promise<void> {
    if (this.isRunning) {
      this.setNotice("Abort or wait for the current run before switching threads.", "info");
      return;
    }

    this.threadPicker.active = true;
    this.threadPicker.selected = 0;
    await this.refreshThreadPicker();
    this.render();
  }

  private closeThreadPicker(): void {
    this.threadPicker.active = false;
    this.threadPicker.loading = false;
    this.threadPicker.error = null;
    this.threadPicker.summaries = [];
    this.threadPicker.selected = 0;
    this.threadPickerRefreshRequested = false;
  }

  private cycleThreadPicker(delta: number): void {
    if (this.threadPicker.summaries.length === 0) {
      return;
    }

    this.threadPicker.selected = clamp(
      this.threadPicker.selected + delta,
      0,
      this.threadPicker.summaries.length - 1,
    );
  }

  private buildThreadPickerLayout(width: number): ComposerLayout {
    const header = theme.bold(theme.gold("threads")) + theme.slate(" > ");
    const headerWidth = stripAnsi(header).length;
    const bodyWidth = Math.max(1, width - 2);
    const lines: string[] = [
      header + truncatePlainText(
        this.threadPicker.loading
          ? "loading recent threads..."
          : "up/down select · enter resume · esc cancel",
        Math.max(1, width - headerWidth),
      ),
    ];

    if (this.threadPicker.error) {
      lines.push(theme.coral(truncatePlainText(this.threadPicker.error, bodyWidth)));
    } else if (!this.threadPicker.loading && this.threadPicker.summaries.length === 0) {
      lines.push(theme.dim("No stored threads yet."));
    } else {
      const maxStart = Math.max(0, this.threadPicker.summaries.length - THREAD_PICKER_VISIBLE_COUNT);
      const start = clamp(
        this.threadPicker.selected - Math.floor(THREAD_PICKER_VISIBLE_COUNT / 2),
        0,
        maxStart,
      );
      const visible = this.threadPicker.summaries.slice(start, start + THREAD_PICKER_VISIBLE_COUNT);

      for (const [offset, summary] of visible.entries()) {
        const absoluteIndex = start + offset;
        const selected = absoluteIndex === this.threadPicker.selected;
        const prefix = selected ? theme.gold("› ") : theme.dim("  ");
        const current = summary.thread.id === this.currentThreadId ? " · current" : "";
        const last = summary.lastMessage
          ? normalizeInlineText(summarizeMessageText(summary.lastMessage.message) || summary.lastMessage.source)
          : "no messages yet";
        const shortId = summary.thread.id.length > 12
          ? `${summary.thread.id.slice(0, 8)}…${summary.thread.id.slice(-4)}`
          : summary.thread.id;
        lines.push(prefix + truncatePlainText(
          `${shortId}${current} · ${summary.thread.provider ?? this.providerName} · ${summary.messageCount} msgs · ${last}`,
          Math.max(1, width - stripAnsi(prefix).length),
        ));
      }
    }

    return {
      lines,
      cursorRow: 0,
      cursorColumn: 1,
    };
  }

  private buildPendingLocalInputLines(width: number): string[] {
    if (this.threadPicker.active) {
      return [];
    }

    const pending = this.pendingInputsForCurrentThread();
    if (pending.length === 0) {
      return [];
    }

    const lines: string[] = [];
    const header = theme.bold(theme.gold("queued")) + theme.slate(" > ");
    const headerWidth = stripAnsi(header).length;
    lines.push(
      header + truncatePlainText(
        `${pending.length} pending ${pending.length === 1 ? "message" : "messages"}`,
        Math.max(1, width - headerWidth),
      ),
    );

    const visible = pending.slice(-MAX_VISIBLE_PENDING_LOCAL_INPUTS);
    const hiddenCount = pending.length - visible.length;
    if (hiddenCount > 0) {
      lines.push(theme.dim(truncatePlainText(`... ${hiddenCount} older queued`, width)));
    }

    for (const entry of visible) {
      const age = formatDuration(Date.now() - entry.createdAt);
      const summary = normalizeInlineText(entry.text) || "(empty)";
      lines.push(theme.dim(truncatePlainText(`+ ${summary} · ${age}`, width)));
    }

    return lines;
  }

  private async selectThreadPickerEntry(): Promise<void> {
    if (this.threadPicker.loading) {
      return;
    }

    const summary = this.threadPicker.summaries[this.threadPicker.selected];
    if (!summary) {
      this.closeThreadPicker();
      return;
    }

    await this.switchThread(summary.thread);
    this.closeThreadPicker();
    this.setNotice(`Resumed thread ${this.currentThreadId}.`, "info");
  }

  private async handleRuntimeEvent(event: ThreadRuntimeEvent): Promise<void> {
    if (this.closed) {
      return;
    }

    if (event.threadId !== this.currentThreadId) {
      return;
    }

    switch (event.type) {
      case "run_started":
        this.runPhase = "thinking";
        this.runStartedAt = event.run.startedAt;
        this.requestRender();
        break;

      case "inputs_applied":
        this.clearProgressEntry();
        this.scheduleSyncStoredThreadState();
        break;

      case "thread_event":
        if (this.isToolProgressEvent(event.event)) {
          this.upsertProgressEntry(JSON.stringify(event.event.details, null, 2));
          this.requestRender();
        } else {
          this.clearProgressEntry();
          this.scheduleSyncStoredThreadState();
        }
        break;

      case "run_finished":
        this.clearProgressEntry();
        if (event.run.status === "failed" && event.run.error) {
          this.setNotice(event.run.error, "error", 6_000);
        }
        this.runPhase = "idle";
        this.scheduleCloseAfterRun();
        this.scheduleSyncStoredThreadState();
        this.requestRender();
        break;
    }
  }

  private isToolProgressEvent(
    event: Extract<ThreadRuntimeEvent, { type: "thread_event" }>["event"],
  ): event is ToolProgressEvent {
    return "type" in event && event.type === "tool_progress";
  }

  private get modeLabel(): string {
    if (this.threadPicker.active) {
      return "threads";
    }

    if (this.historySearch.active) {
      return "history";
    }

    if (this.transcriptSearch.active) {
      return "find";
    }

    return "compose";
  }

  private get isRunning(): boolean {
    return this.runPhase !== "idle";
  }

  private get shouldShowSplash(): boolean {
    return this.transcript.length === 1 && this.transcript[0]?.title === "welcome";
  }

  private setNotice(text: string, tone: NoticeState["tone"], durationMs = NOTICE_MS): void {
    this.notice = {
      text,
      tone,
      expiresAt: Date.now() + durationMs,
    };
    this.markDirty();
  }

  private clearExpiredNotice(): void {
    if (this.notice && this.notice.expiresAt <= Date.now()) {
      this.notice = null;
      this.markDirty();
    }
  }

  private pushEntry(role: EntryRole, title: string, body: string): TranscriptEntry {
    const entry = this.createTranscriptEntry(role, title, body);
    this.transcript.push(entry);
    this.markDirty();
    return entry;
  }

  private upsertProgressEntry(body: string): void {
    if (this.activeProgressEntryId !== null) {
      const existing = this.transcript.find((entry) => entry.id === this.activeProgressEntryId);
      if (existing) {
        existing.body = body;
        this.transcriptLineCache.delete(existing.id);
        this.markDirty();
        return;
      }
    }

    const entry = this.pushEntry("meta", "progress", body);
    this.activeProgressEntryId = entry.id;
  }

  private clearProgressEntry(): void {
    if (this.activeProgressEntryId === null) {
      return;
    }

    const activeProgressEntryId = this.activeProgressEntryId;
    const index = this.transcript.findIndex((entry) => entry.id === this.activeProgressEntryId);
    this.activeProgressEntryId = null;
    if (index < 0) {
      return;
    }

    this.transcriptLineCache.delete(activeProgressEntryId);
    this.transcript.splice(index, 1);
    this.markDirty();
  }

  private setComposerState(next: ComposerState): void {
    this.composer = next;
    this.markDirty();
    this.currentSlashContext();
  }

  private resetTranscriptView(options: { keepSeenMessages?: boolean } = {}): void {
    this.transcript.length = 0;
    this.activeProgressEntryId = null;
    this.transcriptLineCache.clear();
    if (!options.keepSeenMessages) {
      this.visibleStoredMessageIds.clear();
    }
    this.followTranscript = true;
    this.scrollTop = 0;
    this.clearTranscriptSearch();
    this.markDirty();
  }

  private historyMatches(): number[] {
    const query = this.historySearch.query.trim().toLowerCase();
    const matches: number[] = [];

    for (let index = this.inputHistory.length - 1; index >= 0; index -= 1) {
      const value = this.inputHistory[index];
      if (!value) {
        continue;
      }

      if (!query || value.toLowerCase().includes(query)) {
        matches.push(index);
      }
    }

    return matches;
  }

  private currentHistoryMatch(): string | null {
    const matches = this.historyMatches();
    if (matches.length === 0) {
      return null;
    }

    const selectedIndex = clamp(this.historySearch.selected, 0, matches.length - 1);
    const historyIndex = matches[selectedIndex];
    if (historyIndex === undefined) {
      return null;
    }

    return this.inputHistory[historyIndex] ?? null;
  }

  private buildCachedTranscriptLines(
    entry: TranscriptEntry,
    bodyWidth: number,
  ): readonly TranscriptLine[] {
    const cached = this.transcriptLineCache.get(entry.id);
    if (
      cached
      && cached.role === entry.role
      && cached.title === entry.title
      && cached.body === entry.body
      && cached.bodyWidth === bodyWidth
    ) {
      return cached.lines;
    }

    const labelColor =
      entry.role === "assistant"
        ? theme.coral
        : entry.role === "user"
          ? theme.cyan
          : entry.role === "tool"
            ? theme.gold
            : entry.role === "error"
              ? theme.coral
              : theme.slate;
    const labelText = truncatePlainText(entry.title, LABEL_WIDTH);
    const label = padAnsiEnd(theme.bold(labelColor(labelText)), LABEL_WIDTH);
    const wrappedBody = entry.role === "assistant"
      ? renderMarkdownLines(entry.body, bodyWidth)
      : wrapPlainText(entry.body, bodyWidth).map((line) => ({
          plain: line,
          rendered: line,
        }));
    const lines = wrappedBody.map((line, index) => {
      return {
        plain: `${entry.title} ${line.plain}`.trimEnd(),
        rendered: `${index === 0 ? label : " ".repeat(LABEL_WIDTH)}${line.rendered}`,
      } satisfies TranscriptLine;
    });

    this.transcriptLineCache.set(entry.id, {
      role: entry.role,
      title: entry.title,
      body: entry.body,
      bodyWidth,
      lines,
    });
    return lines;
  }

  private buildTranscriptLines(width: number): TranscriptLine[] {
    const bodyWidth = Math.max(20, width - TRANSCRIPT_GUTTER_WIDTH - LABEL_WIDTH);
    const lines: TranscriptLine[] = [];
    const visibleEntries = this.shouldShowSplash
      ? this.transcript
      : this.transcript.filter((entry) => entry.title !== "welcome");

    for (const entry of visibleEntries) {
      if (entry.title === "welcome" && this.shouldShowSplash) {
        lines.push(...buildWelcomeTranscriptLines({
          width,
          providerName: this.providerName,
          model: this.model,
          thinkingLabel: formatThinkingLevel(this.thinking),
          cwd: this.cwd,
        }));
        continue;
      }

      lines.push(...this.buildCachedTranscriptLines(entry, bodyWidth));
    }

    return lines;
  }

  private buildComposerLayout(width: number): ComposerLayout {
    if (this.threadPicker.active) {
      return this.buildThreadPickerLayout(width);
    }

    const firstPrefix = theme.bold(theme.cyan("you")) + theme.slate(" > ");
    const nextPrefix = theme.dim("…   ");
    const firstPrefixWidth = stripAnsi(firstPrefix).length;
    const nextPrefixWidth = stripAnsi(nextPrefix).length;
    const firstLineWidth = Math.max(1, width - firstPrefixWidth);
    const nextLineWidth = Math.max(1, width - nextPrefixWidth);
    const lines: string[] = [];
    let current = "";
    let currentWidth = firstLineWidth;
    let currentPrefix = firstPrefix;
    let currentPrefixWidth = firstPrefixWidth;
    let cursorRow = 0;
    let cursorColumn = currentPrefixWidth + 1;

    const commitLine = (): void => {
      lines.push(currentPrefix + current);
      current = "";
      currentPrefix = nextPrefix;
      currentPrefixWidth = nextPrefixWidth;
      currentWidth = nextLineWidth;
    };

    for (let index = 0; index <= this.composer.value.length; index += 1) {
      if (index === this.composer.cursor) {
        cursorRow = lines.length;
        cursorColumn = currentPrefixWidth + current.length + 1;
      }

      if (index === this.composer.value.length) {
        break;
      }

      const char = this.composer.value[index] ?? "";
      if (char === "\n") {
        commitLine();
        continue;
      }

      current += char;
      if (current.length >= currentWidth) {
        commitLine();
      }
    }

    commitLine();

    return {
      lines,
      cursorRow,
      cursorColumn,
    };
  }

  private buildView(): ViewModel {
    this.clearExpiredNotice();
    const width = Math.max(72, Math.min(output.columns || 100, 140));
    const transcriptLines = this.buildTranscriptLines(width);
    const composerLayout = this.buildComposerLayout(width);
    const pendingLocalInputLines = this.buildPendingLocalInputLines(width);
    const historyMatches = this.historyMatches();
    const slashContext = this.currentSlashContext();

    return buildChatViewModel({
      terminalWidth: output.columns || 100,
      terminalRows: output.rows || 32,
      transcriptLines,
      transcriptSearchActive: this.transcriptSearch.active,
      transcriptSearchQuery: this.transcriptSearch.query,
      transcriptSearchSelection: this.transcriptSearch.selected,
      threadPickerActive: this.threadPicker.active,
      historySearchActive: this.historySearch.active,
      historySearchQuery: this.historySearch.query,
      historySearchSelection: this.historySearch.selected,
      historyMatchCount: historyMatches.length,
      historyPreview: this.currentHistoryMatch(),
      notice: this.notice,
      slashContext,
      slashCompletionIndex: this.slashCompletionIndex,
      followTranscript: this.followTranscript,
      scrollTop: this.scrollTop,
      pendingLocalInputLines,
      composerLayout,
      isRunning: this.isRunning,
      runStartedAt: this.runStartedAt,
      currentThreadId: this.currentThreadId,
      providerName: this.providerName,
      model: this.model,
      thinkingLabel: formatThinkingLevel(this.thinking),
      modeLabel: this.modeLabel,
      cwd: this.cwd,
    });
  }

  private currentSlashContext(): SlashCompletionContext | null {
    const context = getSlashCompletionContext(this.composer.value, this.composer.cursor);
    const token = context?.token ?? "";

    if (token !== this.lastSlashToken) {
      this.lastSlashToken = token;
      this.slashCompletionIndex = 0;
    }

    if (!context || context.matches.length === 0) {
      this.slashCompletionIndex = 0;
      return context;
    }

    this.slashCompletionIndex = clamp(this.slashCompletionIndex, 0, context.matches.length - 1);
    return context;
  }

  private ensureSelectedTranscriptMatchVisible(view: ViewModel): void {
    if (view.selectedTranscriptLine === null) {
      return;
    }

    this.followTranscript = false;

    if (view.selectedTranscriptLine < view.resolvedScrollTop) {
      this.scrollTop = view.selectedTranscriptLine;
      return;
    }

    if (view.selectedTranscriptLine >= view.resolvedScrollTop + view.transcriptHeight) {
      this.scrollTop = view.selectedTranscriptLine - view.transcriptHeight + 1;
      return;
    }

    this.scrollTop = view.resolvedScrollTop;
  }

  private scrollTranscript(delta: number): void {
    const view = this.buildView();
    this.followTranscript = false;
    this.scrollTop = clamp(view.resolvedScrollTop + delta, 0, view.maxScrollTop);
    if (this.scrollTop >= view.maxScrollTop) {
      this.followTranscript = true;
    }
    this.markDirty();
  }

  private jumpTranscriptToBottom(): void {
    const view = this.buildView();
    this.followTranscript = true;
    this.scrollTop = view.maxScrollTop;
    this.markDirty();
  }

  private startHistorySearch(): void {
    if (this.inputHistory.length === 0) {
      this.setNotice("No previous prompts yet.", "info");
      return;
    }

    this.historySearch.active = true;
    this.historySearch.query = "";
    this.historySearch.selected = 0;
  }

  private startTranscriptSearch(): void {
    this.transcriptSearch.active = true;
    this.transcriptSearch.selected = 0;
  }

  private clearTranscriptSearch(): void {
    this.transcriptSearch.active = false;
    this.transcriptSearch.query = "";
    this.transcriptSearch.selected = 0;
  }

  private cycleHistoryMatch(delta: number): void {
    const matches = this.historyMatches();
    if (matches.length === 0) {
      return;
    }

    this.historySearch.selected = clamp(
      this.historySearch.selected + delta,
      0,
      matches.length - 1,
    );
  }

  private cycleTranscriptMatch(delta: number): void {
    const view = this.buildView();
    if (view.transcriptMatches.length === 0) {
      return;
    }

    this.transcriptSearch.selected = clamp(
      this.transcriptSearch.selected + delta,
      0,
      view.transcriptMatches.length - 1,
    );
    this.ensureSelectedTranscriptMatchVisible(view);
  }

  private applySelectedSlashCompletion(): boolean {
    const context = this.currentSlashContext();
    if (!context || context.matches.length === 0) {
      return false;
    }

    const command = context.matches[this.slashCompletionIndex];
    if (!command) {
      return false;
    }

    const remainder = this.composer.value.slice(context.rangeEnd);
    const alreadyComplete = context.token === command.name;
    const alreadyHasValue = command.expectsValue && /^\s+\S/.test(remainder);
    if (alreadyComplete && (!command.expectsValue || alreadyHasValue || remainder.startsWith(" "))) {
      return false;
    }

    const next = applySlashCompletion(this.composer.value, context, command);
    this.setComposerState(setComposerValue(next.value, next.cursor));
    return true;
  }

  private recordHistory(value: string): void {
    if (!value.trim()) {
      return;
    }

    if (this.inputHistory.at(-1) === value) {
      return;
    }

    this.inputHistory.push(value);
  }

  private requireIdleRun(action: string): boolean {
    if (!this.isRunning) {
      return true;
    }

    this.setNotice(`Abort or wait for the current run before ${action}.`, "info");
    return false;
  }

  private showCommandError(title: string, message: string): void {
    this.pushEntry("error", title, message);
    this.setNotice(message, "error");
  }

  private showHelp(): void {
    this.pushEntry("meta", "help", buildChatHelpText(thinkingCommandUsage()));
  }

  private async handleProviderCommand(value: string): Promise<boolean> {
    if (!this.requireIdleRun("switching providers")) {
      return true;
    }

    const nextProvider = parseProviderName(value);
    if (!nextProvider) {
      this.showCommandError("config", `Provider must be one of ${formatProviderNameList()}.`);
      return true;
    }

    const nextModel = resolveDefaultPandaModel(nextProvider);

    try {
      const previousProvider = this.providerName;
      this.currentThread = await this.requireServices().store.updateThread(this.currentThreadId, {
        provider: nextProvider,
        model: nextModel,
      });
      this.providerName = nextProvider;
      this.model = nextModel;
      this.pushEntry(
        "meta",
        "config",
        `Provider switched from ${previousProvider} to ${nextProvider}. Model reset to ${this.model}.`,
      );
      this.setNotice(`Provider ${nextProvider} · model ${this.model}`, "info");
    } catch (error) {
      this.showCommandError("config", error instanceof Error ? error.message : String(error));
    }

    return true;
  }

  private async handleModelCommand(value: string): Promise<boolean> {
    if (!this.requireIdleRun("switching models")) {
      return true;
    }

    if (!value) {
      this.showCommandError("config", "Usage: /model <name>");
      return true;
    }

    try {
      this.currentThread = await this.requireServices().store.updateThread(this.currentThreadId, {
        model: value,
      });
      this.model = value;
      this.pushEntry("meta", "config", `Model set to ${value}.`);
      this.setNotice(`Model ${value}`, "info");
    } catch (error) {
      this.showCommandError("config", error instanceof Error ? error.message : String(error));
    }

    return true;
  }

  private async handleThinkingCommand(value: string): Promise<boolean> {
    if (!this.requireIdleRun("changing thinking")) {
      return true;
    }

    if (!value) {
      this.showCommandError("config", `Usage: ${thinkingCommandUsage()}`);
      return true;
    }

    const nextThinking = parseThinkingCommandValue(value);
    if (!nextThinking) {
      this.showCommandError("config", `Thinking must be one of ${thinkingCommandValuesText()}.`);
      return true;
    }

    try {
      this.currentThread = await this.requireServices().store.updateThread(this.currentThreadId, {
        thinking: nextThinking === "off" ? null : nextThinking,
      });
      this.thinking = this.currentThread.thinking;
      if (this.thinking) {
        this.pushEntry("meta", "config", `Thinking set to ${this.thinking}.`);
        this.setNotice(`Thinking ${this.thinking}`, "info");
      } else {
        this.pushEntry("meta", "config", "Thinking disabled.");
        this.setNotice("Thinking off", "info");
      }
    } catch (error) {
      this.showCommandError("config", error instanceof Error ? error.message : String(error));
    }

    return true;
  }

  private async handleCompactCommand(value: string): Promise<boolean> {
    if (!this.requireIdleRun("compacting")) {
      return true;
    }

    try {
      await this.compactCurrentThread(value);
    } catch (error) {
      this.showCommandError("compact", error instanceof Error ? error.message : String(error));
    }

    return true;
  }

  private async handleNewThreadCommand(): Promise<boolean> {
    if (!this.requireIdleRun("creating a new thread")) {
      return true;
    }

    await this.switchThread(await this.requireServices().createThread(this.buildThreadDefaults()));
    this.pushEntry("meta", "session", `Started a fresh thread ${this.currentThreadId}.`);
    this.setNotice(`Started thread ${this.currentThreadId}.`, "info");
    return true;
  }

  private async handleResetThreadCommand(): Promise<boolean> {
    if (!this.requireIdleRun("resetting Panda")) {
      return true;
    }

    try {
      const thread = await this.requireServices().createThread(this.buildThreadDefaults());
      await this.requireServices().setHomeThread(thread.id, thread.agentKey);
      await this.switchThread(thread);
      this.pushEntry("meta", "session", `Reset Panda. New home thread ${this.currentThreadId}.`);
      this.setNotice(`Reset Panda to ${this.currentThreadId}.`, "info");
    } catch (error) {
      this.showCommandError("session", error instanceof Error ? error.message : String(error));
    }

    return true;
  }

  private async handleResumeCommand(value: string): Promise<boolean> {
    if (!this.requireIdleRun("resuming another thread")) {
      return true;
    }

    if (!value) {
      this.showCommandError("session", "Usage: /resume <thread-id>");
      return true;
    }

    try {
      await this.switchThread(await this.requireServices().getThread(value));
      this.pushEntry("meta", "session", `Resumed thread ${this.currentThreadId}.`);
      this.setNotice(`Resumed thread ${this.currentThreadId}.`, "info");
    } catch (error) {
      this.showCommandError("session", error instanceof Error ? error.message : String(error));
    }

    return true;
  }

  private showThreadSummary(): boolean {
    this.pushEntry(
      "meta",
      "session",
      [
        `identity ${this.requireServices().identity.handle}`,
        `thread ${this.currentThreadId}`,
        `provider ${this.providerName}`,
        `model ${this.model}`,
        `thinking ${formatThinkingLevel(this.thinking)}`,
      ].join("\n"),
    );
    return true;
  }

  private async handleAbortCommand(): Promise<boolean> {
    if (!this.isRunning) {
      this.setNotice("No active run to abort.", "info");
      return true;
    }

    if (await this.requireServices().coordinator.abort(this.currentThreadId, "Aborted from the TUI.")) {
      this.setNotice("Aborting the active run...", "info");
    } else {
      this.setNotice("No active run to abort.", "info");
    }

    return true;
  }

  private handleExitCommand(): boolean {
    if (this.isRunning) {
      this.setNotice("Wait for the current turn to finish before exiting.", "info");
      return true;
    }

    return false;
  }

  private handleUnknownCommand(command: string): boolean {
    this.showCommandError("command", describeUnknownCommand(command));
    return true;
  }

  private async submitComposer(): Promise<void> {
    if (this.applySelectedSlashCompletion()) {
      return;
    }

    const message = this.composer.value.trimEnd();
    if (!message.trim()) {
      this.setNotice("Type a message or slash command first.", "info");
      return;
    }

    this.recordHistory(message);
    this.setComposerState(createComposerState());

    if (message.startsWith("/")) {
      const shouldContinue = await this.handleCommand(message);
      if (!shouldContinue) {
        this.close();
      }
      return;
    }

    this.followTranscript = true;
    const externalMessageId = randomUUID();
    this.queuePendingLocalInput(this.currentThreadId, message, externalMessageId);
    if (this.isRunning) {
      this.setNotice("Queued your message for the current thread.", "info");
    }
    void this.submitUserMessage(message, externalMessageId);
  }

  private async handleCommand(commandLine: string): Promise<boolean> {
    return await runChatCommandLine(commandLine, {
      help: () => {
        this.showHelp();
        return true;
      },
      provider: (value) => this.handleProviderCommand(value),
      model: (value) => this.handleModelCommand(value),
      thinking: (value) => this.handleThinkingCommand(value),
      compact: (value) => this.handleCompactCommand(value),
      newThread: () => this.handleNewThreadCommand(),
      resetThread: () => this.handleResetThreadCommand(),
      resume: (value) => this.handleResumeCommand(value),
      showThread: () => this.showThreadSummary(),
      openThreadPicker: async () => {
        await this.openThreadPicker();
        return true;
      },
      abort: () => this.handleAbortCommand(),
      exit: () => this.handleExitCommand(),
      unknown: (command) => this.handleUnknownCommand(command),
    });
  }

  private async submitUserMessage(message: string, externalMessageId: string): Promise<void> {
    const keyMessage = missingApiKeyMessage(this.providerName);
    if (keyMessage) {
      this.removePendingLocalInput(externalMessageId);
      this.pushEntry("error", "auth", keyMessage);
      this.setNotice(keyMessage, "error", 6_000);
      this.render();
      return;
    }

    try {
      await this.requireServices().coordinator.submitInput(this.currentThreadId, {
        message: stringToUserMessage(message),
        source: "tui",
        channelId: "terminal",
        externalMessageId,
        actorId: "local-user",
      });
    } catch (error) {
      this.removePendingLocalInput(externalMessageId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.pushEntry("error", "error", errorMessage);
      this.setNotice(errorMessage, "error", 6_000);
      this.render();
    }
  }

  private enterScreen(): void {
    output.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR_SCREEN);
  }

  private setBracketedPasteMode(enabled: boolean): void {
    output.write(enabled ? BRACKETED_PASTE_ON : BRACKETED_PASTE_OFF);
  }

  private setExtendedKeysMode(enabled: boolean): void {
    // Shift-Enter needs extended key reporting; plain readline only sees Enter.
    output.write(extendedKeysModeSequence(enabled));
  }

  private render(): void {
    if (this.closed) {
      return;
    }

    const view = this.buildView();
    this.scrollTop = view.resolvedScrollTop;
    const visibleTranscript = view.transcriptLines
      .slice(view.resolvedScrollTop, view.resolvedScrollTop + view.transcriptHeight)
      .map((line, index) => {
        const absoluteIndex = view.resolvedScrollTop + index;
        const marker = absoluteIndex === view.selectedTranscriptLine ? theme.gold("› ") : "  ";
        return marker + line.rendered;
      });

    while (visibleTranscript.length < view.transcriptHeight) {
      visibleTranscript.push("");
    }

    const separator = theme.slate("─".repeat(view.width));
    const screenLines = [
      view.headerLine,
      ...visibleTranscript,
      separator,
      view.statusLine,
      view.infoLine.text,
      ...view.pendingLocalInputLines,
      ...view.composerVisibleLines,
    ];
    const infoLineRow = screenLines.length - view.composerVisibleLines.length - view.pendingLocalInputLines.length;
    const composerStartRow = infoLineRow + 1 + view.pendingLocalInputLines.length;
    let cursorRow = composerStartRow + view.composerVisibleCursorRow;
    let cursorColumn = view.composerCursorColumn;

    if (this.historySearch.active || this.transcriptSearch.active) {
      cursorRow = infoLineRow;
      cursorColumn = view.infoLine.cursorColumn ?? cursorColumn;
    }

    output.write(HIDE_CURSOR + CLEAR_SCREEN + screenLines.join("\n"));
    output.write(cursorTo(cursorRow, cursorColumn) + SHOW_CURSOR);
    this.lastSpinnerFrame = this.spinnerFrameIndex();
    this.dirty = false;
  }

  private handlePasteBoundaryKeypress(key: KeyLike): boolean {
    if (key.name === "paste-start") {
      this.inBracketedPaste = true;
      return true;
    }

    if (key.name === "paste-end") {
      this.inBracketedPaste = false;
      return true;
    }

    return false;
  }

  private async handleInterruptKeypress(key: KeyLike): Promise<boolean> {
    if (!(key.ctrl && key.name === "c")) {
      return false;
    }

    if (!this.isRunning) {
      this.close();
      return true;
    }

    if (this.closeAfterRun) {
      this.setNotice("Stopping the active run and closing Panda...", "info");
      return true;
    }

    if (await this.requireServices().coordinator.abort(this.currentThreadId, "Aborted from Ctrl-C.")) {
      this.closeAfterRun = true;
      this.setNotice("Stopping the active run and closing Panda...", "info");
      return true;
    }

    this.close();
    return true;
  }

  private handleTranscriptNavigationKeypress(key: KeyLike): boolean {
    if (key.name === "pageup" || key.name === "pagedown") {
      const delta = Math.max(1, this.buildView().transcriptHeight - 2);
      this.scrollTranscript(key.name === "pageup" ? -delta : delta);
      return true;
    }

    if (key.meta && key.name === "up") {
      this.scrollTranscript(-1);
      return true;
    }

    if (key.meta && key.name === "down") {
      this.scrollTranscript(1);
      return true;
    }

    return false;
  }

  private normalizeKeySequence(sequence: string | undefined, key: KeyLike): string | null {
    const normalized = normalizeTerminalKeySequence({
      pendingSequence: this.pendingExtendedKeySequence,
      sequence,
      key,
    });
    this.pendingExtendedKeySequence = normalized.pendingSequence;
    return normalized.sequence;
  }

  private async handleModalKeypress(sequence: string, key: KeyLike): Promise<boolean> {
    if (this.threadPicker.active) {
      await this.handleThreadPickerKeypress(sequence, key);
      return true;
    }

    if (!this.historySearch.active && !this.transcriptSearch.active && key.ctrl && key.name === "r") {
      this.startHistorySearch();
      return true;
    }

    if (!this.historySearch.active && !this.transcriptSearch.active && key.ctrl && key.name === "f") {
      this.startTranscriptSearch();
      return true;
    }

    if (this.transcriptSearch.active) {
      this.handleTranscriptSearchKeypress(sequence, key);
      return true;
    }

    if (this.historySearch.active) {
      this.handleHistorySearchKeypress(sequence, key);
      return true;
    }

    return false;
  }

  private async handleKeypress(sequence: string | undefined, key: KeyLike): Promise<void> {
    if (this.closed) {
      return;
    }

    const normalizedSequence = this.normalizeKeySequence(sequence, key);
    if (normalizedSequence === null) {
      return;
    }

    if (this.handlePasteBoundaryKeypress(key)) {
      this.render();
      return;
    }

    if (
      await this.handleInterruptKeypress(key) ||
      this.handleTranscriptNavigationKeypress(key) ||
      await this.handleModalKeypress(normalizedSequence, key)
    ) {
      this.render();
      return;
    }

    await this.handleComposerKeypress(normalizedSequence, key);
    this.render();
  }

  private async handleThreadPickerKeypress(sequence: string, key: KeyLike): Promise<void> {
    if (key.name === "escape") {
      this.closeThreadPicker();
      return;
    }

    if (key.name === "return" || sequence === "\r") {
      await this.selectThreadPickerEntry();
      return;
    }

    if (key.name === "up") {
      this.cycleThreadPicker(-1);
      return;
    }

    if (key.name === "down") {
      this.cycleThreadPicker(1);
      return;
    }
  }

  private handleTranscriptSearchKeypress(sequence: string, key: KeyLike): void {
    if (key.name === "escape") {
      this.transcriptSearch.active = false;
      return;
    }

    if (key.name === "return" || sequence === "\r") {
      this.transcriptSearch.active = false;
      return;
    }

    if (key.name === "up") {
      this.cycleTranscriptMatch(-1);
      return;
    }

    if (key.name === "down") {
      this.cycleTranscriptMatch(1);
      return;
    }

    if (key.name === "backspace") {
      this.transcriptSearch.query = this.transcriptSearch.query.slice(0, -1);
      this.transcriptSearch.selected = 0;
      this.ensureSelectedTranscriptMatchVisible(this.buildView());
      return;
    }

    if (isPrintableKey(sequence, key) && sequence !== "\n") {
      this.transcriptSearch.query += sequence;
      this.transcriptSearch.selected = 0;
      this.ensureSelectedTranscriptMatchVisible(this.buildView());
    }
  }

  private handleHistorySearchKeypress(sequence: string, key: KeyLike): void {
    if (key.name === "escape") {
      this.historySearch.active = false;
      return;
    }

    if (key.name === "return" || sequence === "\r") {
      const match = this.currentHistoryMatch();
      if (match) {
        this.setComposerState(setComposerValue(match));
      } else {
        this.setNotice("No history match to load.", "info");
      }
      this.historySearch.active = false;
      return;
    }

    if ((key.ctrl && key.name === "r") || key.name === "up") {
      this.cycleHistoryMatch(1);
      return;
    }

    if (key.name === "down") {
      this.cycleHistoryMatch(-1);
      return;
    }

    if (key.name === "backspace") {
      this.historySearch.query = this.historySearch.query.slice(0, -1);
      this.historySearch.selected = 0;
      return;
    }

    if (isPrintableKey(sequence, key) && sequence !== "\n") {
      this.historySearch.query += sequence;
      this.historySearch.selected = 0;
    }
  }

  private async handleComposerKeypress(sequence: string, key: KeyLike): Promise<void> {
    const enterAction = resolveComposerEnterAction({
      state: this.composer,
      sequence,
      key,
      inBracketedPaste: this.inBracketedPaste,
    });
    if (enterAction === "newline") {
      this.setComposerState(insertText(this.composer, "\n"));
      return;
    }

    if (enterAction === "replace-backslash") {
      this.setComposerState(replaceTrailingBackslashWithNewline(this.composer));
      return;
    }

    if (enterAction === "submit") {
      await this.submitComposer();
      return;
    }

    const metaAction = resolveComposerMetaAction(sequence, key);
    if (metaAction === "word-left") {
      this.setComposerState(moveCursorWordLeft(this.composer));
      return;
    }

    if (metaAction === "word-right") {
      this.setComposerState(moveCursorWordRight(this.composer));
      return;
    }

    if (metaAction === "delete-word-backward") {
      this.setComposerState(deleteWordBackward(this.composer));
      return;
    }

    if (key.name === "escape") {
      if (this.notice) {
        this.notice = null;
        return;
      }

      if (this.transcriptSearch.query) {
        this.clearTranscriptSearch();
        return;
      }

      if (!this.followTranscript) {
        this.jumpTranscriptToBottom();
      }
      return;
    }

    if (key.name === "tab") {
      const context = this.currentSlashContext();
      if (context && context.matches.length > 0) {
        const direction = key.shift ? -1 : 1;
        this.slashCompletionIndex = (this.slashCompletionIndex + direction + context.matches.length) %
          context.matches.length;
      }
      return;
    }

    if (key.name === "backspace") {
      this.setComposerState(backspace(this.composer));
      return;
    }

    if (key.name === "delete") {
      this.setComposerState(deleteForward(this.composer));
      return;
    }

    if (key.name === "left") {
      this.setComposerState(moveCursorLeft(this.composer));
      return;
    }

    if (key.name === "right") {
      this.setComposerState(moveCursorRight(this.composer));
      return;
    }

    if (key.name === "up") {
      this.setComposerState(moveCursorUp(this.composer));
      return;
    }

    if (key.name === "down") {
      this.setComposerState(moveCursorDown(this.composer));
      return;
    }

    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      this.setComposerState(moveCursorLineStart(this.composer));
      return;
    }

    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      this.setComposerState(moveCursorLineEnd(this.composer));
      return;
    }

    if (isPrintableKey(sequence, key)) {
      this.setComposerState(insertText(this.composer, sequence));
    }
  }
}

export async function runChatCli(options: ChatCliOptions = {}): Promise<ChatCliResult> {
  const app = new PandaChatApp(options);
  return await app.run();
}
