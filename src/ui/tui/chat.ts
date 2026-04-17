import {stdin as input, stdout as output} from "node:process";

import {type ThinkingLevel, Tool,} from "../../kernel/agent/index.js";
import {buildDefaultAgentTools} from "../../panda/definition.js";
import {resolveDefaultAgentModelSelector} from "../../panda/defaults.js";
import {type ChatRuntimeServices, createChatRuntime,} from "./runtime.js";
import {runChatActionsCommandLine, submitChatComposer, submitChatUserMessage,} from "./chat-actions.js";
import {buildChatScreenFrame, buildChatView} from "./chat-render.js";
import {
    appendStoredChatMessages,
    buildChatSessionDefaults,
    createChatTranscriptEntry,
    observeLatestChatRun,
    pendingChatInputsForThread,
    queuePendingChatInput,
    removePendingChatInput,
    resolveChatDisplayedCwd,
    resolveInitialChatSessionThread,
    resolveStoredChatDisplayConfig,
} from "./chat-session.js";
import {type SlashCompletionContext,} from "./commands.js";
import {type ComposerState, createComposerState, setComposerValue,} from "./composer.js";
import {
    handleChatComposerKeypress,
    handleChatHistorySearchKeypress,
    handleChatInterruptKeypress,
    handleChatModalKeypress,
    handleChatPasteBoundaryKeypress,
    handleChatSessionPickerKeypress,
    handleChatTranscriptNavigationKeypress,
    handleChatTranscriptSearchKeypress,
} from "./chat-input.js";
import {
    applySelectedChatSlashCompletion,
    clearExpiredChatNotice,
    createChatNotice,
    cycleChatHistorySelection,
    cycleChatTranscriptSelection,
    findChatHistoryMatches,
    recordChatHistory,
    resetChatTranscriptState,
    resolveChatModeLabel,
    resolveChatSlashContext,
    resolveCurrentChatHistoryMatch,
    resolveScrolledTranscript,
    resolveSelectedTranscriptMatchScroll,
    resolveTranscriptBottom,
    startChatHistorySearch,
} from "./chat-state.js";
import {
    attachChatTerminal,
    type ChatCleanupHost,
    type ChatCloseAfterRunHost,
    type ChatRenderTickerHost,
    cleanupChatTerminal,
    scheduleChatCloseAfterRun,
    startChatRenderTicker,
} from "./chat-lifecycle.js";
import {
    closeChatSessionPicker,
    cycleChatSessionPicker,
    openChatSessionPicker,
    refreshChatSessionPicker,
    selectChatSessionPickerEntry,
} from "./chat-session-picker.js";
import {
    type ChatSyncHost,
    handleChatStoreNotification,
    scheduleChatStoredThreadSync,
    syncChatStoredThreadState,
} from "./chat-sync.js";
import {COMPOSER_NEWLINE_HINT, type KeyLike, normalizeTerminalKeySequence,} from "./input.js";
import {type NoticeState, type ViewModel,} from "./chat-view.js";
import {CLEAR_SCREEN, cursorTo, HIDE_CURSOR, SHOW_CURSOR,} from "./screen.js";
import {
    type ChatCliOptions,
    type ChatCliResult,
    type EntryRole,
    NOTICE_MS,
    type PendingLocalInput,
    type RunPhase,
    type SearchState,
    type SessionPickerState,
    SPINNER_FRAME_COUNT,
    TICK_MS,
    type TranscriptEntry,
    type TranscriptLineCacheEntry,
    WELCOME_ENTRY_TEXT,
} from "./chat-shared.js";
import type {ThreadRecord,} from "../../domain/threads/runtime/index.js";

export type {ChatCliOptions, ChatCliResult} from "./chat-shared.js";

function readAgentKeyFromThreadContext(thread: ThreadRecord): string {
  if (typeof thread.context !== "object" || thread.context === null || Array.isArray(thread.context)) {
    return "unknown";
  }

  const agentKey = (thread.context as Record<string, unknown>).agentKey;
  return typeof agentKey === "string" && agentKey.trim() ? agentKey : "unknown";
}

export class ChatApp {
  private model: string;
  private thinking?: ThinkingLevel;
  private readonly fallbackCwd: string;
  private readonly identity?: string;
  private readonly defaultAgentKey?: string;
  private readonly initialSessionId?: string;
  private readonly dbUrl?: string;
  private readonly transcript: TranscriptEntry[] = [];
  private readonly pendingLocalInputs: PendingLocalInput[] = [];
  private readonly inputHistory: string[] = [];
  private composer: ComposerState = createComposerState();
  private readonly historySearch: SearchState = { active: false, query: "", selected: 0 };
  private readonly transcriptSearch: SearchState = { active: false, query: "", selected: 0 };
  private readonly sessionPicker: SessionPickerState = {
    active: false,
    loading: false,
    selected: 0,
    sessions: [],
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
  private mainLoopResolver: (() => void) | null = null;
  private closed = false;
  private syncInFlight = false;
  private syncRequestedWhileBusy = false;
  private lastStoredSyncAt = 0;
  private lastObservedRunStatusKey: string | null = null;
  private sessionPickerRefreshInFlight = false;
  private sessionPickerRefreshRequested = false;
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
    this.model = resolveDefaultAgentModelSelector();
    this.thinking = options.thinking;
    this.identity = options.identity;
    this.defaultAgentKey = options.agent;
    this.fallbackCwd = process.cwd();
    this.initialSessionId = options.session;
    this.dbUrl = options.dbUrl;
  }

  async run(): Promise<ChatCliResult> {
    if (!input.isTTY || !output.isTTY) {
      throw new Error("Panda chat requires an interactive terminal.");
    }

    await this.initializeRuntime();

    attachChatTerminal({
      input,
      output,
      keypressHandler: this.keypressHandler,
      resizeHandler: this.resizeHandler,
    });
    this.ticker = startChatRenderTicker(this.buildRenderTickerHost(), TICK_MS);

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
        `Opened session ${this.currentThread?.sessionId ?? "-"}. Loaded ${this.transcript.length} transcript entries.`,
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
      sessionId: this.currentThread?.sessionId || undefined,
      threadId: this.currentThreadId || undefined,
    };
  }

  private async cleanup(): Promise<void> {
    await cleanupChatTerminal({
      input,
      output,
      keypressHandler: this.keypressHandler,
      resizeHandler: this.resizeHandler,
      host: this.buildCleanupHost(),
    });
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
    scheduleChatCloseAfterRun(this.buildCloseAfterRunHost());
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

  private buildRenderTickerHost(): ChatRenderTickerHost {
    return {
      isClosed: () => this.closed,
      isDirty: () => this.dirty,
      getNotice: () => this.notice,
      getLastSpinnerFrame: () => this.lastSpinnerFrame,
      spinnerFrameIndex: () => this.spinnerFrameIndex(),
      render: () => this.render(),
    };
  }

  private buildCloseAfterRunHost(): ChatCloseAfterRunHost {
    return {
      shouldCloseAfterRun: () => this.closeAfterRun,
      isClosed: () => this.closed,
      isRunning: () => this.isRunning,
      isWaitingForCloseAfterRun: () => this.closeAfterRunWaitInFlight,
      setWaitingForCloseAfterRun: (enabled) => {
        this.closeAfterRunWaitInFlight = enabled;
      },
      getServices: () => this.services,
      getCurrentThreadId: () => this.currentThreadId,
      close: () => this.close(),
    };
  }

  private buildCleanupHost(): ChatCleanupHost {
    return {
      getTicker: () => this.ticker,
      setTicker: (timer) => {
        this.ticker = timer;
      },
      getSyncDebounceTimer: () => this.syncDebounceTimer,
      setSyncDebounceTimer: (timer) => {
        this.syncDebounceTimer = timer;
      },
      getRunPhase: () => this.runPhase,
      getCurrentThreadId: () => this.currentThreadId,
      getServices: () => this.services,
    };
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
      isSessionPickerActive: () => this.sessionPicker.active,
      refreshSessionPicker: () => this.refreshSessionPicker(),
    };
  }

  scheduleSyncStoredThreadState(delayMs = 150): void {
    scheduleChatStoredThreadSync(this.buildSyncHost(), delayMs);
  }

  private refreshToolCatalog(): void {
    this.currentTools = buildDefaultAgentTools();
  }

  private resolveDisplayedCwd(): string {
    return resolveChatDisplayedCwd(this.currentThread, this.fallbackCwd);
  }

  private async initializeRuntime(): Promise<void> {
    this.services = await createChatRuntime({
      identity: this.identity,
      agent: this.defaultAgentKey,
      dbUrl: this.dbUrl,
      onStoreNotification: (notification) => this.handleStoreNotification(notification.threadId),
    });

    await this.switchThread(await this.resolveInitialThread());
  }

  private async resolveInitialThread(): Promise<ThreadRecord> {
    return await resolveInitialChatSessionThread({
      services: this.requireServices(),
      sessionId: this.initialSessionId,
      defaults: this.buildSessionDefaults(),
    });
  }

  private buildSessionDefaults(overrides: Partial<{
    sessionId: string;
    agentKey: string;
    model: string;
    thinking: ThinkingLevel;
  }> = {}): {
    sessionId?: string;
    agentKey?: string;
    model?: string;
    thinking?: ThinkingLevel;
  } {
    return buildChatSessionDefaults({
      defaultAgentKey: this.defaultAgentKey,
      model: this.currentThread?.model,
      thinking: this.thinking,
      overrides,
    });
  }

  private async switchThread(thread: ThreadRecord): Promise<void> {
    const displayConfig = resolveStoredChatDisplayConfig(thread);
    this.currentThread = thread;
    this.currentThreadId = thread.id;
    this.currentAgentLabel = readAgentKeyFromThreadContext(thread);
    this.model = displayConfig.model;
    this.thinking = displayConfig.thinking;
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
    const displayConfig = resolveStoredChatDisplayConfig(thread);
    this.currentThread = thread;
    this.currentThreadId = thread.id;
    this.currentAgentLabel = readAgentKeyFromThreadContext(thread);
    this.model = displayConfig.model;
    this.thinking = displayConfig.thinking;
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

  private async refreshSessionPicker(): Promise<void> {
    await refreshChatSessionPicker({
      sessionPicker: this.sessionPicker,
      getCurrentSessionId: () => this.currentThread?.sessionId ?? "",
      getCurrentAgentKey: () => this.currentThread ? readAgentKeyFromThreadContext(this.currentThread) : "",
      isRunning: () => this.isRunning,
      requireServices: () => this.requireServices(),
      switchThread: (thread) => this.switchThread(thread),
      render: () => this.render(),
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
      getRefreshInFlight: () => this.sessionPickerRefreshInFlight,
      setRefreshInFlight: (enabled) => {
        this.sessionPickerRefreshInFlight = enabled;
      },
      getRefreshRequested: () => this.sessionPickerRefreshRequested,
      setRefreshRequested: (enabled) => {
        this.sessionPickerRefreshRequested = enabled;
      },
    });
  }

  private async openSessionPicker(): Promise<void> {
    await openChatSessionPicker({
      sessionPicker: this.sessionPicker,
      getCurrentSessionId: () => this.currentThread?.sessionId ?? "",
      getCurrentAgentKey: () => this.currentThread ? readAgentKeyFromThreadContext(this.currentThread) : "",
      isRunning: () => this.isRunning,
      requireServices: () => this.requireServices(),
      switchThread: (thread) => this.switchThread(thread),
      render: () => this.render(),
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
      getRefreshInFlight: () => this.sessionPickerRefreshInFlight,
      setRefreshInFlight: (enabled) => {
        this.sessionPickerRefreshInFlight = enabled;
      },
      getRefreshRequested: () => this.sessionPickerRefreshRequested,
      setRefreshRequested: (enabled) => {
        this.sessionPickerRefreshRequested = enabled;
      },
    });
  }

  private closeSessionPicker(): void {
    closeChatSessionPicker(this.sessionPicker, (enabled) => {
      this.sessionPickerRefreshRequested = enabled;
    });
  }

  private cycleSessionPicker(delta: number): void {
    cycleChatSessionPicker(this.sessionPicker, delta);
  }

  private async selectSessionPickerEntry(): Promise<void> {
    await selectChatSessionPickerEntry({
      sessionPicker: this.sessionPicker,
      getCurrentSessionId: () => this.currentThread?.sessionId ?? "",
      getCurrentAgentKey: () => this.currentThread ? readAgentKeyFromThreadContext(this.currentThread) : "",
      isRunning: () => this.isRunning,
      requireServices: () => this.requireServices(),
      switchThread: (thread) => this.switchThread(thread),
      render: () => this.render(),
      setNotice: (text, tone, durationMs) => this.relayNotice(text, tone, durationMs),
      getRefreshInFlight: () => this.sessionPickerRefreshInFlight,
      setRefreshInFlight: (enabled) => {
        this.sessionPickerRefreshInFlight = enabled;
      },
      getRefreshRequested: () => this.sessionPickerRefreshRequested,
      setRefreshRequested: (enabled) => {
        this.sessionPickerRefreshRequested = enabled;
      },
    });
  }

  private get modeLabel(): string {
    return resolveChatModeLabel({
      sessionPickerActive: this.sessionPicker.active,
      historySearchActive: this.historySearch.active,
      transcriptSearchActive: this.transcriptSearch.active,
    });
  }

  private get isRunning(): boolean {
    return this.runPhase !== "idle";
  }

  private get shouldShowSplash(): boolean {
    return this.transcript.length === 1 && this.transcript[0]?.title === "welcome";
  }

  private setNotice(text: string, tone: NoticeState["tone"], durationMs = NOTICE_MS): void {
    this.notice = createChatNotice(text, tone, durationMs);
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
    const nextNotice = clearExpiredChatNotice(this.notice);
    if (nextNotice !== this.notice) {
      this.notice = nextNotice;
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
    const reset = resetChatTranscriptState({
      transcript: this.transcript,
      transcriptLineCache: this.transcriptLineCache,
      visibleStoredMessageIds: this.visibleStoredMessageIds,
      transcriptSearch: this.transcriptSearch,
      keepSeenMessages: options.keepSeenMessages,
    });
    this.followTranscript = reset.followTranscript;
    this.scrollTop = reset.scrollTop;
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

    return buildChatView({
      terminalWidth: output.columns || 100,
      terminalRows: output.rows || 32,
      transcript: this.transcript,
      transcriptLineCache: this.transcriptLineCache,
      shouldShowSplash: this.shouldShowSplash,
      model: this.model,
      thinking: this.thinking,
      cwd: this.resolveDisplayedCwd(),
      sessionPicker: this.sessionPicker,
      currentSessionId: this.currentThread?.sessionId ?? "",
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
      identityHandle: this.services?.identity?.handle ?? this.identity ?? "-",
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
      getCurrentSessionId: () => this.currentThread?.sessionId ?? "",
      getCurrentAgentKey: () => this.currentThread ? readAgentKeyFromThreadContext(this.currentThread) : "",
      getModel: () => this.model,
      getThinking: () => this.thinking,
      isRunning: () => this.isRunning,
      requireServices: () => this.requireServices(),
      requireIdleRun: (action) => this.requireIdleRun(action),
      buildSessionDefaults: () => this.buildSessionDefaults(),
      switchThread: (thread) => this.switchThread(thread),
      compactCurrentThread: (customInstructions) => this.compactCurrentThread(customInstructions),
      openSessionPicker: () => this.openSessionPicker(),
      setCurrentThread: (thread) => {
        this.currentThread = thread;
        this.currentThreadId = thread.id;
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
      isSessionPickerActive: () => this.sessionPicker.active,
      isHistorySearchActive: () => this.historySearch.active,
      isTranscriptSearchActive: () => this.transcriptSearch.active,
      handleSessionPickerKeypress: (nextSequence, nextKey) => this.handleSessionPickerKeypress(nextSequence, nextKey),
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

  private async handleSessionPickerKeypress(sequence: string, key: KeyLike): Promise<void> {
    await handleChatSessionPickerKeypress({
      closeSessionPicker: () => this.closeSessionPicker(),
      selectSessionPickerEntry: () => this.selectSessionPickerEntry(),
      cycleSessionPicker: (delta) => this.cycleSessionPicker(delta),
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
  const app = new ChatApp(options);
  return await app.run();
}
