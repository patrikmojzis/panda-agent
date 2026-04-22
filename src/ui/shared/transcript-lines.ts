import type {TranscriptLine} from "../tui/chat-view.js";
import {renderMarkdownLines} from "../tui/markdown.js";
import {padAnsiEnd, truncatePlainText, wrapPlainText,} from "../tui/screen.js";
import {LABEL_WIDTH, TRANSCRIPT_GUTTER_WIDTH, type TranscriptEntry, type TranscriptLineCacheEntry,} from "../tui/chat-shared.js";
import {theme} from "../tui/theme.js";

export function buildTranscriptEntryLines(input: {
  entry: TranscriptEntry;
  width: number;
  transcriptLineCache: Map<number, TranscriptLineCacheEntry>;
}): readonly TranscriptLine[] {
  const bodyWidth = Math.max(20, input.width - TRANSCRIPT_GUTTER_WIDTH - LABEL_WIDTH);
  const cached = input.transcriptLineCache.get(input.entry.id);
  if (
    cached
    && cached.role === input.entry.role
    && cached.title === input.entry.title
    && cached.body === input.entry.body
    && cached.bodyWidth === bodyWidth
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
    ? renderMarkdownLines(input.entry.body, bodyWidth)
    : wrapPlainText(input.entry.body, bodyWidth).map((line) => ({
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
    bodyWidth,
    lines,
  });
  return lines;
}

export function buildStoredTranscriptLines(input: {
  width: number;
  transcript: readonly TranscriptEntry[];
  transcriptLineCache: Map<number, TranscriptLineCacheEntry>;
}): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const entry of input.transcript) {
    lines.push(...buildTranscriptEntryLines({
      entry,
      width: input.width,
      transcriptLineCache: input.transcriptLineCache,
    }));
  }

  return lines;
}
