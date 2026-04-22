import type {ThinkingLevel} from "../../kernel/agent/index.js";
import type {ComposerState} from "./composer.js";
import type {SlashCompletionContext} from "./commands.js";
import {
    buildChatViewModel,
    buildWelcomeTranscriptLines,
    normalizeInlineText,
    type NoticeState,
    SESSION_PICKER_VISIBLE_COUNT,
    type TranscriptLine,
    type ViewModel,
} from "./chat-view.js";
import {clamp, formatDuration, truncatePlainText,} from "./screen.js";
import {
    formatThinkingLevel,
    MAX_VISIBLE_PENDING_LOCAL_INPUTS,
    type PendingLocalInput,
    type SearchState,
    type SessionPickerState,
    type TranscriptEntry,
    type TranscriptLineCacheEntry,
} from "./chat-shared.js";
import {stripAnsi, theme} from "./theme.js";
import {buildTranscriptEntryLines} from "../shared/transcript-lines.js";

interface BuildChatViewInput {
  terminalWidth: number;
  terminalRows: number;
  transcript: readonly TranscriptEntry[];
  transcriptLineCache: Map<number, TranscriptLineCacheEntry>;
  shouldShowSplash: boolean;
  model: string;
  thinking?: ThinkingLevel;
  cwd: string;
  sessionPicker: SessionPickerState;
  currentSessionId: string;
  currentThreadId: string;
  pendingLocalInputs: readonly PendingLocalInput[];
  composer: ComposerState;
  historySearch: SearchState;
  transcriptSearch: SearchState;
  historyMatchCount: number;
  historyPreview: string | null;
  notice: NoticeState | null;
  slashContext: SlashCompletionContext | null;
  slashCompletionIndex: number;
  followTranscript: boolean;
  scrollTop: number;
  isRunning: boolean;
  runStartedAt: number;
  agentLabel: string;
  identityHandle: string;
  modeLabel: string;
}

export interface ChatScreenFrame {
  screenLines: string[];
  cursorRow: number;
  cursorColumn: number;
}

function buildSessionPickerLayout(input: {
  width: number;
  sessionPicker: SessionPickerState;
  currentSessionId: string;
}): {lines: string[]; cursorRow: number; cursorColumn: number} {
  const {width, sessionPicker, currentSessionId} = input;
  const header = theme.bold(theme.gold("sessions")) + theme.slate(" > ");
  const headerWidth = stripAnsi(header).length;
  const bodyWidth = Math.max(1, width - 2);
  const lines: string[] = [
    header + truncatePlainText(
      sessionPicker.loading
        ? "loading sessions..."
        : "up/down select · enter open · esc cancel",
      Math.max(1, width - headerWidth),
    ),
  ];

  if (sessionPicker.error) {
    lines.push(theme.coral(truncatePlainText(sessionPicker.error, bodyWidth)));
  } else if (!sessionPicker.loading && sessionPicker.sessions.length === 0) {
    lines.push(theme.dim("No sessions on this agent yet."));
  } else {
    const maxStart = Math.max(0, sessionPicker.sessions.length - SESSION_PICKER_VISIBLE_COUNT);
    const start = clamp(
      sessionPicker.selected - Math.floor(SESSION_PICKER_VISIBLE_COUNT / 2),
      0,
      maxStart,
    );
    const visible = sessionPicker.sessions.slice(start, start + SESSION_PICKER_VISIBLE_COUNT);

    for (const [offset, session] of visible.entries()) {
      const absoluteIndex = start + offset;
      const selected = absoluteIndex === sessionPicker.selected;
      const prefix = selected ? theme.gold("› ") : theme.dim("  ");
      const current = session.id === currentSessionId ? " · current" : "";
      const shortId = session.id.length > 12
        ? `${session.id.slice(0, 8)}…${session.id.slice(-4)}`
        : session.id;
      const shortThreadId = session.currentThreadId.length > 12
        ? `${session.currentThreadId.slice(0, 8)}…${session.currentThreadId.slice(-4)}`
        : session.currentThreadId;
      lines.push(prefix + truncatePlainText(
        `${session.kind} · session ${shortId}${current} · thread ${shortThreadId}`,
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

function buildPendingLocalInputLines(input: {
  width: number;
  sessionPickerActive: boolean;
  pendingLocalInputs: readonly PendingLocalInput[];
}): string[] {
  if (input.sessionPickerActive || input.pendingLocalInputs.length === 0) {
    return [];
  }

  const lines: string[] = [];
  const header = theme.bold(theme.gold("queued")) + theme.slate(" > ");
  const headerWidth = stripAnsi(header).length;
  lines.push(
    header + truncatePlainText(
      `${input.pendingLocalInputs.length} pending ${input.pendingLocalInputs.length === 1 ? "message" : "messages"}`,
      Math.max(1, input.width - headerWidth),
    ),
  );

  const visible = input.pendingLocalInputs.slice(-MAX_VISIBLE_PENDING_LOCAL_INPUTS);
  const hiddenCount = input.pendingLocalInputs.length - visible.length;
  if (hiddenCount > 0) {
    lines.push(theme.dim(truncatePlainText(`... ${hiddenCount} older queued`, input.width)));
  }

  for (const entry of visible) {
    const age = formatDuration(Date.now() - entry.createdAt);
    const summary = normalizeInlineText(entry.text) || "(empty)";
    lines.push(theme.dim(truncatePlainText(`+ ${summary} · ${age}`, input.width)));
  }

  return lines;
}

function buildTranscriptLines(input: {
  width: number;
  transcript: readonly TranscriptEntry[];
  transcriptLineCache: Map<number, TranscriptLineCacheEntry>;
  shouldShowSplash: boolean;
  model: string;
  thinking?: ThinkingLevel;
  cwd: string;
}): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const visibleEntries = input.shouldShowSplash
    ? input.transcript
    : input.transcript.filter((entry) => entry.title !== "welcome");

  for (const entry of visibleEntries) {
    if (entry.title === "welcome" && input.shouldShowSplash) {
      lines.push(...buildWelcomeTranscriptLines({
        width: input.width,
        model: input.model,
        thinkingLabel: formatThinkingLevel(input.thinking),
        cwd: input.cwd,
      }));
      continue;
    }

    lines.push(...buildTranscriptEntryLines({
      entry,
      width: input.width,
      transcriptLineCache: input.transcriptLineCache,
    }));
  }

  return lines;
}

function buildComposerLayout(input: {
  width: number;
  composer: ComposerState;
  sessionPicker: SessionPickerState;
  currentSessionId: string;
}): {lines: string[]; cursorRow: number; cursorColumn: number} {
  if (input.sessionPicker.active) {
    return buildSessionPickerLayout({
      width: input.width,
      sessionPicker: input.sessionPicker,
      currentSessionId: input.currentSessionId,
    });
  }

  const firstPrefix = theme.bold(theme.cyan("you")) + theme.slate(" > ");
  const nextPrefix = theme.dim("…   ");
  const firstPrefixWidth = stripAnsi(firstPrefix).length;
  const nextPrefixWidth = stripAnsi(nextPrefix).length;
  const firstLineWidth = Math.max(1, input.width - firstPrefixWidth);
  const nextLineWidth = Math.max(1, input.width - nextPrefixWidth);
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

  for (let index = 0; index <= input.composer.value.length; index += 1) {
    if (index === input.composer.cursor) {
      cursorRow = lines.length;
      cursorColumn = currentPrefixWidth + current.length + 1;
    }

    if (index === input.composer.value.length) {
      break;
    }

    const char = input.composer.value[index] ?? "";
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

export function buildChatView(input: BuildChatViewInput): ViewModel {
  const width = Math.max(72, Math.min(input.terminalWidth || 100, 140));
  const transcriptLines = buildTranscriptLines({
    width,
    transcript: input.transcript,
    transcriptLineCache: input.transcriptLineCache,
    shouldShowSplash: input.shouldShowSplash,
    model: input.model,
    thinking: input.thinking,
    cwd: input.cwd,
  });
  const composerLayout = buildComposerLayout({
    width,
    composer: input.composer,
    sessionPicker: input.sessionPicker,
    currentSessionId: input.currentSessionId,
  });
  const pendingLocalInputLines = buildPendingLocalInputLines({
    width,
    sessionPickerActive: input.sessionPicker.active,
    pendingLocalInputs: input.pendingLocalInputs,
  });

  return buildChatViewModel({
    terminalWidth: input.terminalWidth || 100,
    terminalRows: input.terminalRows || 32,
    transcriptLines,
    transcriptSearchActive: input.transcriptSearch.active,
    transcriptSearchQuery: input.transcriptSearch.query,
    transcriptSearchSelection: input.transcriptSearch.selected,
    sessionPickerActive: input.sessionPicker.active,
    historySearchActive: input.historySearch.active,
    historySearchQuery: input.historySearch.query,
    historySearchSelection: input.historySearch.selected,
    historyMatchCount: input.historyMatchCount,
    historyPreview: input.historyPreview,
    notice: input.notice,
    slashContext: input.slashContext,
    slashCompletionIndex: input.slashCompletionIndex,
    followTranscript: input.followTranscript,
    scrollTop: input.scrollTop,
    pendingLocalInputLines,
    composerLayout,
    isRunning: input.isRunning,
    runStartedAt: input.runStartedAt,
    agentLabel: input.agentLabel,
    identityHandle: input.identityHandle,
    currentSessionId: input.currentSessionId,
    currentThreadId: input.currentThreadId,
    model: input.model,
    thinkingLabel: formatThinkingLevel(input.thinking),
    modeLabel: input.modeLabel,
    cwd: input.cwd,
  });
}

export function buildChatScreenFrame(input: {
  view: ViewModel;
  historySearchActive: boolean;
  transcriptSearchActive: boolean;
}): ChatScreenFrame {
  const visibleTranscript = input.view.transcriptLines
    .slice(input.view.resolvedScrollTop, input.view.resolvedScrollTop + input.view.transcriptHeight)
    .map((line, index) => {
      const absoluteIndex = input.view.resolvedScrollTop + index;
      const marker = absoluteIndex === input.view.selectedTranscriptLine ? theme.gold("› ") : "  ";
      return marker + line.rendered;
    });

  while (visibleTranscript.length < input.view.transcriptHeight) {
    visibleTranscript.push("");
  }

  const separator = theme.slate("─".repeat(input.view.width));
  const screenLines = [
    input.view.headerLine,
    ...visibleTranscript,
    separator,
    input.view.statusLine,
    input.view.infoLine.text,
    ...input.view.pendingLocalInputLines,
    ...input.view.composerVisibleLines,
  ];
  const infoLineRow = screenLines.length - input.view.composerVisibleLines.length - input.view.pendingLocalInputLines.length;
  const composerStartRow = infoLineRow + 1 + input.view.pendingLocalInputLines.length;
  let cursorRow = composerStartRow + input.view.composerVisibleCursorRow;
  let cursorColumn = input.view.composerCursorColumn;

  if (input.historySearchActive || input.transcriptSearchActive) {
    cursorRow = infoLineRow;
    cursorColumn = input.view.infoLine.cursorColumn ?? cursorColumn;
  }

  return {
    screenLines,
    cursorRow,
    cursorColumn,
  };
}
