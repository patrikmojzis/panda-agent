export type WikiDiffLineType = "context" | "add" | "remove";

export interface WikiDiffLine {
  type: WikiDiffLineType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface WikiDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: readonly WikiDiffLine[];
}

export interface WikiContentDiff {
  equal: boolean;
  stats: {
    addedLines: number;
    removedLines: number;
    unchangedLines: number;
    leftLines: number;
    rightLines: number;
  };
  hunks: readonly WikiDiffHunk[];
  truncated: boolean;
}

interface BuildWikiContentDiffOptions {
  contextLines: number;
  maxOutputLines?: number;
  maxExactInputLines?: number;
}

const DEFAULT_MAX_OUTPUT_LINES = 400;
const DEFAULT_MAX_EXACT_INPUT_LINES = 1_600;

function splitContentLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }

  return value.split(/\r?\n/);
}

function buildTooLargeDiff(leftLines: readonly string[], rightLines: readonly string[]): WikiContentDiff {
  return {
    equal: false,
    stats: {
      addedLines: rightLines.length,
      removedLines: leftLines.length,
      unchangedLines: 0,
      leftLines: leftLines.length,
      rightLines: rightLines.length,
    },
    hunks: [],
    truncated: true,
  };
}

function buildLineEntries(leftLines: readonly string[], rightLines: readonly string[]): WikiDiffLine[] {
  const leftLength = leftLines.length;
  const rightLength = rightLines.length;
  const rowWidth = rightLength + 1;
  const table = new Uint16Array((leftLength + 1) * rowWidth);
  const cell = (leftIndex: number, rightIndex: number): number =>
    table[leftIndex * rowWidth + rightIndex] ?? 0;

  for (let leftIndex = leftLength - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = rightLength - 1; rightIndex >= 0; rightIndex -= 1) {
      const offset = leftIndex * rowWidth + rightIndex;
      table[offset] = leftLines[leftIndex] === rightLines[rightIndex]
        ? cell(leftIndex + 1, rightIndex + 1) + 1
        : Math.max(
          cell(leftIndex + 1, rightIndex),
          cell(leftIndex, rightIndex + 1),
        );
    }
  }

  const entries: WikiDiffLine[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftLength && rightIndex < rightLength) {
    if (leftLines[leftIndex] === rightLines[rightIndex]) {
      entries.push({
        type: "context",
        text: leftLines[leftIndex] ?? "",
        oldLine: leftIndex + 1,
        newLine: rightIndex + 1,
      });
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      cell(leftIndex + 1, rightIndex) >= cell(leftIndex, rightIndex + 1)
    ) {
      entries.push({
        type: "remove",
        text: leftLines[leftIndex] ?? "",
        oldLine: leftIndex + 1,
      });
      leftIndex += 1;
    } else {
      entries.push({
        type: "add",
        text: rightLines[rightIndex] ?? "",
        newLine: rightIndex + 1,
      });
      rightIndex += 1;
    }
  }

  while (leftIndex < leftLength) {
    entries.push({
      type: "remove",
      text: leftLines[leftIndex] ?? "",
      oldLine: leftIndex + 1,
    });
    leftIndex += 1;
  }

  while (rightIndex < rightLength) {
    entries.push({
      type: "add",
      text: rightLines[rightIndex] ?? "",
      newLine: rightIndex + 1,
    });
    rightIndex += 1;
  }

  return entries;
}

function startLine(lines: readonly WikiDiffLine[], key: "oldLine" | "newLine"): number {
  return lines.find((line) => line[key] !== undefined)?.[key] ?? 0;
}

function buildHunks(entries: readonly WikiDiffLine[], contextLines: number, maxOutputLines: number): {
  hunks: WikiDiffHunk[];
  truncated: boolean;
} {
  const changedIndexes = entries
    .map((entry, index) => entry.type === "context" ? -1 : index)
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) {
    return {hunks: [], truncated: false};
  }

  const ranges: Array<{start: number; end: number}> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(entries.length - 1, index + contextLines);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({start, end});
    }
  }

  const hunks: WikiDiffHunk[] = [];
  let emittedLines = 0;
  let truncated = false;
  for (const range of ranges) {
    const remaining = maxOutputLines - emittedLines;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const allLines = entries.slice(range.start, range.end + 1);
    const lines = allLines.slice(0, remaining);
    if (lines.length < allLines.length) {
      truncated = true;
    }
    emittedLines += lines.length;
    hunks.push({
      oldStart: startLine(lines, "oldLine"),
      oldLines: lines.filter((line) => line.type !== "add").length,
      newStart: startLine(lines, "newLine"),
      newLines: lines.filter((line) => line.type !== "remove").length,
      lines,
    });
    if (truncated) {
      break;
    }
  }

  return {hunks, truncated};
}

export function buildWikiContentDiff(
  leftContent: string,
  rightContent: string,
  options: BuildWikiContentDiffOptions,
): WikiContentDiff {
  const leftLines = splitContentLines(leftContent);
  const rightLines = splitContentLines(rightContent);
  if (leftContent === rightContent) {
    return {
      equal: true,
      stats: {
        addedLines: 0,
        removedLines: 0,
        unchangedLines: leftLines.length,
        leftLines: leftLines.length,
        rightLines: rightLines.length,
      },
      hunks: [],
      truncated: false,
    };
  }

  const maxExactInputLines = options.maxExactInputLines ?? DEFAULT_MAX_EXACT_INPUT_LINES;
  if (leftLines.length + rightLines.length > maxExactInputLines) {
    return buildTooLargeDiff(leftLines, rightLines);
  }

  const entries = buildLineEntries(leftLines, rightLines);
  const addedLines = entries.filter((entry) => entry.type === "add").length;
  const removedLines = entries.filter((entry) => entry.type === "remove").length;
  const unchangedLines = entries.filter((entry) => entry.type === "context").length;
  const hunks = buildHunks(
    entries,
    options.contextLines,
    options.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES,
  );

  return {
    equal: addedLines === 0 && removedLines === 0,
    stats: {
      addedLines,
      removedLines,
      unchangedLines,
      leftLines: leftLines.length,
      rightLines: rightLines.length,
    },
    hunks: hunks.hunks,
    truncated: hunks.truncated,
  };
}
