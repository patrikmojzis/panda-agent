import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";

import {
  assertProviderName,
  estimateTokensFromString,
  formatProviderNameList,
  getProviderConfig,
  hasAnthropicOauthToken,
  hasOpenAICodexOauthToken,
  parseProviderName,
  PiAiRuntime,
  resolveProviderApiKey,
  Tool,
  stringToUserMessage,
  type ThinkingLevel,
  type ToolProgressEvent,
} from "../agent-core/index.js";
import type { ProviderName } from "../agent-core/types.js";
import { buildPandaTools } from "../panda/agent.js";
import { summarizeMessageText } from "../panda/message-preview.js";
import {
  createChatRuntime,
  type ChatRuntimeServices,
} from "./runtime.js";
import {
  renderTranscriptEntries,
  type TranscriptEntryView,
} from "./transcript.js";
import {
  applySlashCompletion,
  findSlashCommand,
  getSlashCompletionContext,
  type SlashCompletionContext,
} from "./commands.js";
import {
  backspace,
  createComposerState,
  deleteForward,
  insertText,
  moveCursorDown,
  moveCursorLeft,
  moveCursorLineEnd,
  moveCursorLineStart,
  moveCursorRight,
  moveCursorUp,
  setComposerValue,
  type ComposerState,
} from "./composer.js";
import { renderMarkdownLines } from "./markdown.js";
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  CLEAR_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  clamp,
  cursorTo,
  formatDuration,
  padAnsiEnd,
  truncatePlainText,
  wrapPlainText,
} from "./screen.js";
import { stripAnsi, theme } from "./theme.js";
import {
  DEFAULT_COMPACT_PRESERVED_USER_TURNS,
  createCompactBoundaryMessage,
  estimateTranscriptTokens,
  formatTranscriptForCompaction,
  getCompactPrompt,
  parseCompactSummary,
  projectTranscriptForRun,
  splitTranscriptForCompaction,
} from "../thread-runtime/index.js";
import type {
  CompactBoundaryMetadata,
  ThreadMessageRecord,
  ThreadRecord,
  ThreadRunRecord,
  ThreadRuntimeEvent,
  ThreadSummaryRecord,
} from "../thread-runtime/index.js";

type EntryRole = "assistant" | "user" | "tool" | "meta" | "error";
type RunPhase = "idle" | "thinking";
type NoticeTone = "info" | "error";

interface TranscriptEntry {
  id: number;
  role: EntryRole;
  title: string;
  body: string;
}

interface TranscriptLine {
  plain: string;
  rendered: string;
}

interface TranscriptLineCacheEntry {
  role: EntryRole;
  title: string;
  body: string;
  bodyWidth: number;
  lines: readonly TranscriptLine[];
}

interface NoticeState {
  text: string;
  tone: NoticeTone;
  expiresAt: number;
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

interface KeyLike {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

interface ComposerLayout {
  lines: string[];
  cursorRow: number;
  cursorColumn: number;
}

interface InfoLine {
  text: string;
  cursorColumn: number | null;
}

interface ViewModel {
  width: number;
  rows: number;
  transcriptLines: TranscriptLine[];
  transcriptMatches: number[];
  selectedTranscriptLine: number | null;
  transcriptHeight: number;
  resolvedScrollTop: number;
  maxScrollTop: number;
  pendingLocalInputLines: string[];
  composerVisibleLines: string[];
  composerVisibleCursorRow: number;
  composerCursorColumn: number;
  headerLine: string;
  statusLine: string;
  infoLine: InfoLine;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LABEL_WIDTH = 16;
const TRANSCRIPT_GUTTER_WIDTH = 2;
const TICK_MS = 100;
const STORED_SYNC_MS = 750;
const MAX_VISIBLE_PENDING_LOCAL_INPUTS = 3;
const NOTICE_MS = 3_600;
const WELCOME_TWO_COLUMN_MIN_WIDTH = 72;
const WELCOME_MAX_WIDTH = 108;
const BRACKETED_PASTE_ON = "\u001b[?2004h";
const BRACKETED_PASTE_OFF = "\u001b[?2004l";
const PANDA_SPLASH = [
  "                       _       ",
  "                      | |      ",
  " _ __   __ _ _ __   __| | __ _ ",
  "| '_ \\ / _` | '_ \\ / _` |/ _` |",
  "| |_) | (_| | | | | (_| | (_| |",
  "| .__/ \\__,_|_| |_|\\__,_|\\__,_|",
  "| |                            ",
  "|_|                            ",
] as const;
const WELCOME_TIPS = [
  "Type your request and press Enter to start a run with Panda.",
  "Start with a code change, a debugging question, or a quick explanation of this repo.",
] as const;
const WELCOME_COMMANDS = [
  ["/help", "show commands and keybindings"],
  ["/provider <name>", "switch provider"],
  ["/model <name>", "switch model"],
  ["/thinking <level|off>", "set the thinking level"],
  ["/compact [instructions]", "summarize older context and keep recent turns"],
  ["/threads", "browse saved threads"],
  ["/resume <id>", "reopen a saved thread"],
] as const;
const WELCOME_KEYS = [
  ["Enter", "send your prompt"],
  ["Ctrl-J", "insert a newline"],
  ["Ctrl-C", "stop the active run and exit"],
  ["Tab", "complete slash commands"],
  ["Ctrl-R", "search input history"],
  ["Ctrl-F", "search the transcript"],
] as const;

export interface ChatCliOptions {
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingLevel;
  identity?: string;
  cwd?: string;
  instructions?: string;
  resume?: string;
  threadId?: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
}

export interface ChatCliResult {
  threadId?: string;
}

function defaultProvider(): ProviderName {
  const configured = process.env.PANDA_PROVIDER;

  if (configured) {
    return assertProviderName(configured);
  }

  if (hasAnthropicOauthToken() && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return "anthropic-oauth";
  }

  if (hasOpenAICodexOauthToken() && !process.env.OPENAI_API_KEY) {
    return "openai-codex";
  }

  if (process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return "anthropic";
  }

  return "openai";
}

function defaultModel(provider: ProviderName): string {
  if (process.env.PANDA_MODEL) {
    return process.env.PANDA_MODEL;
  }

  const config = getProviderConfig(provider);
  return process.env[config.defaultModelEnvVar] ?? config.defaultModel;
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

function isPrintable(sequence: string, key: KeyLike): boolean {
  if (!sequence || key.ctrl || key.meta) {
    return false;
  }

  return sequence >= " " || sequence === "\n";
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function homeRelativePath(value: string): string {
  const home = process.env.HOME;
  if (!home) {
    return value;
  }

  if (value === home) {
    return "~";
  }

  if (value.startsWith(home + path.sep)) {
    return `~${value.slice(home.length)}`;
  }

  return value;
}

function wrapWordText(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }

  const paragraphs = text.length === 0 ? [""] : text.split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";

    const pushChunkedWord = (word: string): void => {
      let remaining = word;
      while (remaining.length > width) {
        lines.push(remaining.slice(0, width));
        remaining = remaining.slice(width);
      }
      current = remaining;
    };

    for (const word of trimmed.split(/\s+/)) {
      if (word.length > width) {
        if (current) {
          lines.push(current);
          current = "";
        }
        pushChunkedWord(word);
        continue;
      }

      if (!current) {
        current = word;
        continue;
      }

      if (current.length + 1 + word.length <= width) {
        current += ` ${word}`;
        continue;
      }

      lines.push(current);
      current = word;
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines;
}

function centerAnsiText(value: string, width: number): string {
  const visibleLength = stripAnsi(value).length;
  if (visibleLength >= width) {
    return value;
  }

  const leftPadding = Math.floor((width - visibleLength) / 2);
  const rightPadding = width - visibleLength - leftPadding;
  return `${" ".repeat(leftPadding)}${value}${" ".repeat(rightPadding)}`;
}

function formatWelcomeItem(
  labelText: string,
  description: string,
  width: number,
  colorize: (value: string) => string = theme.gold,
): string[] {
  const label = colorize(labelText);
  const labelWidth = labelText.length;
  const descriptionWidth = Math.max(1, width - labelWidth - 1);
  const descriptionLines = wrapWordText(description, descriptionWidth);

  return descriptionLines.map((line, index) => {
    if (index === 0) {
      return `${label} ${theme.slate(line)}`;
    }

    return `${" ".repeat(labelWidth)} ${theme.slate(line)}`;
  });
}

function renderTranscriptLine(rendered: string): TranscriptLine {
  return {
    plain: stripAnsi(rendered),
    rendered,
  };
}

export class PandaChatApp {
  private providerName: ProviderName;
  private model: string;
  private thinking?: ThinkingLevel;
  private readonly cwd: string;
  private readonly instructions?: string;
  private readonly identity?: string;
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
  private currentStorageMode: "memory" | "postgres" = "memory";
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
  private slashSelection = 0;
  private slashToken = "";
  private ticker: NodeJS.Timeout | null = null;
  private syncTicker: NodeJS.Timeout | null = null;
  private resolveRun: (() => void) | null = null;
  private closed = false;
  private syncInFlight = false;
  private syncRequestedWhileBusy = false;
  private lastStoredSyncAt = 0;
  private lastObservedRunKey: string | null = null;
  private threadPickerRefreshInFlight = false;
  private threadPickerRefreshRequested = false;
  private closeAfterRun = false;
  private closeAfterRunWaitInFlight = false;
  private dirty = false;
  private renderQueued = false;
  private lastSpinnerFrame = -1;
  private syncDebounceTimer: NodeJS.Timeout | null = null;
  private inBracketedPaste = false;

  private readonly keypressHandler = (sequence: string, key: KeyLike): void => {
    void this.handleKeypress(sequence, key);
  };

  private readonly resizeHandler = (): void => {
    this.render();
  };

  constructor(options: ChatCliOptions = {}) {
    this.providerName = options.provider === undefined
      ? defaultProvider()
      : assertProviderName(options.provider);
    this.model = options.model ?? defaultModel(this.providerName);
    this.thinking = options.thinking;
    this.identity = options.identity;
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.instructions = options.instructions;
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

    if (this.transcript.length === 0) {
      this.pushEntry(
        "meta",
        "welcome",
        WELCOME_TIPS.join("\n"),
      );
    } else {
      this.pushEntry(
        "meta",
        "session",
        `Resumed thread ${this.currentThreadId}. Loaded ${this.transcript.length} transcript entries.`,
      );
    }
    this.setNotice("Ctrl-F find · Ctrl-R history · Ctrl-J newline · Ctrl-C exit", "info", 5_000);
    this.render();

    try {
      await new Promise<void>((resolve) => {
        this.resolveRun = resolve;
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
    this.resolveRun?.();
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

    if (this.currentStorageMode === "memory") {
      this.syncTicker = setInterval(() => {
        if (this.closed) {
          return;
        }

        void this.syncStoredThreadState();
      }, STORED_SYNC_MS);
    }
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

    return Math.floor(Date.now() / TICK_MS) % SPINNER_FRAMES.length;
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
      instructions: this.instructions,
      provider: this.providerName,
      model: this.model,
      identity: this.identity,
      dbUrl: this.dbUrl,
      readOnlyDbUrl: this.readOnlyDbUrl,
      onEvent: (event) => this.handleRuntimeEvent(event),
      onStoreNotification: (notification) => this.handleStoreNotification(notification.threadId),
    });
    this.currentStorageMode = this.services.mode;
    await this.services.recoverOrphanedRuns("Run marked failed before recovery.");

    let thread: ThreadRecord;
    if (this.resumeThreadId) {
      thread = await this.services.getThread(this.resumeThreadId);
    } else if (this.explicitThreadId) {
      try {
        thread = await this.services.getThread(this.explicitThreadId);
      } catch {
        thread = await this.services.createThread({
          id: this.explicitThreadId,
          provider: this.providerName,
          model: this.model,
          thinking: this.thinking,
        });
      }
    } else {
      thread = await this.services.createThread({
        provider: this.providerName,
        model: this.model,
        thinking: this.thinking,
      });
    }

    await this.switchThread(thread);
  }

  private async switchThread(thread: ThreadRecord): Promise<void> {
    this.currentThread = thread;
    this.currentThreadId = thread.id;
    this.providerName = thread.provider ?? this.providerName;
    this.model = thread.model ?? this.model;
    this.thinking = thread.thinking;
    this.currentStorageMode = this.requireServices().mode;
    this.runPhase = "idle";
    this.lastObservedRunKey = null;
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

  private async requestCompactSummary(options: {
    providerName: ProviderName;
    model: string;
    thinking?: ThinkingLevel;
    compactionInput: string;
    customInstructions: string;
    maxSummaryTokens?: number;
  }): Promise<string> {
    const runtime = new PiAiRuntime();
    const response = await runtime.complete({
      providerName: options.providerName,
      model: options.model,
      thinking: options.thinking,
      context: {
        systemPrompt: getCompactPrompt(options.customInstructions, options.maxSummaryTokens),
        messages: [stringToUserMessage(options.compactionInput)],
      },
    });

    const rawSummary = response.content.flatMap((part) => {
      return part.type === "text" && part.text.trim() ? [part.text.trim()] : [];
    }).join("\n\n");
    const summary = parseCompactSummary(rawSummary);
    if (!summary) {
      throw new Error("Compaction returned an empty summary.");
    }

    return summary;
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

      const transcript = await store.loadTranscript(threadId);
      const activeTranscript = projectTranscriptForRun(transcript);
      const split = splitTranscriptForCompaction(activeTranscript);

      if (!split) {
        return null;
      }

      const compactionInput = formatTranscriptForCompaction(split.summaryRecords).trim();
      if (!compactionInput) {
        return null;
      }

      const preservedTailTokens = estimateTranscriptTokens(split.preservedTail);
      const summaryTokenBudget = thread.maxInputTokens === undefined
        ? undefined
        : thread.maxInputTokens - preservedTailTokens;
      if (summaryTokenBudget !== undefined && summaryTokenBudget <= 0) {
        throw new Error("Recent context already fills the input budget, so compact cannot preserve the recent turns verbatim.");
      }

      this.currentThread = thread;
      this.providerName = providerName;
      this.model = model;
      this.thinking = thinking;
      this.setNotice("Compacting conversation...", "info");
      this.requestRender();

      const summary = await this.requestCompactSummary({
        providerName,
        model,
        thinking,
        compactionInput,
        customInstructions,
        maxSummaryTokens: summaryTokenBudget,
      });

      const compactMessage = createCompactBoundaryMessage(summary);
      const summaryTokens = estimateTokensFromString(JSON.stringify(compactMessage));
      if (summaryTokenBudget !== undefined && summaryTokens > summaryTokenBudget) {
        throw new Error("Compaction summary was too large to fit alongside the preserved recent turns. Try stricter instructions or raise maxInputTokens.");
      }

      const tokensBefore = estimateTranscriptTokens(activeTranscript);
      const tokensAfter = summaryTokens + preservedTailTokens;
      const metadata: CompactBoundaryMetadata = {
        kind: "compact_boundary",
        compactedUpToSequence: split.compactedUpToSequence,
        preservedTailUserTurns: DEFAULT_COMPACT_PRESERVED_USER_TURNS,
        trigger: "manual",
        tokensBefore,
        tokensAfter,
      };

      await store.appendRuntimeMessage(threadId, {
        message: compactMessage,
        source: "compact",
        metadata,
      });

      return {
        tokensBefore,
        tokensAfter,
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

    if (runKey === this.lastObservedRunKey) {
      return;
    }

    this.lastObservedRunKey = runKey;
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
      const visibleCount = 6;
      const maxStart = Math.max(0, this.threadPicker.summaries.length - visibleCount);
      const start = clamp(
        this.threadPicker.selected - Math.floor(visibleCount / 2),
        0,
        maxStart,
      );
      const visible = this.threadPicker.summaries.slice(start, start + visibleCount);

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

  private setNotice(text: string, tone: NoticeTone, durationMs = NOTICE_MS): void {
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
        lines.push(...this.buildWelcomeLines(width));
        continue;
      }

      lines.push(...this.buildCachedTranscriptLines(entry, bodyWidth));
    }

    return lines;
  }

  private buildWelcomeLines(width: number): TranscriptLine[] {
    const availableWidth = Math.max(20, width - TRANSCRIPT_GUTTER_WIDTH);
    const panelWidth = Math.min(availableWidth, WELCOME_MAX_WIDTH);
    return panelWidth >= WELCOME_TWO_COLUMN_MIN_WIDTH
      ? this.buildTwoColumnWelcomeLines(panelWidth)
      : this.buildStackedWelcomeLines(panelWidth);
  }

  private buildWelcomeIdentityLines(width: number): string[] {
    const lines = [
      centerAnsiText(theme.bold(theme.white("Welcome to Panda")), width),
      "",
      ...PANDA_SPLASH.map((line) => centerAnsiText(theme.mint(line), width)),
      "",
      theme.bold(theme.slate("Session")),
      ...this.buildWelcomeDetailLines("Provider", this.providerName, width),
      ...this.buildWelcomeDetailLines("Model", this.model, width),
      ...this.buildWelcomeDetailLines("Thinking", formatThinkingLevel(this.thinking), width),
      ...this.buildWelcomeDetailLines("Storage", this.currentStorageMode, width),
      ...this.buildWelcomeDetailLines("Path", homeRelativePath(this.cwd), width),
    ];

    return lines;
  }

  private buildWelcomeDetailLines(label: string, value: string, width: number): string[] {
    const prefixText = `${label.padEnd(8)}:`;
    const prefixWidth = prefixText.length;
    const wrappedValues = wrapWordText(value, Math.max(1, width - prefixWidth - 1));

    return wrappedValues.map((line, index) => {
      if (index === 0) {
        return `${theme.dim(prefixText)} ${theme.white(line)}`;
      }

      return `${" ".repeat(prefixWidth)} ${theme.slate(line)}`;
    });
  }

  private buildWelcomeGuideLines(width: number): string[] {
    return [
      theme.bold(theme.coral("Tips for getting started")),
      ...wrapWordText(WELCOME_TIPS[0], width).map((line) => theme.white(line)),
      ...wrapWordText(WELCOME_TIPS[1], width).map((line) => theme.slate(line)),
      "",
      theme.slate("─".repeat(width)),
      theme.bold(theme.coral("Quick commands")),
      ...WELCOME_COMMANDS.flatMap(([command, description]) => formatWelcomeItem(command, description, width)),
      "",
      theme.slate("─".repeat(width)),
      theme.bold(theme.coral("Keys")),
      ...WELCOME_KEYS.flatMap(([label, description]) => formatWelcomeItem(label, description, width, theme.cyan)),
    ];
  }

  private buildTwoColumnWelcomeLines(panelWidth: number): TranscriptLine[] {
    const innerContentWidth = Math.max(20, panelWidth - 8);
    const leftWidth = Math.max(28, Math.min(innerContentWidth - 20, Math.min(34, Math.floor(innerContentWidth * 0.36))));
    const rightWidth = Math.max(20, innerContentWidth - leftWidth);
    const leftLines = this.buildWelcomeIdentityLines(leftWidth);
    const rightLines = this.buildWelcomeGuideLines(rightWidth);
    const rowCount = Math.max(leftLines.length, rightLines.length);
    const lines = [renderTranscriptLine(theme.coral(`┌${"─".repeat(panelWidth - 2)}┐`))];

    for (let index = 0; index < rowCount; index += 1) {
      const rendered =
        `${theme.coral("│")} ` +
        `${padAnsiEnd(leftLines[index] ?? "", leftWidth)} ` +
        `${theme.slate("│")} ` +
        `${padAnsiEnd(rightLines[index] ?? "", rightWidth)} ` +
        `${theme.coral("│")}`;
      lines.push(renderTranscriptLine(rendered));
    }

    lines.push(renderTranscriptLine(theme.coral(`└${"─".repeat(panelWidth - 2)}┘`)));
    return lines;
  }

  private buildStackedWelcomeLines(panelWidth: number): TranscriptLine[] {
    const contentWidth = Math.max(20, panelWidth - 4);
    const contentLines = [
      ...this.buildWelcomeIdentityLines(contentWidth),
      "",
      theme.slate("─".repeat(contentWidth)),
      ...this.buildWelcomeGuideLines(contentWidth),
    ];
    const lines = [renderTranscriptLine(theme.coral(`┌${"─".repeat(panelWidth - 2)}┐`))];

    for (const line of contentLines) {
      lines.push(renderTranscriptLine(`${theme.coral("│")} ${padAnsiEnd(line, contentWidth)} ${theme.coral("│")}`));
    }

    lines.push(renderTranscriptLine(theme.coral(`└${"─".repeat(panelWidth - 2)}┘`)));
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

  private buildPromptInfoLine(
    width: number,
    prompt: string,
    summary: string,
    preview: string | null = null,
  ): InfoLine {
    const visiblePrompt = truncatePlainText(prompt, width);
    const remainingWidth = Math.max(0, width - visiblePrompt.length);
    const suffix = remainingWidth > 0
      ? truncatePlainText(
          ` · ${summary}${preview ? ` · ${preview}` : ""}`,
          remainingWidth,
        )
      : "";

    return {
      text: theme.gold(visiblePrompt) + theme.dim(suffix),
      cursorColumn: Math.min(visiblePrompt.length + 1, width),
    };
  }

  private buildInfoLine(
    width: number,
    transcriptLines: readonly TranscriptLine[],
    transcriptMatches: readonly number[],
    selectedTranscriptLine: number | null,
    scrollLabel: string,
  ): InfoLine {
    if (this.threadPicker.active) {
      return {
        text: theme.gold(truncatePlainText("threads · up/down select · enter resume · esc cancel", width)),
        cursorColumn: null,
      };
    }

    if (this.transcriptSearch.active) {
      const summary = transcriptMatches.length === 0
        ? "no matches"
        : `${clamp(this.transcriptSearch.selected, 0, transcriptMatches.length - 1) + 1}/${transcriptMatches.length}`;
      const preview = selectedTranscriptLine === null
        ? null
        : normalizeInlineText(transcriptLines[selectedTranscriptLine]?.plain ?? "");

      return this.buildPromptInfoLine(width, `find> ${this.transcriptSearch.query}`, summary, preview);
    }

    if (this.historySearch.active) {
      const matches = this.historyMatches();
      const summary = matches.length === 0
        ? "no matches"
        : `${clamp(this.historySearch.selected, 0, matches.length - 1) + 1}/${matches.length}`;
      const preview = normalizeInlineText(this.currentHistoryMatch() ?? "");

      return this.buildPromptInfoLine(width, `history> ${this.historySearch.query}`, summary, preview);
    }

    if (this.notice) {
      const text = truncatePlainText(this.notice.text, width);
      return {
        text: this.notice.tone === "error" ? theme.coral(text) : theme.gold(text),
        cursorColumn: null,
      };
    }

    const slashContext = this.currentSlashContext();
    if (slashContext && slashContext.matches.length > 0) {
      const selected = slashContext.matches[clamp(
        this.slashSelection,
        0,
        slashContext.matches.length - 1,
      )];
      const summary = `tab cycles · enter completes ${selected?.name ?? ""}${selected?.expectsValue ? " <value>" : ""} · ${selected?.summary ?? ""}`;
      return {
        text: theme.gold(truncatePlainText(summary, width)),
        cursorColumn: null,
      };
    }

    if (this.transcriptSearch.query.trim()) {
      const summary = transcriptMatches.length === 0
        ? "search no matches"
        : `search ${clamp(this.transcriptSearch.selected, 0, transcriptMatches.length - 1) + 1}/${transcriptMatches.length}`;
      return {
        text: theme.gold(truncatePlainText(`${summary} · ${scrollLabel}`, width)),
        cursorColumn: null,
      };
    }

    return {
      text: theme.dim(
        truncatePlainText(
          `${scrollLabel} · Enter send · Ctrl-J newline · Tab complete · Ctrl-R history · Ctrl-F find · PgUp/PgDn scroll`,
          width,
        ),
      ),
      cursorColumn: null,
    };
  }

  private buildView(): ViewModel {
    this.clearExpiredNotice();
    const width = Math.max(72, Math.min(output.columns || 100, 140));
    const rows = Math.max(18, output.rows || 32);
    const transcriptLines = this.buildTranscriptLines(width);
    const transcriptMatches = this.transcriptSearch.query.trim().length === 0
      ? []
      : transcriptLines.flatMap((line, index) => {
          return line.plain.toLowerCase().includes(this.transcriptSearch.query.toLowerCase())
            ? [index]
            : [];
        });
    const selectedTranscriptLine = transcriptMatches.length === 0
      ? null
      : transcriptMatches[clamp(this.transcriptSearch.selected, 0, transcriptMatches.length - 1)] ?? null;
    const composerLayout = this.buildComposerLayout(width);
    const pendingLocalInputLines = this.buildPendingLocalInputLines(width);
    let maxComposerVisible = clamp(Math.floor(rows * 0.35), 3, 8);
    let composerVisibleStart = Math.max(0, composerLayout.cursorRow - maxComposerVisible + 1);
    let composerVisibleLines = composerLayout.lines.slice(
      composerVisibleStart,
      composerVisibleStart + maxComposerVisible,
    );

    let transcriptHeight = rows - (1 + 1 + 2 + pendingLocalInputLines.length + Math.max(1, composerVisibleLines.length));
    if (transcriptHeight < 4) {
      maxComposerVisible = Math.max(1, maxComposerVisible - (4 - transcriptHeight));
      composerVisibleStart = Math.max(0, composerLayout.cursorRow - maxComposerVisible + 1);
      composerVisibleLines = composerLayout.lines.slice(
        composerVisibleStart,
        composerVisibleStart + maxComposerVisible,
      );
      transcriptHeight = Math.max(
        1,
        rows - (1 + 1 + 2 + pendingLocalInputLines.length + Math.max(1, composerVisibleLines.length)),
      );
    }

    const maxScrollTop = Math.max(0, transcriptLines.length - transcriptHeight);
    const resolvedScrollTop = clamp(
      this.followTranscript ? maxScrollTop : this.scrollTop,
      0,
      maxScrollTop,
    );
    const spinner = this.isRunning
      ? `${SPINNER_FRAMES[Math.floor(Date.now() / TICK_MS) % SPINNER_FRAMES.length]} `
      : "";
    const runLabel = this.isRunning ? "thinking" : "ready";
    const elapsedLabel = this.isRunning ? formatDuration(Date.now() - this.runStartedAt) : null;
    const statusText = [
      truncatePlainText(`thread ${this.currentThreadId || "new"}`, 28),
      this.providerName,
      this.model,
      `think ${formatThinkingLevel(this.thinking)}`,
      this.currentStorageMode,
      this.modeLabel,
      runLabel,
      elapsedLabel,
    ]
      .filter(Boolean)
      .join(" · ");
    const totalTranscriptLines = transcriptLines.length;
    const scrollStart = totalTranscriptLines === 0 ? 0 : resolvedScrollTop + 1;
    const scrollEnd = Math.min(totalTranscriptLines, resolvedScrollTop + transcriptHeight);
    const scrollLabel = totalTranscriptLines === 0
      ? "lines 0/0"
      : `lines ${scrollStart}-${scrollEnd}/${totalTranscriptLines}${this.followTranscript ? " follow" : ""}`;

    return {
      width,
      rows,
      transcriptLines,
      transcriptMatches,
      selectedTranscriptLine,
      transcriptHeight,
      resolvedScrollTop,
      maxScrollTop,
      pendingLocalInputLines,
      composerVisibleLines,
      composerVisibleCursorRow: composerLayout.cursorRow - composerVisibleStart,
      composerCursorColumn: composerLayout.cursorColumn,
      headerLine:
        theme.bold(theme.coral("Panda")) +
        theme.dim(` · ${truncatePlainText(`cwd ${this.cwd} · ${this.currentThreadId || "no-thread"}`, Math.max(0, width - 8))}`),
      statusLine: this.isRunning
        ? theme.mint(truncatePlainText(`${spinner}${statusText}`, width))
        : theme.dim(truncatePlainText(statusText, width)),
      infoLine: this.buildInfoLine(width, transcriptLines, transcriptMatches, selectedTranscriptLine, scrollLabel),
    };
  }

  private currentSlashContext(): SlashCompletionContext | null {
    const context = getSlashCompletionContext(this.composer.value, this.composer.cursor);
    const token = context?.token ?? "";

    if (token !== this.slashToken) {
      this.slashToken = token;
      this.slashSelection = 0;
    }

    if (!context || context.matches.length === 0) {
      this.slashSelection = 0;
      return context;
    }

    this.slashSelection = clamp(this.slashSelection, 0, context.matches.length - 1);
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

    const command = context.matches[this.slashSelection];
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
    this.setComposerState(setComposerValue(this.composer, next.value, next.cursor));
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
    const [command, ...rest] = commandLine.split(/\s+/);
    const value = rest.join(" ").trim();

    switch (command) {
      case "/help":
        this.pushEntry(
          "meta",
          "help",
          [
            "Commands:",
            "/help shows command help.",
            "/provider <openai|openai-codex|anthropic|anthropic-oauth> switches providers for this stored thread.",
            "/model <name> changes the active model.",
            `${thinkingCommandUsage()} changes the active thinking level.`,
            "/compact [instructions] summarizes older context and keeps recent turns verbatim.",
            "/new starts a fresh stored thread.",
            "/resume <thread-id> switches to another stored thread.",
            "/thread shows the current thread id and storage mode.",
            "/threads opens the recent-thread picker.",
            "/abort aborts the active run.",
            "/exit leaves the TUI.",
            "",
            "Keys:",
            "Enter sends the current prompt.",
            "Ctrl-J inserts a newline.",
            "Ctrl-C stops the active run and exits Panda.",
            "Tab cycles slash command suggestions and Enter completes them.",
            "Ctrl-R opens reverse history search.",
            "Ctrl-F opens transcript search.",
            "PgUp/PgDn or Alt-Up/Alt-Down scroll transcript history.",
            "Esc clears active search or returns to the transcript bottom.",
          ].join("\n"),
        );
        return true;

      case "/provider": {
        if (this.isRunning) {
          this.setNotice("Abort or wait for the current run before switching providers.", "info");
          return true;
        }

        const nextProvider = parseProviderName(value);
        if (!nextProvider) {
          const message = `Provider must be one of ${formatProviderNameList()}.`;
          this.pushEntry("error", "config", message);
          this.setNotice(message, "error");
          return true;
        }

        try {
          const previousProvider = this.providerName;
          this.providerName = nextProvider;
          this.model = defaultModel(nextProvider);
          this.currentThread = await this.requireServices().store.updateThread(this.currentThreadId, {
            provider: nextProvider,
            model: this.model,
          });
          this.pushEntry(
            "meta",
            "config",
            `Provider switched from ${previousProvider} to ${nextProvider}. Model reset to ${this.model}.`,
          );
          this.setNotice(`Provider ${nextProvider} · model ${this.model}`, "info");
        } catch (error) {
          this.providerName = this.currentThread?.provider ?? this.providerName;
          this.model = this.currentThread?.model ?? this.model;
          const message = error instanceof Error ? error.message : String(error);
          this.pushEntry("error", "config", message);
          this.setNotice(message, "error");
        }
        return true;
      }

      case "/model":
        if (this.isRunning) {
          this.setNotice("Abort or wait for the current run before switching models.", "info");
          return true;
        }

        if (!value) {
          this.pushEntry("error", "config", "Usage: /model <name>");
          this.setNotice("Usage: /model <name>", "error");
          return true;
        }

        try {
          this.model = value;
          this.currentThread = await this.requireServices().store.updateThread(this.currentThreadId, {
            model: value,
          });
          this.pushEntry("meta", "config", `Model set to ${value}.`);
          this.setNotice(`Model ${value}`, "info");
        } catch (error) {
          this.model = this.currentThread?.model ?? this.model;
          const message = error instanceof Error ? error.message : String(error);
          this.pushEntry("error", "config", message);
          this.setNotice(message, "error");
        }
        return true;

      case "/thinking": {
        if (this.isRunning) {
          this.setNotice("Abort or wait for the current run before changing thinking.", "info");
          return true;
        }

        if (!value) {
          const usage = `Usage: ${thinkingCommandUsage()}`;
          this.pushEntry("error", "config", usage);
          this.setNotice(usage, "error");
          return true;
        }

        const nextThinking = parseThinkingCommandValue(value);
        if (!nextThinking) {
          const message = `Thinking must be one of ${thinkingCommandValuesText()}.`;
          this.pushEntry("error", "config", message);
          this.setNotice(message, "error");
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
          const message = error instanceof Error ? error.message : String(error);
          this.pushEntry("error", "config", message);
          this.setNotice(message, "error");
        }
        return true;
      }

      case "/compact":
        if (this.isRunning) {
          this.setNotice("Abort or wait for the current run before compacting.", "info");
          return true;
        }

        try {
          await this.compactCurrentThread(value);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.pushEntry("error", "compact", message);
          this.setNotice(message, "error");
        }
        return true;

      case "/new":
        if (this.isRunning) {
          this.setNotice("Abort or wait for the current run before creating a new thread.", "info");
          return true;
        }

        await this.switchThread(await this.requireServices().createThread({
          provider: this.providerName,
          model: this.model,
          thinking: this.thinking,
        }));
        this.pushEntry("meta", "session", `Started a fresh thread ${this.currentThreadId}.`);
        this.setNotice(`Started thread ${this.currentThreadId}.`, "info");
        return true;

      case "/resume":
        if (this.isRunning) {
          this.setNotice("Abort or wait for the current run before resuming another thread.", "info");
          return true;
        }

        if (!value) {
          this.pushEntry("error", "session", "Usage: /resume <thread-id>");
          this.setNotice("Usage: /resume <thread-id>", "error");
          return true;
        }

        try {
          await this.switchThread(await this.requireServices().getThread(value));
          this.pushEntry("meta", "session", `Resumed thread ${this.currentThreadId}.`);
          this.setNotice(`Resumed thread ${this.currentThreadId}.`, "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.pushEntry("error", "session", message);
          this.setNotice(message, "error");
        }
        return true;

      case "/thread":
        this.pushEntry(
          "meta",
          "session",
          [
            `identity ${this.requireServices().identity.handle}`,
            `thread ${this.currentThreadId}`,
            `storage ${this.currentStorageMode}`,
            `provider ${this.providerName}`,
            `model ${this.model}`,
            `thinking ${formatThinkingLevel(this.thinking)}`,
          ].join("\n"),
        );
        return true;

      case "/threads": {
        await this.openThreadPicker();
        return true;
      }

      case "/abort":
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

      case "/exit":
      case "/quit":
        if (this.isRunning) {
          this.setNotice("Wait for the current turn to finish before exiting.", "info");
          return true;
        }

        return false;

      default: {
        const maybeCommand = findSlashCommand(command ?? "");
        const message = maybeCommand
          ? `${command} needs more input.`
          : `Unknown command: ${command}`;
        this.pushEntry("error", "command", message);
        this.setNotice(message, "error");
        return true;
      }
    }
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

  private async handleKeypress(sequence: string, key: KeyLike): Promise<void> {
    if (this.closed) {
      return;
    }

    if (key.name === "paste-start") {
      this.inBracketedPaste = true;
      this.render();
      return;
    }

    if (key.name === "paste-end") {
      this.inBracketedPaste = false;
      this.render();
      return;
    }

    if (key.ctrl && key.name === "c") {
      if (this.isRunning) {
        if (this.closeAfterRun) {
          this.setNotice("Stopping the active run and closing Panda...", "info");
          return;
        }

        if (await this.requireServices().coordinator.abort(this.currentThreadId, "Aborted from Ctrl-C.")) {
          this.closeAfterRun = true;
          this.setNotice("Stopping the active run and closing Panda...", "info");
        } else {
          this.close();
          return;
        }
      } else {
        this.close();
        return;
      }
    } else if (key.name === "pageup" || key.name === "pagedown") {
      const delta = Math.max(1, this.buildView().transcriptHeight - 2);
      this.scrollTranscript(key.name === "pageup" ? -delta : delta);
    } else if (key.meta && key.name === "up") {
      this.scrollTranscript(-1);
    } else if (key.meta && key.name === "down") {
      this.scrollTranscript(1);
    } else if (this.threadPicker.active) {
      await this.handleThreadPickerKeypress(sequence, key);
    } else if (!this.historySearch.active && !this.transcriptSearch.active && key.ctrl && key.name === "r") {
      this.startHistorySearch();
    } else if (!this.historySearch.active && !this.transcriptSearch.active && key.ctrl && key.name === "f") {
      this.startTranscriptSearch();
    } else if (this.transcriptSearch.active) {
      this.handleTranscriptSearchKeypress(sequence, key);
    } else if (this.historySearch.active) {
      this.handleHistorySearchKeypress(sequence, key);
    } else {
      await this.handleComposerKeypress(sequence, key);
    }

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

    if (isPrintable(sequence, key) && sequence !== "\n") {
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
        this.setComposerState(setComposerValue(this.composer, match));
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

    if (isPrintable(sequence, key) && sequence !== "\n") {
      this.historySearch.query += sequence;
      this.historySearch.selected = 0;
    }
  }

  private async handleComposerKeypress(sequence: string, key: KeyLike): Promise<void> {
    if (
      this.inBracketedPaste &&
      (key.name === "return" || key.name === "enter" || sequence === "\r" || sequence === "\n")
    ) {
      this.setComposerState(insertText(this.composer, "\n"));
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
        this.slashSelection = (this.slashSelection + direction + context.matches.length) %
          context.matches.length;
      }
      return;
    }

    if (key.name === "return" || sequence === "\r") {
      await this.submitComposer();
      return;
    }

    if (sequence === "\n") {
      this.setComposerState(insertText(this.composer, "\n"));
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

    if (isPrintable(sequence, key)) {
      this.setComposerState(insertText(this.composer, sequence));
    }
  }
}

export async function runChatCli(options: ChatCliOptions = {}): Promise<ChatCliResult> {
  const app = new PandaChatApp(options);
  return await app.run();
}
