export interface ComposerState {
  value: string;
  cursor: number;
  preferredColumn: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function lineStarts(value: string): number[] {
  const starts = [0];

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      starts.push(index + 1);
    }
  }

  return starts;
}

function findLineIndex(starts: readonly number[], cursor: number): number {
  let current = 0;

  for (let index = 1; index < starts.length; index += 1) {
    const start = starts[index];
    if (start === undefined || start > cursor) {
      break;
    }

    current = index;
  }

  return current;
}

function lineEnd(value: string, start: number): number {
  const nextNewline = value.indexOf("\n", start);
  return nextNewline === -1 ? value.length : nextNewline;
}

function moveVertical(state: ComposerState, direction: -1 | 1): ComposerState {
  const starts = lineStarts(state.value);
  const currentLine = findLineIndex(starts, state.cursor);
  const currentStart = starts[currentLine] ?? 0;
  const currentColumn = state.cursor - currentStart;
  const desiredColumn = state.preferredColumn ?? currentColumn;
  const targetLine = currentLine + direction;

  if (targetLine < 0 || targetLine >= starts.length) {
    return {
      ...state,
      preferredColumn: desiredColumn,
    };
  }

  const targetStart = starts[targetLine] ?? 0;
  const targetEnd = lineEnd(state.value, targetStart);

  return {
    value: state.value,
    cursor: targetStart + Math.min(desiredColumn, targetEnd - targetStart),
    preferredColumn: desiredColumn,
  };
}

function withCursor(state: ComposerState, cursor: number): ComposerState {
  return {
    value: state.value,
    cursor: clamp(cursor, 0, state.value.length),
    preferredColumn: null,
  };
}

function isWhitespace(value: string | undefined): boolean {
  return value === undefined || /\s/.test(value);
}

function findPreviousWordStart(value: string, cursor: number): number {
  let nextCursor = clamp(cursor, 0, value.length);

  while (nextCursor > 0 && isWhitespace(value[nextCursor - 1])) {
    nextCursor -= 1;
  }

  while (nextCursor > 0 && !isWhitespace(value[nextCursor - 1])) {
    nextCursor -= 1;
  }

  return nextCursor;
}

function findNextWordEnd(value: string, cursor: number): number {
  let nextCursor = clamp(cursor, 0, value.length);

  while (nextCursor < value.length && isWhitespace(value[nextCursor])) {
    nextCursor += 1;
  }

  while (nextCursor < value.length && !isWhitespace(value[nextCursor])) {
    nextCursor += 1;
  }

  return nextCursor;
}

export function createComposerState(value = ""): ComposerState {
  return {
    value,
    cursor: value.length,
    preferredColumn: null,
  };
}

export function setComposerValue(
  value: string,
  cursor = value.length,
): ComposerState {
  return {
    value,
    cursor: clamp(cursor, 0, value.length),
    preferredColumn: null,
  };
}

export function insertText(state: ComposerState, text: string): ComposerState {
  const nextValue = state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);

  return {
    value: nextValue,
    cursor: state.cursor + text.length,
    preferredColumn: null,
  };
}

export function backspace(state: ComposerState): ComposerState {
  if (state.cursor === 0) {
    return state;
  }

  const nextValue = state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor);
  return {
    value: nextValue,
    cursor: state.cursor - 1,
    preferredColumn: null,
  };
}

export function deleteForward(state: ComposerState): ComposerState {
  if (state.cursor >= state.value.length) {
    return state;
  }

  const nextValue = state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1);
  return {
    value: nextValue,
    cursor: state.cursor,
    preferredColumn: null,
  };
}

export function moveCursorLeft(state: ComposerState): ComposerState {
  return withCursor(state, state.cursor - 1);
}

export function moveCursorRight(state: ComposerState): ComposerState {
  return withCursor(state, state.cursor + 1);
}

export function moveCursorWordLeft(state: ComposerState): ComposerState {
  return withCursor(state, findPreviousWordStart(state.value, state.cursor));
}

export function moveCursorWordRight(state: ComposerState): ComposerState {
  return withCursor(state, findNextWordEnd(state.value, state.cursor));
}

export function moveCursorLineStart(state: ComposerState): ComposerState {
  const starts = lineStarts(state.value);
  const currentLine = findLineIndex(starts, state.cursor);
  return withCursor(state, starts[currentLine] ?? 0);
}

export function moveCursorLineEnd(state: ComposerState): ComposerState {
  const starts = lineStarts(state.value);
  const currentLine = findLineIndex(starts, state.cursor);
  const start = starts[currentLine] ?? 0;
  return withCursor(state, lineEnd(state.value, start));
}

export function moveCursorUp(state: ComposerState): ComposerState {
  return moveVertical(state, -1);
}

export function moveCursorDown(state: ComposerState): ComposerState {
  return moveVertical(state, 1);
}

export function deleteWordBackward(state: ComposerState): ComposerState {
  const nextCursor = findPreviousWordStart(state.value, state.cursor);
  if (nextCursor === state.cursor) {
    return state;
  }

  return {
    value: state.value.slice(0, nextCursor) + state.value.slice(state.cursor),
    cursor: nextCursor,
    preferredColumn: null,
  };
}
