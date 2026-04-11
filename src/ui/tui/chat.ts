import readline from "node:readline";
import {stdin as input, stdout as output} from "node:process";

import {resolveModelSelector, type ThinkingLevel, Tool,} from "../../kernel/agent/index.js";
import {buildPandaTools} from "../../personas/panda/definition.js";
import {resolveDefaultPandaModelSelector} from "../../personas/panda/defaults.js";
import {type ChatRuntimeServices, createChatRuntime,} from "./runtime.js";
import {runChatActionsCommandLine, submitChatComposer, submitChatUserMessage,} from "./chat-actions.js";
import {buildChatScreenFrame, buildPandaChatView} from "./chat-render.js";
import {
  appendStoredChatMessages,
  buildChatThreadDefaults,
  createChatTranscriptEntry,
  observeLatestChatRun,
  pendingChatInputsForThread,
  queuePendingChatInput,
  removePendingChatInput,
  resolveChatAgentLabel,
  resolveChatDisplayedCwd,
  resolveInitialChatThread,
} from "./chat-session.js";
import {type SlashCompletionContext,} from "./commands.js";
import {type ComposerState, createComposerState, setComposerValue,} from "./composer.js";
import {
  handleChatComposerKeypress,
  handleChatHistorySearchKeypress,
  handleChatInterruptKeypress,
  handleChatModalKeypress,
  handleChatPasteBoundaryKeypress,
  handleChatThreadPickerKeypress,
  handleChatTranscriptNavigationKeypress,
  handleChatTranscriptSearchKeypress,
} from "./chat-input.js";
import {
  applySelectedChatSlashCompletion,
  cycleChatHistorySelection,
  cycleChatTranscriptSelection,
  findChatHistoryMatches,
  recordChatHistory,
  resolveChatSlashContext,
  resolveCurrentChatHistoryMatch,
  resolveScrolledTranscript,
  resolveSelectedTranscriptMatchScroll,
  resolveTranscriptBottom,
  startChatHistorySearch,
} from "./chat-state.js";
import {
  closeChatThreadPicker,
  cycleChatThreadPicker,
  openChatThreadPicker,
  refreshChatThreadPicker,
  selectChatThreadPickerEntry,
} from "./chat-thread-picker.js";
import {
  type ChatSyncHost,
  handleChatStoreNotification,
  scheduleChatStoredThreadSync,
  syncChatStoredThreadState,
} from "./chat-sync.js";
import {COMPOSER_NEWLINE_HINT, extendedKeysModeSequence, type KeyLike, normalizeTerminalKeySequence,} from "./input.js";
import {type NoticeState, type ViewModel,} from "./chat-view.js";
import {ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR_SCREEN, cursorTo, HIDE_CURSOR, SHOW_CURSOR,} from "./screen.js";
import {
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  type ChatCliOptions,
  type ChatCliResult,
  type EntryRole,
  NOTICE_MS,
  type PendingLocalInput,
  type RunPhase,
  type SearchState,
  SPINNER_FRAME_COUNT,
  type ThreadPickerState,
  TICK_MS,
  type TranscriptEntry,
  type TranscriptLineCacheEntry,
  WELCOME_ENTRY_TEXT,
} from "./chat-shared.js";
import type {ThreadRecord,} from "../../domain/threads/runtime/index.js";

export type {ChatCliOptions, ChatCliResult} from "./chat-shared.js";

export class PandaChatApp {
  private model: string;
  private thinking?: ThinkingLevel;
  private readonly fallbackCwd: string;
  private readonly identity?: string;
  private readonly defaultAgentKey?: string;
  private readonly resumeThreadId?: string;
  private readonly explicitThreadId?: string;
  private readonly dbUrl?: string;
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
  private currentAgentLabel = "Panda";
  private currentTools: readonly Tool[] = [];
  private readonly visibleStoredMessageIds = new Set<string>();
  private readonly transcriptLineCache = new Map<number, TranscriptLineCacheEntry>();
  private runPhase: RunPhase = "idle";
  private runStartedAt = 0;
  private notice: NoticeState | null = null;
  private nextEntryId = 1;
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
    this.model = options.model === undefined
      ? resolveDefaultPandaModelSelector()
      : resolveModelSelector(options.model).canonical;
    this.thinking = options.thinking;
    this.identity = options.identity;
    this.defaultAgentKey = options.agent;
    this.fallbackCwd = process.cwd();
    this.resumeThreadId = options.resume;
    this.explicitThreadId = options.threadId;
    this.dbUrl = options.dbUrl;
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
        if (await this.services?.abortThread(this.currentThreadId, "TUI closed.")) {
          await this.services?.waitForCurrentRun(this.currentThreadId);
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

    const services = this.services;
    const threadId = this.currentThreadId;
    this.closeAfterRunWaitInFlight = true;

    setTimeout(() => {
      if (!this.closeAfterRun || this.closed) {
        this.closeAfterRunWaitInFlight = false;
        return;
      }

      if (!services) {
        this.closeAfterRunWaitInFlight = false;
        this.close();
        return;
      }

      void services.waitForCurrentRun(threadId)
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

  private buildSyncHost(): ChatSyncHost {
    return {
      getCurrentThreadId: () => this.currentThreadId,
      getServices: () => this.services,
      getSyncDebounceTimer: () => this.syncDebounceTimer,
      setSyncDebounceTimer: (timer) => {
        this.syncDebounceTimer = timer;
      },
      getSyncInFlight: () => this.syncInFlight,
      setSyncInFlight: (enabled) => {
        this.syncInFlight = enabled;
      },
      getSyncRequestedWhileBusy: () => this.syncRequestedWhileBusy,
      setSyncRequestedWhileBusy: (enabled) => {
        this.syncRequestedWhileBusy = enabled;
      },
      getLastStoredSyncAt: () => this.lastStoredSyncAt,
      setLastStoredSyncAt: (value) => {
        this.lastStoredSyncAt = value;
      },
      applyLoadedSnapshot: (thread, transcript, runs) => this.applyLoadedSnapshot(thread, transcript, runs),
      requestRender: () => this.requestRender(),
      isClosed: () => this.closed,
      isThreadPickerActive: () => this.threadPicker.active,
      refreshThreadPicker: () => this.refreshThreadPicker(),
    };
  }

  scheduleSyncStoredThreadState(delayMs = 150): void {
    scheduleChatStoredThreadSync(this.buildSyncHost(), delayMs);
  }

  private refreshToolCatalog(): void {
    this.currentTools = buildPandaTools();
  }

  private resolveDisplayedCwd(): string {
    return resolveChatDisplayedCwd(this.currentThread, this.fallbackCwd);
  }

  private async initializeRuntime(): Promise<void> {
    this.services = await createChatRuntime({
      model: this.model,
      identity: this.identity,
      agent: this.defaultAgentKey,
      dbUrl: this.dbUrl,
      onStoreNotification: (notification) => this.handleStoreNotification(notification.threadId),
    });

    await this.switchThread(await this.resolveInitialThread());
  }

  private async resolveInitialThread(): Promise<ThreadRecord> {
    return await resolveInitialChatThread({
      services: this.requireServices(),
      resumeThreadId: this.resumeThreadId,
      explicitThreadId: this.explicitThreadId,
      defaults: this.buildThreadDefaults(),
    });
  }

  private buildThreadDefaults(overrides: Partial<{
    id: string;
    agentKey: string;
    model: string;
    thinking: ThinkingLevel;
  }> = {}): {
    id?: string;
    agentKey?: string;
    model: string;
    thinking?: ThinkingLevel;
  } {
    return buildChatThreadDefaults({
      defaultAgentKey: this.defaultAgentKey,
      model: this.model,
      thinking: this.thinking,
      overrides,
    });
  }

  private async resolveAgentLabel(agentKey: string): Promise<string> {
    return await resolveChatAgentLabel(this.services, agentKey);
  }

  private async switchThread(thread: ThreadRecord): Promise<void> {
    this.currentThread = thread;
    this.currentThreadId = thread.id;
    this.currentAgentLabel = await this.resolveAgentLabel(thread.agentKey);
    this.model = thread.model ?? this.model;
    this.thinking = thread.thinking;
    this.runPhase = "idle";
    this.lastObservedRunStatusKey = null;
    this.refreshToolCatalog();
    await this.reloadVisibleTranscript();
    await this.syncStoredThreadState(true);
  }

  private createTranscriptEntry(role: EntryRole, title: string, body: string): TranscriptEntry {
    const created = createChatTranscriptEntry({
      nextEntryId: this.nextEntryId,
      role,
      title,
      body,
    });
    this.nextEntryId = created.nextEntryId;
    return created.entry;
  }

  private appendStoredMessages(records: Parameters<typeof appendStoredChatMessages>[0]["records"]): void {
    const appended = appendStoredChatMessages({
      records,
      visibleStoredMessageIds: this.visibleStoredMessageIds,
      currentTools: this.currentTools,
      nextEntryId: this.nextEntryId,
    });
    this.nextEntryId = appended.nextEntryId;

    for (const pendingInputId of appended.acknowledgedPendingInputIds) {
      this.removePendingLocalInput(pendingInputId);
    }

    if (appended.entries.length === 0) {
      return;
    }

    this.transcript.push(...appended.entries);
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
    this.setNotice("Compacting conversation...", "info");
    this.requestRender();
    const compacted = await services.compactThread(threadId, customInstructions);

    if (!compacted.compacted) {
      this.setNotice("Not enough older context to compact yet.", "info");
      return;
    }

    await this.syncStoredThreadState(true);
    const compactLabel =
      `Compacted older context (${this.formatCompactTokenCount(compacted.tokensBefore ?? 0)} -> ${this.formatCompactTokenCount(compacted.tokensAfter ?? 0)}).`;
    this.pushEntry("meta", "compact", `${compactLabel} Preserved the most recent user turns verbatim.`);
    this.setNotice(compactLabel, "info", 6_000);
  }

  private observeLatestRun(runs: Parameters<typeof observeLatestChatRun>[0]["runs"]): void {
    const observed = observeLatestChatRun({
      runs,
      lastObservedRunStatusKey: this.lastObservedRunStatusKey,
      currentRunStartedAt: this.runStartedAt,
    });
    if (!observed.changed) {
      return;
    }

    this.lastObservedRunStatusKey = observed.lastObservedRunStatusKey;
    this.runPhase = observed.runPhase;
    this.runStartedAt = observed.runStartedAt;
    this.markDirty();

    if (observed.errorNotice) {
      this.setNotice(observed.errorNotice, "error", 6_000);
    }

    if (observed.shouldScheduleCloseAfterRun) {
      this.scheduleCloseAfterRun();
    }
  }

  private applyLoadedSnapshot(
    thread: ThreadRecord,
    transcript: Parameters<typeof appendStoredChatMessages>[0]["records"],
    runs: Parameters<typeof observeLatestChatRun>[0]["runs"],
  ): void {
    this.currentThread = thread;
    this.model = thread.model ?? this.model;
    this.thinking = thread.thinking;
    this.refreshToolCatalog();
    this.markDirty();
    this.appendStoredMessages(transcript);
    this.observeLatestRun(runs);
  }

  private queuePendingLocalInput(threadId: string, text: string, id: string): void {
    queuePendingChatInput(this.pendingLocalInputs, threadId, text, id);
    this.markDirty();
  }

  private removePendingLocalInput(id: string): void {
    if (removePendingChatInput(this.pendingLocalInputs, id)) {
      this.markDirty();
    }
  }

  private pendingInputsForCurrentThread(): readonly PendingLocalInput[] {
    return pendingChatInputsForThread(this.pendingLocalInputs, this.currentThreadId);
  }

  private async syncStoredThreadState(force = false): Promise<void> {
    await syncChatStoredThreadState(this.buildSyncHost(), force);
  }

  private async handleStoreNotification(threadId: string): Promise<void> {
    await handleChatStoreNotification(this.buildSyncHost(), threadId);
  }

  private async refreshThreadPicker(): Promise<void> {
    await refreshChatThreadPicker({
      threadPicker: this.threadPicker,
      getCurrentThreadId: () => this.currentThreadId,
      isRunning: () => this.isRunning,
      requireServices: () => this.requireServices(),
      switchThread: (thread) => this.switchThread(thread),
      render: () => this.render(),
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
      getRefreshInFlight: () => this.threadPickerRefreshInFlight,
      setRefreshInFlight: (enabled) => {
        this.threadPickerRefreshInFlight = enabled;
      },
      getRefreshRequested: () => this.threadPickerRefreshRequested,
      setRefreshRequested: (enabled) => {
        this.threadPickerRefreshRequested = enabled;
      },
    });
  }

  private async openThreadPicker(): Promise<void> {
    await openChatThreadPicker({
      threadPicker: this.threadPicker,
      getCurrentThreadId: () => this.currentThreadId,
      isRunning: () => this.isRunning,
      requireServices: () => this.requireServices(),
      switchThread: (thread) => this.switchThread(thread),
      render: () => this.render(),
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
      getRefreshInFlight: () => this.threadPickerRefreshInFlight,
      setRefreshInFlight: (enabled) => {
        this.threadPickerRefreshInFlight = enabled;
      },
      getRefreshRequested: () => this.threadPickerRefreshRequested,
      setRefreshRequested: (enabled) => {
        this.threadPickerRefreshRequested = enabled;
      },
    });
  }

  private closeThreadPicker(): void {
    closeChatThreadPicker(this.threadPicker, (enabled) => {
      this.threadPickerRefreshRequested = enabled;
    });
  }

  private cycleThreadPicker(delta: number): void {
    cycleChatThreadPicker(this.threadPicker, delta);
  }

  private async selectThreadPickerEntry(): Promise<void> {
    await selectChatThreadPickerEntry({
      threadPicker: this.threadPicker,
      getCurrentThreadId: () => this.currentThreadId,
      isRunning: () => this.isRunning,
      requireServices: () => this.requireServices(),
      switchThread: (thread) => this.switchThread(thread),
      render: () => this.render(),
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
      getRefreshInFlight: () => this.threadPickerRefreshInFlight,
      setRefreshInFlight: (enabled) => {
        this.threadPickerRefreshInFlight = enabled;
      },
      getRefreshRequested: () => this.threadPickerRefreshRequested,
      setRefreshRequested: (enabled) => {
        this.threadPickerRefreshRequested = enabled;
      },
    });
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

  private relayNotice(text: string, tone: NoticeState["tone"], durationMs?: number): void {
    if (durationMs === undefined) {
      this.setNotice(text, tone);
      return;
    }

    this.setNotice(text, tone, durationMs);
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

  private setComposerState(next: ComposerState): void {
    this.composer = next;
    this.markDirty();
    this.currentSlashContext();
  }

  private resetTranscriptView(options: { keepSeenMessages?: boolean } = {}): void {
    this.transcript.length = 0;
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
    return findChatHistoryMatches(this.inputHistory, this.historySearch.query);
  }

  private currentHistoryMatch(): string | null {
    return resolveCurrentChatHistoryMatch(this.inputHistory, this.historySearch);
  }

  private buildView(): ViewModel {
    this.clearExpiredNotice();
    const historyMatches = this.historyMatches();
    const slashContext = this.currentSlashContext();

    return buildPandaChatView({
      terminalWidth: output.columns || 100,
      terminalRows: output.rows || 32,
      transcript: this.transcript,
      transcriptLineCache: this.transcriptLineCache,
      shouldShowSplash: this.shouldShowSplash,
      model: this.model,
      thinking: this.thinking,
      cwd: this.resolveDisplayedCwd(),
      threadPicker: this.threadPicker,
      currentThreadId: this.currentThreadId,
      pendingLocalInputs: this.pendingInputsForCurrentThread(),
      composer: this.composer,
      historySearch: this.historySearch,
      transcriptSearch: this.transcriptSearch,
      historyMatchCount: historyMatches.length,
      historyPreview: this.currentHistoryMatch(),
      notice: this.notice,
      slashContext,
      slashCompletionIndex: this.slashCompletionIndex,
      followTranscript: this.followTranscript,
      scrollTop: this.scrollTop,
      isRunning: this.isRunning,
      runStartedAt: this.runStartedAt,
      agentLabel: this.currentAgentLabel,
      identityHandle: this.services?.identity?.handle ?? this.identity ?? "local",
      modeLabel: this.modeLabel,
    });
  }

  private currentSlashContext(): SlashCompletionContext | null {
    const resolved = resolveChatSlashContext({
      value: this.composer.value,
      cursor: this.composer.cursor,
      lastSlashToken: this.lastSlashToken,
      slashCompletionIndex: this.slashCompletionIndex,
    });
    this.lastSlashToken = resolved.lastSlashToken;
    this.slashCompletionIndex = resolved.slashCompletionIndex;
    return resolved.context;
  }

  private ensureSelectedTranscriptMatchVisible(view: ViewModel): void {
    const scrollTop = resolveSelectedTranscriptMatchScroll(view);
    if (scrollTop === null) {
      return;
    }

    this.followTranscript = false;
    this.scrollTop = scrollTop;
  }

  private scrollTranscript(delta: number): void {
    const resolved = resolveScrolledTranscript({
      view: this.buildView(),
      delta,
    });
    this.followTranscript = resolved.followTranscript;
    this.scrollTop = resolved.scrollTop;
    this.markDirty();
  }

  private jumpTranscriptToBottom(): void {
    const resolved = resolveTranscriptBottom(this.buildView());
    this.followTranscript = resolved.followTranscript;
    this.scrollTop = resolved.scrollTop;
    this.markDirty();
  }

  private startHistorySearch(): void {
    const result = startChatHistorySearch(this.inputHistory);
    if (!result.started) {
      this.setNotice(result.notice, "info");
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
    this.historySearch.selected = cycleChatHistorySelection(this.historySearch, this.inputHistory, delta);
  }

  private cycleTranscriptMatch(delta: number): void {
    const view = this.buildView();
    this.transcriptSearch.selected = cycleChatTranscriptSelection(this.transcriptSearch, view, delta);
    this.ensureSelectedTranscriptMatchVisible(view);
  }

  private applySelectedSlashCompletion(): boolean {
    const applied = applySelectedChatSlashCompletion({
      composerValue: this.composer.value,
      composerCursor: this.composer.cursor,
      context: this.currentSlashContext(),
      slashCompletionIndex: this.slashCompletionIndex,
    });
    if (!applied.applied) {
      return false;
    }

    this.setComposerState(setComposerValue(applied.value, applied.cursor));
    return true;
  }

  private recordHistory(value: string): void {
    recordChatHistory(this.inputHistory, value);
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

  private async submitComposer(): Promise<void> {
    await submitChatComposer({
      applySelectedSlashCompletion: () => this.applySelectedSlashCompletion(),
      getComposerValue: () => this.composer.value,
      recordHistory: (value) => this.recordHistory(value),
      clearComposer: () => this.setComposerState(createComposerState()),
      handleCommand: (commandLine) => this.handleCommand(commandLine),
      close: () => this.close(),
      setFollowTranscript: (enabled) => {
        this.followTranscript = enabled;
      },
      getCurrentThreadId: () => this.currentThreadId,
      isRunning: () => this.isRunning,
      queuePendingLocalInput: (threadId, text, id) => this.queuePendingLocalInput(threadId, text, id),
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
      submitUserMessage: (message, externalMessageId) => this.submitUserMessage(message, externalMessageId),
    });
  }

  private async handleCommand(commandLine: string): Promise<boolean> {
    return await runChatActionsCommandLine(commandLine, {
      getCurrentThreadId: () => this.currentThreadId,
      getModel: () => this.model,
      getThinking: () => this.thinking,
      getDefaultAgentKey: () => this.defaultAgentKey,
      isRunning: () => this.isRunning,
      requireServices: () => this.requireServices(),
      requireIdleRun: (action) => this.requireIdleRun(action),
      buildThreadDefaults: () => this.buildThreadDefaults(),
      switchThread: (thread) => this.switchThread(thread),
      compactCurrentThread: (customInstructions) => this.compactCurrentThread(customInstructions),
      openThreadPicker: () => this.openThreadPicker(),
      setCurrentThread: (thread) => {
        this.currentThread = thread;
        this.currentThreadId = thread.id;
        this.model = thread.model ?? this.model;
        this.thinking = thread.thinking;
      },
      setModel: (model) => {
        this.model = model;
      },
      setThinking: (thinking) => {
        this.thinking = thinking;
      },
      pushEntry: (role, title, body) => {
        this.pushEntry(role, title, body);
      },
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
      showCommandError: (title, message) => this.showCommandError(title, message),
    });
  }

  private async submitUserMessage(message: string, externalMessageId: string): Promise<void> {
    await submitChatUserMessage({
      getModel: () => this.model,
      getCurrentThreadId: () => this.currentThreadId,
      requireServices: () => this.requireServices(),
      removePendingLocalInput: (id) => this.removePendingLocalInput(id),
      pushEntry: (role, title, body) => {
        this.pushEntry(role, title, body);
      },
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
      render: () => this.render(),
    }, message, externalMessageId);
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
    const frame = buildChatScreenFrame({
      view,
      historySearchActive: this.historySearch.active,
      transcriptSearchActive: this.transcriptSearch.active,
    });

    output.write(HIDE_CURSOR + CLEAR_SCREEN + frame.screenLines.join("\n"));
    output.write(cursorTo(frame.cursorRow, frame.cursorColumn) + SHOW_CURSOR);
    this.lastSpinnerFrame = this.spinnerFrameIndex();
    this.dirty = false;
  }

  private handlePasteBoundaryKeypress(key: KeyLike): boolean {
    return handleChatPasteBoundaryKeypress({
      setInBracketedPaste: (enabled) => {
        this.inBracketedPaste = enabled;
      },
    }, key);
  }

  private async handleInterruptKeypress(key: KeyLike): Promise<boolean> {
    return await handleChatInterruptKeypress({
      isRunning: () => this.isRunning,
      shouldCloseAfterRun: () => this.closeAfterRun,
      setCloseAfterRun: (enabled) => {
        this.closeAfterRun = enabled;
      },
      getCurrentThreadId: () => this.currentThreadId,
      requireServices: () => this.requireServices(),
      close: () => this.close(),
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
    }, key);
  }

  private handleTranscriptNavigationKeypress(key: KeyLike): boolean {
    return handleChatTranscriptNavigationKeypress({
      buildView: () => this.buildView(),
      scrollTranscript: (delta) => this.scrollTranscript(delta),
    }, key);
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
    return await handleChatModalKeypress({
      isThreadPickerActive: () => this.threadPicker.active,
      isHistorySearchActive: () => this.historySearch.active,
      isTranscriptSearchActive: () => this.transcriptSearch.active,
      handleThreadPickerKeypress: (nextSequence, nextKey) => this.handleThreadPickerKeypress(nextSequence, nextKey),
      startHistorySearch: () => this.startHistorySearch(),
      startTranscriptSearch: () => this.startTranscriptSearch(),
      handleTranscriptSearchKeypress: (nextSequence, nextKey) =>
        this.handleTranscriptSearchKeypress(nextSequence, nextKey),
      handleHistorySearchKeypress: (nextSequence, nextKey) =>
        this.handleHistorySearchKeypress(nextSequence, nextKey),
    }, sequence, key);
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
    await handleChatThreadPickerKeypress({
      closeThreadPicker: () => this.closeThreadPicker(),
      selectThreadPickerEntry: () => this.selectThreadPickerEntry(),
      cycleThreadPicker: (delta) => this.cycleThreadPicker(delta),
    }, sequence, key);
  }

  private handleTranscriptSearchKeypress(sequence: string, key: KeyLike): void {
    handleChatTranscriptSearchKeypress({
      transcriptSearch: this.transcriptSearch,
      clearTranscriptSearch: () => this.clearTranscriptSearch(),
      cycleTranscriptMatch: (delta) => this.cycleTranscriptMatch(delta),
      buildView: () => this.buildView(),
      ensureSelectedTranscriptMatchVisible: (view) => this.ensureSelectedTranscriptMatchVisible(view),
    }, sequence, key);
  }

  private handleHistorySearchKeypress(sequence: string, key: KeyLike): void {
    handleChatHistorySearchKeypress({
      historySearch: this.historySearch,
      currentHistoryMatch: () => this.currentHistoryMatch(),
      setComposerValue: (value) => this.setComposerState(setComposerValue(value)),
      cycleHistoryMatch: (delta) => this.cycleHistoryMatch(delta),
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
    }, sequence, key);
  }

  private async handleComposerKeypress(sequence: string, key: KeyLike): Promise<void> {
    await handleChatComposerKeypress({
      composer: this.composer,
      isInBracketedPaste: () => this.inBracketedPaste,
      setComposerState: (next) => this.setComposerState(next),
      submitComposer: () => this.submitComposer(),
      hasNotice: () => Boolean(this.notice),
      clearNotice: () => {
        this.notice = null;
      },
      hasTranscriptSearchQuery: () => Boolean(this.transcriptSearch.query),
      clearTranscriptSearch: () => this.clearTranscriptSearch(),
      followTranscript: () => this.followTranscript,
      jumpTranscriptToBottom: () => this.jumpTranscriptToBottom(),
      currentSlashContext: () => this.currentSlashContext(),
      getSlashCompletionIndex: () => this.slashCompletionIndex,
      setSlashCompletionIndex: (index) => {
        this.slashCompletionIndex = index;
      },
    }, sequence, key);
  }
}

export async function runChatCli(options: ChatCliOptions = {}): Promise<ChatCliResult> {
  const app = new PandaChatApp(options);
  return await app.run();
}
