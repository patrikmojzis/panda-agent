import type { ComposerState } from "./composer.js";

export interface KeyLike {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
  code?: string;
}

export type ComposerMetaAction = "word-left" | "word-right" | "delete-word-backward";
export type ComposerEnterAction = "newline" | "replace-backslash" | "submit" | null;

const ENABLE_KITTY_KEYBOARD = "\u001b[>1u";
const DISABLE_KITTY_KEYBOARD = "\u001b[<u";
const ENABLE_MODIFY_OTHER_KEYS = "\u001b[>4;2m";
const DISABLE_MODIFY_OTHER_KEYS = "\u001b[>4m";
const META_WORD_LEFT_SEQUENCES = new Set(["\u001bb", "\u001b[1;3D", "\u001b[1;9D", "\u001b\u001b[D"]);
const META_WORD_RIGHT_SEQUENCES = new Set(["\u001bf", "\u001b[1;3C", "\u001b[1;9C", "\u001b\u001b[C"]);
const META_BACKSPACE_SEQUENCES = new Set(["\u001b\u007f", "\u001b\b"]);
const SHIFT_ENTER_SEQUENCES = new Set(["\u001b[13;2u", "\u001b[27;2;13~"]);
const CSI_U_SEQUENCE_RE = /^\u001b\[\d+(?:;\d+)?u$/;
const MODIFY_OTHER_KEYS_SEQUENCE_RE = /^\u001b\[27;\d+;\d+~$/;

export const COMPOSER_NEWLINE_HINT = "\\ + Enter newline";
export const NEWLINE_HELP_LINES = [
  "\\ + Enter inserts a newline.",
  "Shift-Enter or Meta-Enter also inserts a newline when your terminal exposes it.",
] as const;
export const WELCOME_NEWLINE_KEYS = [
  ["\\ + Enter", "insert a newline"],
  ["Shift-Enter", "insert a newline when supported"],
] as const;

function isExtendedKeySequence(sequence: string): boolean {
  return CSI_U_SEQUENCE_RE.test(sequence) || MODIFY_OTHER_KEYS_SEQUENCE_RE.test(sequence);
}

function isExtendedKeySequencePrefix(sequence: string): boolean {
  return sequence.startsWith("\u001b[") && /^\u001b\[[\d;]+$/.test(sequence);
}

function isShiftEnter(sequence: string, key: KeyLike): boolean {
  if (SHIFT_ENTER_SEQUENCES.has(sequence)) {
    return true;
  }

  // IDE terminals often fake Shift-Enter by sending Esc+Enter instead of a
  // native shifted Return key event, which readline exposes as meta+enter.
  return Boolean((key.shift || key.meta) && (key.name === "return" || key.name === "enter"));
}

function shouldReplaceTrailingBackslash(state: ComposerState, sequence: string, key: KeyLike): boolean {
  if (!(key.name === "return" || key.name === "enter" || sequence === "\r")) {
    return false;
  }

  return state.cursor > 0 && state.value[state.cursor - 1] === "\\";
}

export function isPrintableKey(sequence: string, key: KeyLike): boolean {
  if (!sequence || key.ctrl || key.meta) {
    return false;
  }

  return sequence >= " " || sequence === "\n";
}

export function resolveComposerMetaAction(sequence: string, key: KeyLike): ComposerMetaAction | null {
  if (key.meta) {
    if (key.name === "left" || key.name === "b") {
      return "word-left";
    }

    if (key.name === "right" || key.name === "f") {
      return "word-right";
    }

    if (key.name === "backspace") {
      return "delete-word-backward";
    }
  }

  if (META_WORD_LEFT_SEQUENCES.has(sequence)) {
    return "word-left";
  }

  if (META_WORD_RIGHT_SEQUENCES.has(sequence)) {
    return "word-right";
  }

  if (META_BACKSPACE_SEQUENCES.has(sequence)) {
    return "delete-word-backward";
  }

  return null;
}

export function resolveComposerEnterAction(options: {
  state: ComposerState;
  sequence: string;
  key: KeyLike;
  inBracketedPaste: boolean;
}): ComposerEnterAction {
  const { state, sequence, key, inBracketedPaste } = options;

  if (
    inBracketedPaste &&
    (key.name === "return" || key.name === "enter" || sequence === "\r" || sequence === "\n")
  ) {
    return "newline";
  }

  if (shouldReplaceTrailingBackslash(state, sequence, key)) {
    return "replace-backslash";
  }

  if (isShiftEnter(sequence, key) || sequence === "\n") {
    return "newline";
  }

  if (key.name === "return" || sequence === "\r") {
    return "submit";
  }

  return null;
}

export function replaceTrailingBackslashWithNewline(state: ComposerState): ComposerState {
  return {
    value: state.value.slice(0, state.cursor - 1) + "\n" + state.value.slice(state.cursor),
    cursor: state.cursor,
    preferredColumn: null,
  };
}

export function extendedKeysModeSequence(enabled: boolean): string {
  return enabled
    ? ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS
    : DISABLE_MODIFY_OTHER_KEYS + DISABLE_KITTY_KEYBOARD;
}

export function normalizeTerminalKeySequence(options: {
  pendingSequence: string;
  sequence: string | undefined;
  key: KeyLike;
}): { pendingSequence: string; sequence: string | null } {
  const nextSequence = options.sequence || options.key.sequence || "";

  if (!options.pendingSequence) {
    if (isExtendedKeySequence(nextSequence)) {
      return { pendingSequence: "", sequence: nextSequence };
    }

    if (
      (options.key.name === "undefined" && nextSequence.startsWith("\u001b[")) ||
      isExtendedKeySequencePrefix(nextSequence)
    ) {
      return { pendingSequence: nextSequence, sequence: null };
    }

    return { pendingSequence: "", sequence: nextSequence };
  }

  const combinedSequence = options.pendingSequence + nextSequence;
  if (isExtendedKeySequence(combinedSequence)) {
    return { pendingSequence: "", sequence: combinedSequence };
  }

  if (isExtendedKeySequencePrefix(combinedSequence)) {
    return { pendingSequence: combinedSequence, sequence: null };
  }

  return { pendingSequence: "", sequence: combinedSequence };
}
