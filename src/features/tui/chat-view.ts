import path from "node:path";

import type { SlashCompletionContext } from "./commands.js";
import {
  clamp,
  formatDuration,
  padAnsiEnd,
  truncatePlainText,
} from "./screen.js";
import { stripAnsi, theme } from "./theme.js";

export interface TranscriptLine {
  plain: string;
  rendered: string;
}

export interface ComposerLayout {
  lines: string[];
  cursorRow: number;
  cursorColumn: number;
}

export interface NoticeState {
  text: string;
  tone: "info" | "error";
  expiresAt: number;
}

export interface InfoLine {
  text: string;
  cursorColumn: number | null;
}

export interface ViewModel {
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

export const THREAD_PICKER_VISIBLE_COUNT = 6;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WELCOME_TWO_COLUMN_MIN_WIDTH = 72;
const WELCOME_MAX_WIDTH = 108;
const MIN_VIEW_WIDTH = 72;
const MAX_VIEW_WIDTH = 140;
const DEFAULT_VIEW_WIDTH = 100;
const MIN_VIEW_ROWS = 18;
const DEFAULT_VIEW_ROWS = 32;
const COMPOSER_VISIBLE_ROW_FRACTION = 0.35;
const MIN_COMPOSER_VISIBLE_ROWS = 3;
const MAX_COMPOSER_VISIBLE_ROWS = 8;
const TRANSCRIPT_FRAME_ROWS = 4;
const MIN_TRANSCRIPT_HEIGHT = 4;
const TRANSCRIPT_GUTTER_WIDTH = 2;

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
  ["Shift-Enter", "insert a newline"],
  ["Ctrl-C", "stop the active run and exit"],
  ["Tab", "complete slash commands"],
  ["Ctrl-R", "search input history"],
  ["Ctrl-F", "search the transcript"],
] as const;

export interface BuildWelcomeTranscriptLinesOptions {
  width: number;
  providerName: string;
  model: string;
  thinkingLabel: string;
  storageMode: string;
  cwd: string;
}

export interface BuildChatViewModelOptions {
  terminalWidth: number;
  terminalRows: number;
  transcriptLines: TranscriptLine[];
  transcriptSearchActive: boolean;
  transcriptSearchQuery: string;
  transcriptSearchSelection: number;
  threadPickerActive: boolean;
  historySearchActive: boolean;
  historySearchQuery: string;
  historySearchSelection: number;
  historyMatchCount: number;
  historyPreview: string | null;
  notice: NoticeState | null;
  slashContext: SlashCompletionContext | null;
  slashCompletionIndex: number;
  followTranscript: boolean;
  scrollTop: number;
  pendingLocalInputLines: string[];
  composerLayout: ComposerLayout;
  isRunning: boolean;
  runStartedAt: number;
  currentThreadId: string;
  providerName: string;
  model: string;
  thinkingLabel: string;
  storageMode: string;
  modeLabel: string;
  cwd: string;
  now?: number;
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

export function normalizeInlineText(value: string): string {
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

function buildWelcomeDetailLines(label: string, value: string, width: number): string[] {
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

function buildWelcomeIdentityLines(options: BuildWelcomeTranscriptLinesOptions, width: number): string[] {
  return [
    centerAnsiText(theme.bold(theme.white("Welcome to Panda")), width),
    "",
    ...PANDA_SPLASH.map((line) => centerAnsiText(theme.mint(line), width)),
    "",
    theme.bold(theme.slate("Session")),
    ...buildWelcomeDetailLines("Provider", options.providerName, width),
    ...buildWelcomeDetailLines("Model", options.model, width),
    ...buildWelcomeDetailLines("Thinking", options.thinkingLabel, width),
    ...buildWelcomeDetailLines("Storage", options.storageMode, width),
    ...buildWelcomeDetailLines("Path", homeRelativePath(options.cwd), width),
  ];
}

function buildWelcomeGuideLines(width: number): string[] {
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

function buildTwoColumnWelcomeLines(
  options: BuildWelcomeTranscriptLinesOptions,
  panelWidth: number,
): TranscriptLine[] {
  const innerContentWidth = Math.max(20, panelWidth - 8);
  const leftWidth = Math.max(28, Math.min(innerContentWidth - 20, Math.min(34, Math.floor(innerContentWidth * 0.36))));
  const rightWidth = Math.max(20, innerContentWidth - leftWidth);
  const leftLines = buildWelcomeIdentityLines(options, leftWidth);
  const rightLines = buildWelcomeGuideLines(rightWidth);
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

function buildStackedWelcomeLines(
  options: BuildWelcomeTranscriptLinesOptions,
  panelWidth: number,
): TranscriptLine[] {
  const contentWidth = Math.max(20, panelWidth - 4);
  const contentLines = [
    ...buildWelcomeIdentityLines(options, contentWidth),
    "",
    theme.slate("─".repeat(contentWidth)),
    ...buildWelcomeGuideLines(contentWidth),
  ];
  const lines = [renderTranscriptLine(theme.coral(`┌${"─".repeat(panelWidth - 2)}┐`))];

  for (const line of contentLines) {
    lines.push(renderTranscriptLine(`${theme.coral("│")} ${padAnsiEnd(line, contentWidth)} ${theme.coral("│")}`));
  }

  lines.push(renderTranscriptLine(theme.coral(`└${"─".repeat(panelWidth - 2)}┘`)));
  return lines;
}

export function buildWelcomeTranscriptLines(options: BuildWelcomeTranscriptLinesOptions): TranscriptLine[] {
  const availableWidth = Math.max(20, options.width - TRANSCRIPT_GUTTER_WIDTH);
  const panelWidth = Math.min(availableWidth, WELCOME_MAX_WIDTH);
  return panelWidth >= WELCOME_TWO_COLUMN_MIN_WIDTH
    ? buildTwoColumnWelcomeLines(options, panelWidth)
    : buildStackedWelcomeLines(options, panelWidth);
}

function buildPromptInfoLine(
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

function buildInfoLine(options: {
  width: number;
  threadPickerActive: boolean;
  transcriptSearchActive: boolean;
  transcriptSearchQuery: string;
  transcriptSearchSelection: number;
  transcriptMatches: readonly number[];
  selectedTranscriptLine: number | null;
  transcriptLines: readonly TranscriptLine[];
  historySearchActive: boolean;
  historySearchQuery: string;
  historySearchSelection: number;
  historyMatchCount: number;
  historyPreview: string | null;
  notice: NoticeState | null;
  slashContext: SlashCompletionContext | null;
  slashCompletionIndex: number;
  scrollLabel: string;
}): InfoLine {
  if (options.threadPickerActive) {
    return {
      text: theme.gold(truncatePlainText("threads · up/down select · enter resume · esc cancel", options.width)),
      cursorColumn: null,
    };
  }

  if (options.transcriptSearchActive) {
    const summary = options.transcriptMatches.length === 0
      ? "no matches"
      : `${clamp(options.transcriptSearchSelection, 0, options.transcriptMatches.length - 1) + 1}/${options.transcriptMatches.length}`;
    const preview = options.selectedTranscriptLine === null
      ? null
      : normalizeInlineText(options.transcriptLines[options.selectedTranscriptLine]?.plain ?? "");

    return buildPromptInfoLine(options.width, `find> ${options.transcriptSearchQuery}`, summary, preview);
  }

  if (options.historySearchActive) {
    const summary = options.historyMatchCount === 0
      ? "no matches"
      : `${clamp(options.historySearchSelection, 0, options.historyMatchCount - 1) + 1}/${options.historyMatchCount}`;
    const preview = normalizeInlineText(options.historyPreview ?? "");

    return buildPromptInfoLine(options.width, `history> ${options.historySearchQuery}`, summary, preview);
  }

  if (options.notice) {
    const text = truncatePlainText(options.notice.text, options.width);
    return {
      text: options.notice.tone === "error" ? theme.coral(text) : theme.gold(text),
      cursorColumn: null,
    };
  }

  if (options.slashContext && options.slashContext.matches.length > 0) {
    const selected = options.slashContext.matches[clamp(
      options.slashCompletionIndex,
      0,
      options.slashContext.matches.length - 1,
    )];
    const summary =
      `tab cycles · enter completes ${selected?.name ?? ""}` +
      `${selected?.expectsValue ? " <value>" : ""} · ${selected?.summary ?? ""}`;
    return {
      text: theme.gold(truncatePlainText(summary, options.width)),
      cursorColumn: null,
    };
  }

  if (options.transcriptSearchQuery.trim()) {
    const summary = options.transcriptMatches.length === 0
      ? "search no matches"
      : `search ${clamp(options.transcriptSearchSelection, 0, options.transcriptMatches.length - 1) + 1}/${options.transcriptMatches.length}`;
    return {
      text: theme.gold(truncatePlainText(`${summary} · ${options.scrollLabel}`, options.width)),
      cursorColumn: null,
    };
  }

  return {
    text: theme.dim(
      truncatePlainText(
        `${options.scrollLabel} · Enter send · Shift-Enter newline · Tab complete · Ctrl-R history · Ctrl-F find · PgUp/PgDn scroll`,
        options.width,
      ),
    ),
    cursorColumn: null,
  };
}

export function buildChatViewModel(options: BuildChatViewModelOptions): ViewModel {
  const width = Math.max(MIN_VIEW_WIDTH, Math.min(options.terminalWidth || DEFAULT_VIEW_WIDTH, MAX_VIEW_WIDTH));
  const rows = Math.max(MIN_VIEW_ROWS, options.terminalRows || DEFAULT_VIEW_ROWS);
  const transcriptMatches = options.transcriptSearchQuery.trim().length === 0
    ? []
    : options.transcriptLines.flatMap((line, index) => {
        return line.plain.toLowerCase().includes(options.transcriptSearchQuery.toLowerCase())
          ? [index]
          : [];
      });
  const selectedTranscriptLine = transcriptMatches.length === 0
    ? null
    : transcriptMatches[clamp(options.transcriptSearchSelection, 0, transcriptMatches.length - 1)] ?? null;
  let maxComposerVisible = clamp(
    Math.floor(rows * COMPOSER_VISIBLE_ROW_FRACTION),
    MIN_COMPOSER_VISIBLE_ROWS,
    MAX_COMPOSER_VISIBLE_ROWS,
  );
  let composerVisibleStart = Math.max(0, options.composerLayout.cursorRow - maxComposerVisible + 1);
  let composerVisibleLines = options.composerLayout.lines.slice(
    composerVisibleStart,
    composerVisibleStart + maxComposerVisible,
  );

  let transcriptHeight =
    rows - (TRANSCRIPT_FRAME_ROWS + options.pendingLocalInputLines.length + Math.max(1, composerVisibleLines.length));
  if (transcriptHeight < MIN_TRANSCRIPT_HEIGHT) {
    maxComposerVisible = Math.max(1, maxComposerVisible - (MIN_TRANSCRIPT_HEIGHT - transcriptHeight));
    composerVisibleStart = Math.max(0, options.composerLayout.cursorRow - maxComposerVisible + 1);
    composerVisibleLines = options.composerLayout.lines.slice(
      composerVisibleStart,
      composerVisibleStart + maxComposerVisible,
    );
    transcriptHeight = Math.max(
      1,
      rows - (TRANSCRIPT_FRAME_ROWS + options.pendingLocalInputLines.length + Math.max(1, composerVisibleLines.length)),
    );
  }

  const maxScrollTop = Math.max(0, options.transcriptLines.length - transcriptHeight);
  const resolvedScrollTop = clamp(
    options.followTranscript ? maxScrollTop : options.scrollTop,
    0,
    maxScrollTop,
  );
  const now = options.now ?? Date.now();
  const spinner = options.isRunning
    ? `${SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length]} `
    : "";
  const runLabel = options.isRunning ? "thinking" : "ready";
  const elapsedLabel = options.isRunning ? formatDuration(now - options.runStartedAt) : null;
  const statusText = [
    truncatePlainText(`thread ${options.currentThreadId || "new"}`, 28),
    options.providerName,
    options.model,
    `think ${options.thinkingLabel}`,
    options.storageMode,
    options.modeLabel,
    runLabel,
    elapsedLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  const totalTranscriptLines = options.transcriptLines.length;
  const scrollStart = totalTranscriptLines === 0 ? 0 : resolvedScrollTop + 1;
  const scrollEnd = Math.min(totalTranscriptLines, resolvedScrollTop + transcriptHeight);
  const scrollLabel = totalTranscriptLines === 0
    ? "lines 0/0"
    : `lines ${scrollStart}-${scrollEnd}/${totalTranscriptLines}${options.followTranscript ? " follow" : ""}`;

  return {
    width,
    rows,
    transcriptLines: options.transcriptLines,
    transcriptMatches,
    selectedTranscriptLine,
    transcriptHeight,
    resolvedScrollTop,
    maxScrollTop,
    pendingLocalInputLines: options.pendingLocalInputLines,
    composerVisibleLines,
    composerVisibleCursorRow: options.composerLayout.cursorRow - composerVisibleStart,
    composerCursorColumn: options.composerLayout.cursorColumn,
    headerLine:
      theme.bold(theme.coral("Panda")) +
      theme.dim(` · ${truncatePlainText(`cwd ${options.cwd} · ${options.currentThreadId || "no-thread"}`, Math.max(0, width - 8))}`),
    statusLine: options.isRunning
      ? theme.mint(truncatePlainText(`${spinner}${statusText}`, width))
      : theme.dim(truncatePlainText(statusText, width)),
    infoLine: buildInfoLine({
      width,
      threadPickerActive: options.threadPickerActive,
      transcriptSearchActive: options.transcriptSearchActive,
      transcriptSearchQuery: options.transcriptSearchQuery,
      transcriptSearchSelection: options.transcriptSearchSelection,
      transcriptMatches,
      selectedTranscriptLine,
      transcriptLines: options.transcriptLines,
      historySearchActive: options.historySearchActive,
      historySearchQuery: options.historySearchQuery,
      historySearchSelection: options.historySearchSelection,
      historyMatchCount: options.historyMatchCount,
      historyPreview: options.historyPreview,
      notice: options.notice,
      slashContext: options.slashContext,
      slashCompletionIndex: options.slashCompletionIndex,
      scrollLabel,
    }),
  };
}
