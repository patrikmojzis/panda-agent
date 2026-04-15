import type {ThinkingLevel} from "../../kernel/agent/index.js";
import {summarizeMessageText} from "../../personas/panda/message-preview.js";
import type {ComposerState} from "./composer.js";
import type {SlashCompletionContext} from "./commands.js";
import {
    buildChatViewModel,
    buildWelcomeTranscriptLines,
    normalizeInlineText,
    type NoticeState,
    THREAD_PICKER_VISIBLE_COUNT,
    type TranscriptLine,
    type ViewModel,
} from "./chat-view.js";
import {renderMarkdownLines} from "./markdown.js";
import {clamp, formatDuration, padAnsiEnd, truncatePlainText, wrapPlainText,} from "./screen.js";
import {
    formatThinkingLevel,
    LABEL_WIDTH,
    MAX_VISIBLE_PENDING_LOCAL_INPUTS,
    type PendingLocalInput,
    type SearchState,
    type ThreadPickerState,
    TRANSCRIPT_GUTTER_WIDTH,
    type TranscriptEntry,
    type TranscriptLineCacheEntry,
} from "./chat-shared.js";
import {stripAnsi, theme} from "./theme.js";

interface BuildPandaChatViewInput {
  terminalWidth: number;
  terminalRows: number;
  transcript: readonly TranscriptEntry[];
  transcriptLineCache: Map<number, TranscriptLineCacheEntry>;
  shouldShowSplash: boolean;
  model: string;
  thinking?: ThinkingLevel;
  cwd: string;
  threadPicker: ThreadPickerState;
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

function buildThreadPickerLayout(input: {
  width: number;
  threadPicker: ThreadPickerState;
  currentThreadId: string;
  model: string;
}): {lines: string[]; cursorRow: number; cursorColumn: number} {
  const {width, threadPicker, currentThreadId, model} = input;
  const header = theme.bold(theme.gold("threads")) + theme.slate(" > ");
  const headerWidth = stripAnsi(header).length;
  const bodyWidth = Math.max(1, width - 2);
  const lines: string[] = [
    header + truncatePlainText(
      threadPicker.loading
        ? "loading recent threads..."
        : "up/down select · enter resume · esc cancel",
      Math.max(1, width - headerWidth),
    ),
  ];

  if (threadPicker.error) {
    lines.push(theme.coral(truncatePlainText(threadPicker.error, bodyWidth)));
  } else if (!threadPicker.loading && threadPicker.summaries.length === 0) {
    lines.push(theme.dim("No stored threads yet."));
  } else {
    const maxStart = Math.max(0, threadPicker.summaries.length - THREAD_PICKER_VISIBLE_COUNT);
    const start = clamp(
      threadPicker.selected - Math.floor(THREAD_PICKER_VISIBLE_COUNT / 2),
      0,
      maxStart,
    );
    const visible = threadPicker.summaries.slice(start, start + THREAD_PICKER_VISIBLE_COUNT);

    for (const [offset, summary] of visible.entries()) {
      const absoluteIndex = start + offset;
      const selected = absoluteIndex === threadPicker.selected;
      const prefix = selected ? theme.gold("› ") : theme.dim("  ");
      const current = summary.thread.id === currentThreadId ? " · current" : "";
      const last = summary.lastMessage
        ? normalizeInlineText(summarizeMessageText(summary.lastMessage.message) || summary.lastMessage.source)
        : "no messages yet";
      const shortId = summary.thread.id.length > 12
        ? `${summary.thread.id.slice(0, 8)}…${summary.thread.id.slice(-4)}`
        : summary.thread.id;
      lines.push(prefix + truncatePlainText(
        `${shortId}${current} · ${summary.thread.model ?? model} · ${summary.messageCount} msgs · ${last}`,
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
  threadPickerActive: boolean;
  pendingLocalInputs: readonly PendingLocalInput[];
}): string[] {
  if (input.threadPickerActive || input.pendingLocalInputs.length === 0) {
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

function buildCachedTranscriptLines(input: {
  entry: TranscriptEntry;
  bodyWidth: number;
  transcriptLineCache: Map<number, TranscriptLineCacheEntry>;
}): readonly TranscriptLine[] {
  const cached = input.transcriptLineCache.get(input.entry.id);
  if (
    cached
    && cached.role === input.entry.role
    && cached.title === input.entry.title
    && cached.body === input.entry.body
    && cached.bodyWidth === input.bodyWidth
  ) {
    return cached.lines;
  }

  const labelColor =
    input.entry.role === "assistant"
      ? theme.coral
      : input.entry.role === "user"
        ? theme.cyan
        : input.entry.role === "tool"
          ? theme.gold
          : input.entry.role === "error"
            ? theme.coral
            : theme.slate;
  const labelText = truncatePlainText(input.entry.title, LABEL_WIDTH);
  const label = padAnsiEnd(theme.bold(labelColor(labelText)), LABEL_WIDTH);
  const shouldRenderMarkdown = input.entry.role === "assistant"
    || (input.entry.role === "meta" && input.entry.title === "usage");
  const wrappedBody = shouldRenderMarkdown
    ? renderMarkdownLines(input.entry.body, input.bodyWidth)
    : wrapPlainText(input.entry.body, input.bodyWidth).map((line) => ({
        plain: line,
        rendered: line,
      }));
  const lines = wrappedBody.map((line, index) => {
    return {
      plain: `${input.entry.title} ${line.plain}`.trimEnd(),
      rendered: `${index === 0 ? label : " ".repeat(LABEL_WIDTH)}${line.rendered}`,
    } satisfies TranscriptLine;
  });

  input.transcriptLineCache.set(input.entry.id, {
    role: input.entry.role,
    title: input.entry.title,
    body: input.entry.body,
    bodyWidth: input.bodyWidth,
    lines,
  });
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
  const bodyWidth = Math.max(20, input.width - TRANSCRIPT_GUTTER_WIDTH - LABEL_WIDTH);
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

    lines.push(...buildCachedTranscriptLines({
      entry,
      bodyWidth,
      transcriptLineCache: input.transcriptLineCache,
    }));
  }

  return lines;
}

function buildComposerLayout(input: {
  width: number;
  composer: ComposerState;
  threadPicker: ThreadPickerState;
  currentThreadId: string;
  model: string;
}): {lines: string[]; cursorRow: number; cursorColumn: number} {
  if (input.threadPicker.active) {
    return buildThreadPickerLayout({
      width: input.width,
      threadPicker: input.threadPicker,
      currentThreadId: input.currentThreadId,
      model: input.model,
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

export function buildPandaChatView(input: BuildPandaChatViewInput): ViewModel {
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
    threadPicker: input.threadPicker,
    currentThreadId: input.currentThreadId,
    model: input.model,
  });
  const pendingLocalInputLines = buildPendingLocalInputLines({
    width,
    threadPickerActive: input.threadPicker.active,
    pendingLocalInputs: input.pendingLocalInputs,
  });

  return buildChatViewModel({
    terminalWidth: input.terminalWidth || 100,
    terminalRows: input.terminalRows || 32,
    transcriptLines,
    transcriptSearchActive: input.transcriptSearch.active,
    transcriptSearchQuery: input.transcriptSearch.query,
    transcriptSearchSelection: input.transcriptSearch.selected,
    threadPickerActive: input.threadPicker.active,
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
