import path from "node:path";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

import {
  assertProviderName,
  formatProviderNameList,
  getProviderConfig,
  hasAnthropicOauthToken,
  hasOpenAICodexOauthToken,
  parseProviderName,
  resolveProviderApiKey,
  Thread,
  Tool,
  formatToolCallFallback,
  formatToolResultFallback,
  stringToUserMessage,
  type Message,
} from "../agent-core/index.js";
import { createPandaAgent } from "../panda/agent.js";
import { createDefaultPandaContexts } from "../panda/contexts/index.js";
import type { PandaProviderName, PandaSessionContext } from "../panda/types.js";
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

type EntryRole = "assistant" | "user" | "tool" | "meta" | "error";
type RunPhase = "idle" | "thinking" | "tool";
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
const NOTICE_MS = 3_600;
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

export interface ChatCliOptions {
  provider?: PandaProviderName;
  model?: string;
  cwd?: string;
  instructions?: string;
}

function defaultProvider(): PandaProviderName {
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

function defaultModel(provider: PandaProviderName): string {
  if (process.env.PANDA_MODEL) {
    return process.env.PANDA_MODEL;
  }

  const config = getProviderConfig(provider);
  return process.env[config.defaultModelEnvVar] ?? config.defaultModel;
}

function missingApiKeyMessage(provider: PandaProviderName): string | null {
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

export class PandaChatApp {
  private providerName: PandaProviderName;
  private model: string;
  private readonly cwd: string;
  private readonly instructions?: string;
  private readonly locale: string;
  private readonly timezone: string;
  private readonly transcript: TranscriptEntry[] = [];
  private readonly inputHistory: string[] = [];
  private composer: ComposerState = createComposerState();
  private readonly historySearch: SearchState = { active: false, query: "", selected: 0 };
  private readonly transcriptSearch: SearchState = { active: false, query: "", selected: 0 };
  private thread: Thread<PandaSessionContext>;
  private runPhase: RunPhase = "idle";
  private runStartedAt = 0;
  private activeToolSummary: string | null = null;
  private pendingToolCalls = 0;
  private notice: NoticeState | null = null;
  private nextEntryId = 1;
  private followTranscript = true;
  private scrollTop = 0;
  private slashSelection = 0;
  private slashToken = "";
  private ticker: NodeJS.Timeout | null = null;
  private resolveRun: (() => void) | null = null;
  private closed = false;

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
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.instructions = options.instructions;
    this.locale = Intl.DateTimeFormat().resolvedOptions().locale;
    this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    this.thread = this.buildThread();
  }

  async run(): Promise<void> {
    if (!input.isTTY || !output.isTTY) {
      throw new Error("Panda chat requires an interactive terminal.");
    }

    readline.emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    input.on("keypress", this.keypressHandler);
    output.on("resize", this.resizeHandler);
    this.startTicker();
    this.enterScreen();

    this.pushEntry(
      "meta",
      "welcome",
      [
        "Chat with Panda in this terminal.",
        "Commands: /help, /provider <name>, /model <name>, /new, /clear, /exit.",
        "Keys: Enter send, Ctrl-J newline, Tab slash completion, Ctrl-R history search, Ctrl-F transcript search, PgUp/PgDn scroll transcript.",
      ].join("\n"),
    );
    this.setNotice("Ctrl-F find · Ctrl-R history · Ctrl-J newline", "info", 5_000);
    this.render();

    try {
      await new Promise<void>((resolve) => {
        this.resolveRun = resolve;
      });
    } finally {
      this.cleanup();
    }
  }

  private cleanup(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }

    input.off("keypress", this.keypressHandler);
    output.off("resize", this.resizeHandler);
    input.setRawMode?.(false);
    output.write(HIDE_CURSOR + CLEAR_SCREEN + SHOW_CURSOR + ALT_SCREEN_OFF);
  }

  private close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.resolveRun?.();
  }

  private startTicker(): void {
    this.ticker = setInterval(() => {
      if (this.closed) {
        return;
      }

      if (this.runPhase !== "idle" || this.notice) {
        this.render();
      }
    }, TICK_MS);
  }

  private findTool(name: string): Tool | undefined {
    return this.thread.agent.tools.find((tool) => tool.name === name);
  }

  private buildThread(history: readonly Message[] = this.thread?.messages ?? []): Thread<PandaSessionContext> {
    return new Thread({
      agent: createPandaAgent({
        promptAdditions: this.instructions,
        model: this.model,
      }),
      messages: [...history],
      provider: this.providerName,
      context: {
        cwd: this.cwd,
        locale: this.locale,
        timezone: this.timezone,
      },
      llmContexts: createDefaultPandaContexts({
        locale: this.locale,
        timeZone: this.timezone,
      }),
    });
  }

  private get modeLabel(): string {
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
  }

  private clearExpiredNotice(): void {
    if (this.notice && this.notice.expiresAt <= Date.now()) {
      this.notice = null;
    }
  }

  private pushEntry(role: EntryRole, title: string, body: string): void {
    this.transcript.push({
      id: this.nextEntryId,
      role,
      title,
      body,
    });
    this.nextEntryId += 1;
    this.afterTranscriptChange();
  }

  private afterTranscriptChange(): void {
    const view = this.buildView();
    this.scrollTop = view.resolvedScrollTop;

    if (view.transcriptMatches.length === 0) {
      this.transcriptSearch.selected = 0;
      return;
    }

    this.transcriptSearch.selected = clamp(
      this.transcriptSearch.selected,
      0,
      view.transcriptMatches.length - 1,
    );

    if (this.transcriptSearch.active) {
      this.ensureSelectedTranscriptMatchVisible(view);
    }
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

  private buildTranscriptLines(width: number): TranscriptLine[] {
    const bodyWidth = Math.max(20, width - TRANSCRIPT_GUTTER_WIDTH - LABEL_WIDTH);
    const lines: TranscriptLine[] = [];
    const visibleEntries = this.shouldShowSplash
      ? this.transcript
      : this.transcript.filter((entry) => entry.title !== "welcome");

    for (const entry of visibleEntries) {
      if (entry.title === "welcome" && this.shouldShowSplash) {
        for (const splashLine of PANDA_SPLASH) {
          lines.push({
            plain: splashLine,
            rendered: theme.mint(splashLine),
          });
        }

        lines.push({
          plain: "",
          rendered: "",
        });

        for (const line of [
          "Chat with Panda in this terminal.",
          "Commands: /help, /provider <name>, /model <name>, /new, /clear, /exit.",
          "Keys: Enter send, Ctrl-J newline, Tab slash completion, Ctrl-R history search, Ctrl-F transcript search, PgUp/PgDn scroll transcript.",
        ].flatMap((line) => wrapPlainText(line, Math.max(20, width - TRANSCRIPT_GUTTER_WIDTH)))) {
          lines.push({
            plain: line,
            rendered: theme.dim(line),
          });
        }

        continue;
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
      const wrappedBody = wrapPlainText(entry.body, bodyWidth);

      for (const [index, line] of wrappedBody.entries()) {
        lines.push({
          plain: `${entry.title} ${line}`.trim(),
          rendered: `${index === 0 ? label : " ".repeat(LABEL_WIDTH)}${line}`,
        });
      }
    }

    return lines;
  }

  private buildComposerLayout(width: number): ComposerLayout {
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

  private buildInfoLine(
    width: number,
    transcriptMatches: readonly number[],
    selectedTranscriptLine: number | null,
    scrollLabel: string,
  ): InfoLine {
    if (this.transcriptSearch.active) {
      const prompt = `find> ${this.transcriptSearch.query}`;
      const summary = transcriptMatches.length === 0
        ? "no matches"
        : `${clamp(this.transcriptSearch.selected, 0, transcriptMatches.length - 1) + 1}/${transcriptMatches.length}`;
      const preview = selectedTranscriptLine === null
        ? null
        : normalizeInlineText(
            this.buildTranscriptLines(width)[selectedTranscriptLine]?.plain ?? "",
          );
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

    if (this.historySearch.active) {
      const prompt = `history> ${this.historySearch.query}`;
      const matches = this.historyMatches();
      const summary = matches.length === 0
        ? "no matches"
        : `${clamp(this.historySearch.selected, 0, matches.length - 1) + 1}/${matches.length}`;
      const preview = normalizeInlineText(this.currentHistoryMatch() ?? "");
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

    this.clearExpiredNotice();
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
    let maxComposerVisible = clamp(Math.floor(rows * 0.35), 3, 8);
    let composerVisibleStart = Math.max(0, composerLayout.cursorRow - maxComposerVisible + 1);
    let composerVisibleLines = composerLayout.lines.slice(
      composerVisibleStart,
      composerVisibleStart + maxComposerVisible,
    );

    let transcriptHeight = rows - (1 + 1 + 2 + Math.max(1, composerVisibleLines.length));
    if (transcriptHeight < 4) {
      maxComposerVisible = Math.max(1, maxComposerVisible - (4 - transcriptHeight));
      composerVisibleStart = Math.max(0, composerLayout.cursorRow - maxComposerVisible + 1);
      composerVisibleLines = composerLayout.lines.slice(
        composerVisibleStart,
        composerVisibleStart + maxComposerVisible,
      );
      transcriptHeight = Math.max(1, rows - (1 + 1 + 2 + Math.max(1, composerVisibleLines.length)));
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
    const runLabel = this.isRunning
      ? this.runPhase === "tool"
        ? `tool ${truncatePlainText(this.activeToolSummary ?? "running", 28)}`
        : "thinking"
      : "ready";
    const elapsedLabel = this.isRunning ? formatDuration(Date.now() - this.runStartedAt) : null;
    const statusText = [
      this.providerName,
      this.model,
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
      composerVisibleLines,
      composerVisibleCursorRow: composerLayout.cursorRow - composerVisibleStart,
      composerCursorColumn: composerLayout.cursorColumn,
      headerLine:
        theme.bold(theme.coral("Panda")) +
        theme.dim(` · ${truncatePlainText(`cwd ${this.cwd}`, Math.max(0, width - 8))}`),
      statusLine: this.isRunning
        ? theme.mint(truncatePlainText(`${spinner}${statusText}`, width))
        : theme.dim(truncatePlainText(statusText, width)),
      infoLine: this.buildInfoLine(width, transcriptMatches, selectedTranscriptLine, scrollLabel),
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

  private ensureSelectedTranscriptMatchVisible(view = this.buildView()): void {
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
  }

  private jumpTranscriptToBottom(): void {
    const view = this.buildView();
    this.followTranscript = true;
    this.scrollTop = view.maxScrollTop;
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
    this.composer = setComposerValue(this.composer, next.value, next.cursor);
    this.currentSlashContext();
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
    if (this.isRunning) {
      this.setNotice("Wait for the current turn to finish before sending another prompt.", "info");
      return;
    }

    if (this.applySelectedSlashCompletion()) {
      return;
    }

    const message = this.composer.value.trimEnd();
    if (!message.trim()) {
      this.setNotice("Type a message or slash command first.", "info");
      return;
    }

    this.recordHistory(message);
    this.composer = createComposerState();
    this.currentSlashContext();

    if (message.startsWith("/")) {
      const shouldContinue = await this.handleCommand(message);
      if (!shouldContinue) {
        this.close();
      }
      return;
    }

    this.pushEntry("user", "you", message);
    this.thread.addMessage(stringToUserMessage(message));
    this.followTranscript = true;
    await this.runTurn();
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
            "/provider <openai|openai-codex|anthropic|anthropic-oauth> switches providers and keeps the current in-memory transcript.",
            "/model <name> changes the active model.",
            "/new starts a fresh chat.",
            "/clear clears the visible transcript panel only.",
            "/exit leaves the TUI.",
            "",
            "Keys:",
            "Enter sends the current prompt.",
            "Ctrl-J inserts a newline.",
            "Tab cycles slash command suggestions and Enter completes them.",
            "Ctrl-R opens reverse history search.",
            "Ctrl-F opens transcript search.",
            "PgUp/PgDn or Alt-Up/Alt-Down scroll transcript history.",
            "Esc clears active search or returns to the transcript bottom.",
          ].join("\n"),
        );
        return true;

      case "/provider": {
        const nextProvider = parseProviderName(value);
        if (!nextProvider) {
          const message = `Provider must be one of ${formatProviderNameList()}.`;
          this.pushEntry("error", "config", message);
          this.setNotice(message, "error");
          return true;
        }

        const previousProvider = this.providerName;
        const previousThread = this.thread;

        try {
          this.providerName = nextProvider;
          this.model = defaultModel(nextProvider);
          this.thread = this.buildThread(previousThread.messages);
          this.pushEntry(
            "meta",
            "config",
            `Provider switched from ${previousProvider} to ${nextProvider}. Model reset to ${this.model}.`,
          );
          this.setNotice(`Provider ${nextProvider} · model ${this.model}`, "info");
        } catch (error) {
          this.providerName = previousProvider;
          this.thread = previousThread;
          const message = error instanceof Error ? error.message : String(error);
          this.pushEntry("error", "config", message);
          this.setNotice(message, "error");
        }
        return true;
      }

      case "/model":
        if (!value) {
          this.pushEntry("error", "config", "Usage: /model <name>");
          this.setNotice("Usage: /model <name>", "error");
          return true;
        }

        this.model = value;
        this.thread = this.buildThread(this.thread.messages);
        this.pushEntry("meta", "config", `Model set to ${value}.`);
        this.setNotice(`Model ${value}`, "info");
        return true;

      case "/new":
        this.thread = this.buildThread([]);
        this.transcript.length = 0;
        this.followTranscript = true;
        this.scrollTop = 0;
        this.clearTranscriptSearch();
        this.pushEntry("meta", "welcome", "Started a fresh chat.");
        this.setNotice("Started a fresh chat.", "info");
        return true;

      case "/clear":
        this.transcript.length = 0;
        this.followTranscript = true;
        this.scrollTop = 0;
        this.clearTranscriptSearch();
        this.pushEntry("meta", "view", "Cleared the visible transcript.");
        this.setNotice("Cleared the visible transcript.", "info");
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

  private async runTurn(): Promise<void> {
    const keyMessage = missingApiKeyMessage(this.providerName);
    if (keyMessage) {
      this.pushEntry("error", "auth", keyMessage);
      this.setNotice(keyMessage, "error", 6_000);
      this.render();
      return;
    }

    this.runPhase = "thinking";
    this.runStartedAt = Date.now();
    this.activeToolSummary = null;
    this.pendingToolCalls = 0;
    this.render();

    try {
      for await (const event of this.thread.run()) {
        if ("type" in event && event.type === "tool_progress") {
          this.pushEntry("meta", "progress", JSON.stringify(event.details, null, 2));
        } else if ("role" in event && event.role === "assistant") {
          let text = "";

          const flushText = (): void => {
            if (!text) {
              return;
            }

            this.pushEntry("assistant", "panda", text);
            text = "";
          };

          for (const block of event.content) {
            if (block.type === "text" && block.text) {
              text += block.text;
              continue;
            }

            if (block.type === "toolCall") {
              const tool = this.findTool(block.name);
              const callSummary = tool?.formatCall(block.arguments ?? {}) ?? formatToolCallFallback(block.arguments ?? {});
              flushText();
              this.pendingToolCalls += 1;
              this.runPhase = "tool";
              this.activeToolSummary = normalizeInlineText(callSummary);
              this.pushEntry("tool", block.name, callSummary);
            }
          }

          flushText();
        } else if ("role" in event && event.role === "toolResult") {
          const tool = this.findTool(event.toolName);
          this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
          if (this.pendingToolCalls === 0) {
            this.runPhase = "thinking";
            this.activeToolSummary = null;
          }
          this.pushEntry("tool", event.toolName, tool?.formatResult(event) ?? formatToolResultFallback(event));
        } else {
          this.pushEntry("meta", "event", JSON.stringify(event, null, 2));
        }

        this.render();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushEntry("error", "error", message);
      this.setNotice(message, "error", 6_000);
    } finally {
      this.runPhase = "idle";
      this.activeToolSummary = null;
      this.pendingToolCalls = 0;
      this.render();
    }
  }

  private enterScreen(): void {
    output.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR_SCREEN);
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
      ...view.composerVisibleLines,
    ];
    const infoLineRow = screenLines.length - view.composerVisibleLines.length;
    const composerStartRow = infoLineRow + 1;
    let cursorRow = composerStartRow + view.composerVisibleCursorRow;
    let cursorColumn = view.composerCursorColumn;

    if (this.historySearch.active || this.transcriptSearch.active) {
      cursorRow = infoLineRow;
      cursorColumn = view.infoLine.cursorColumn ?? cursorColumn;
    }

    output.write(HIDE_CURSOR + CLEAR_SCREEN + screenLines.join("\n"));
    output.write(cursorTo(cursorRow, cursorColumn) + SHOW_CURSOR);
  }

  private async handleKeypress(sequence: string, key: KeyLike): Promise<void> {
    if (this.closed) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      if (this.isRunning) {
        this.setNotice("Wait for the current turn to finish before exiting.", "info");
      } else {
        this.close();
      }
      this.render();
      return;
    }

    const view = this.buildView();
    if (key.name === "pageup") {
      this.scrollTranscript(-(Math.max(1, view.transcriptHeight - 2)));
      this.render();
      return;
    }

    if (key.name === "pagedown") {
      this.scrollTranscript(Math.max(1, view.transcriptHeight - 2));
      this.render();
      return;
    }

    if (key.meta && key.name === "up") {
      this.scrollTranscript(-1);
      this.render();
      return;
    }

    if (key.meta && key.name === "down") {
      this.scrollTranscript(1);
      this.render();
      return;
    }

    if (!this.historySearch.active && !this.transcriptSearch.active && key.ctrl && key.name === "r") {
      this.startHistorySearch();
      this.render();
      return;
    }

    if (!this.historySearch.active && !this.transcriptSearch.active && key.ctrl && key.name === "f") {
      this.startTranscriptSearch();
      this.render();
      return;
    }

    if (this.transcriptSearch.active) {
      this.handleTranscriptSearchKeypress(sequence, key);
      this.render();
      return;
    }

    if (this.historySearch.active) {
      this.handleHistorySearchKeypress(sequence, key);
      this.render();
      return;
    }

    await this.handleComposerKeypress(sequence, key);
    this.render();
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
      this.ensureSelectedTranscriptMatchVisible();
      return;
    }

    if (isPrintable(sequence, key) && sequence !== "\n") {
      this.transcriptSearch.query += sequence;
      this.transcriptSearch.selected = 0;
      this.ensureSelectedTranscriptMatchVisible();
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
        this.composer = setComposerValue(this.composer, match);
        this.currentSlashContext();
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
      this.composer = insertText(this.composer, "\n");
      this.currentSlashContext();
      return;
    }

    if (key.name === "backspace") {
      this.composer = backspace(this.composer);
      this.currentSlashContext();
      return;
    }

    if (key.name === "delete") {
      this.composer = deleteForward(this.composer);
      this.currentSlashContext();
      return;
    }

    if (key.name === "left") {
      this.composer = moveCursorLeft(this.composer);
      this.currentSlashContext();
      return;
    }

    if (key.name === "right") {
      this.composer = moveCursorRight(this.composer);
      this.currentSlashContext();
      return;
    }

    if (key.name === "up") {
      this.composer = moveCursorUp(this.composer);
      this.currentSlashContext();
      return;
    }

    if (key.name === "down") {
      this.composer = moveCursorDown(this.composer);
      this.currentSlashContext();
      return;
    }

    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      this.composer = moveCursorLineStart(this.composer);
      this.currentSlashContext();
      return;
    }

    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      this.composer = moveCursorLineEnd(this.composer);
      this.currentSlashContext();
      return;
    }

    if (isPrintable(sequence, key)) {
      this.composer = insertText(this.composer, sequence);
      this.currentSlashContext();
    }
  }
}

export async function runChatCli(options: ChatCliOptions = {}): Promise<void> {
  const app = new PandaChatApp(options);
  await app.run();
}
