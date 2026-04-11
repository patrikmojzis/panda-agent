import {
    backspace,
    type ComposerState,
    deleteForward,
    deleteWordBackward,
    insertText,
    moveCursorDown,
    moveCursorLeft,
    moveCursorLineEnd,
    moveCursorLineStart,
    moveCursorRight,
    moveCursorUp,
    moveCursorWordLeft,
    moveCursorWordRight,
} from "./composer.js";
import type {SlashCompletionContext} from "./commands.js";
import {
    isPrintableKey,
    type KeyLike,
    replaceTrailingBackslashWithNewline,
    resolveComposerEnterAction,
    resolveComposerMetaAction,
} from "./input.js";
import type {ChatRuntimeServices} from "./runtime.js";
import type {SearchState} from "./chat-shared.js";
import {type NoticeState, type ViewModel} from "./chat-view.js";

type NoticeTone = NoticeState["tone"];

export interface ChatPasteBoundaryHost {
  setInBracketedPaste(enabled: boolean): void;
}

export interface ChatInterruptHost {
  isRunning(): boolean;
  shouldCloseAfterRun(): boolean;
  setCloseAfterRun(enabled: boolean): void;
  getCurrentThreadId(): string;
  requireServices(): ChatRuntimeServices;
  close(): void;
  setNotice(text: string, tone: NoticeTone, durationMs?: number): void;
}

export interface ChatTranscriptNavigationHost {
  buildView(): ViewModel;
  scrollTranscript(delta: number): void;
}

export interface ChatThreadPickerKeypressHost {
  closeThreadPicker(): void;
  selectThreadPickerEntry(): Promise<void>;
  cycleThreadPicker(delta: number): void;
}

export interface ChatTranscriptSearchKeypressHost {
  transcriptSearch: SearchState;
  clearTranscriptSearch(): void;
  cycleTranscriptMatch(delta: number): void;
  buildView(): ViewModel;
  ensureSelectedTranscriptMatchVisible(view: ViewModel): void;
}

export interface ChatHistorySearchKeypressHost {
  historySearch: SearchState;
  currentHistoryMatch(): string | null;
  setComposerValue(value: string): void;
  cycleHistoryMatch(delta: number): void;
  setNotice(text: string, tone: NoticeTone, durationMs?: number): void;
}

export interface ChatModalKeypressHost {
  isThreadPickerActive(): boolean;
  isHistorySearchActive(): boolean;
  isTranscriptSearchActive(): boolean;
  handleThreadPickerKeypress(sequence: string, key: KeyLike): Promise<void>;
  startHistorySearch(): void;
  startTranscriptSearch(): void;
  handleTranscriptSearchKeypress(sequence: string, key: KeyLike): void;
  handleHistorySearchKeypress(sequence: string, key: KeyLike): void;
}

export interface ChatComposerKeypressHost {
  composer: ComposerState;
  isInBracketedPaste(): boolean;
  setComposerState(next: ComposerState): void;
  submitComposer(): Promise<void>;
  hasNotice(): boolean;
  clearNotice(): void;
  hasTranscriptSearchQuery(): boolean;
  clearTranscriptSearch(): void;
  followTranscript(): boolean;
  jumpTranscriptToBottom(): void;
  currentSlashContext(): SlashCompletionContext | null;
  getSlashCompletionIndex(): number;
  setSlashCompletionIndex(index: number): void;
}

export function handleChatPasteBoundaryKeypress(
  host: ChatPasteBoundaryHost,
  key: KeyLike,
): boolean {
  if (key.name === "paste-start") {
    host.setInBracketedPaste(true);
    return true;
  }

  if (key.name === "paste-end") {
    host.setInBracketedPaste(false);
    return true;
  }

  return false;
}

export async function handleChatInterruptKeypress(
  host: ChatInterruptHost,
  key: KeyLike,
): Promise<boolean> {
  if (!(key.ctrl && key.name === "c")) {
    return false;
  }

  if (!host.isRunning()) {
    host.close();
    return true;
  }

  if (host.shouldCloseAfterRun()) {
    host.setNotice("Stopping the active run and closing Panda...", "info");
    return true;
  }

  if (await host.requireServices().abortThread(host.getCurrentThreadId(), "Aborted from Ctrl-C.")) {
    host.setCloseAfterRun(true);
    host.setNotice("Stopping the active run and closing Panda...", "info");
    return true;
  }

  host.close();
  return true;
}

export function handleChatTranscriptNavigationKeypress(
  host: ChatTranscriptNavigationHost,
  key: KeyLike,
): boolean {
  if (key.name === "pageup" || key.name === "pagedown") {
    const delta = Math.max(1, host.buildView().transcriptHeight - 2);
    host.scrollTranscript(key.name === "pageup" ? -delta : delta);
    return true;
  }

  if (key.meta && key.name === "up") {
    host.scrollTranscript(-1);
    return true;
  }

  if (key.meta && key.name === "down") {
    host.scrollTranscript(1);
    return true;
  }

  return false;
}

export async function handleChatModalKeypress(
  host: ChatModalKeypressHost,
  sequence: string,
  key: KeyLike,
): Promise<boolean> {
  if (host.isThreadPickerActive()) {
    await host.handleThreadPickerKeypress(sequence, key);
    return true;
  }

  if (!host.isHistorySearchActive() && !host.isTranscriptSearchActive() && key.ctrl && key.name === "r") {
    host.startHistorySearch();
    return true;
  }

  if (!host.isHistorySearchActive() && !host.isTranscriptSearchActive() && key.ctrl && key.name === "f") {
    host.startTranscriptSearch();
    return true;
  }

  if (host.isTranscriptSearchActive()) {
    host.handleTranscriptSearchKeypress(sequence, key);
    return true;
  }

  if (host.isHistorySearchActive()) {
    host.handleHistorySearchKeypress(sequence, key);
    return true;
  }

  return false;
}

export async function handleChatThreadPickerKeypress(
  host: ChatThreadPickerKeypressHost,
  sequence: string,
  key: KeyLike,
): Promise<void> {
  if (key.name === "escape") {
    host.closeThreadPicker();
    return;
  }

  if (key.name === "return" || sequence === "\r") {
    await host.selectThreadPickerEntry();
    return;
  }

  if (key.name === "up") {
    host.cycleThreadPicker(-1);
    return;
  }

  if (key.name === "down") {
    host.cycleThreadPicker(1);
  }
}

export function handleChatTranscriptSearchKeypress(
  host: ChatTranscriptSearchKeypressHost,
  sequence: string,
  key: KeyLike,
): void {
  if (key.name === "escape") {
    host.transcriptSearch.active = false;
    return;
  }

  if (key.name === "return" || sequence === "\r") {
    host.transcriptSearch.active = false;
    return;
  }

  if (key.name === "up") {
    host.cycleTranscriptMatch(-1);
    return;
  }

  if (key.name === "down") {
    host.cycleTranscriptMatch(1);
    return;
  }

  if (key.name === "backspace") {
    host.transcriptSearch.query = host.transcriptSearch.query.slice(0, -1);
    host.transcriptSearch.selected = 0;
    host.ensureSelectedTranscriptMatchVisible(host.buildView());
    return;
  }

  if (isPrintableKey(sequence, key) && sequence !== "\n") {
    host.transcriptSearch.query += sequence;
    host.transcriptSearch.selected = 0;
    host.ensureSelectedTranscriptMatchVisible(host.buildView());
  }
}

export function handleChatHistorySearchKeypress(
  host: ChatHistorySearchKeypressHost,
  sequence: string,
  key: KeyLike,
): void {
  if (key.name === "escape") {
    host.historySearch.active = false;
    return;
  }

  if (key.name === "return" || sequence === "\r") {
    const match = host.currentHistoryMatch();
    if (match) {
      host.setComposerValue(match);
    } else {
      host.setNotice("No history match to load.", "info");
    }
    host.historySearch.active = false;
    return;
  }

  if ((key.ctrl && key.name === "r") || key.name === "up") {
    host.cycleHistoryMatch(1);
    return;
  }

  if (key.name === "down") {
    host.cycleHistoryMatch(-1);
    return;
  }

  if (key.name === "backspace") {
    host.historySearch.query = host.historySearch.query.slice(0, -1);
    host.historySearch.selected = 0;
    return;
  }

  if (isPrintableKey(sequence, key) && sequence !== "\n") {
    host.historySearch.query += sequence;
    host.historySearch.selected = 0;
  }
}

// Keep key-routing out of chat.ts so that file can stay focused on state and lifecycle.
export async function handleChatComposerKeypress(
  host: ChatComposerKeypressHost,
  sequence: string,
  key: KeyLike,
): Promise<void> {
  const enterAction = resolveComposerEnterAction({
    state: host.composer,
    sequence,
    key,
    inBracketedPaste: host.isInBracketedPaste(),
  });
  if (enterAction === "newline") {
    host.setComposerState(insertText(host.composer, "\n"));
    return;
  }

  if (enterAction === "replace-backslash") {
    host.setComposerState(replaceTrailingBackslashWithNewline(host.composer));
    return;
  }

  if (enterAction === "submit") {
    await host.submitComposer();
    return;
  }

  const metaAction = resolveComposerMetaAction(sequence, key);
  if (metaAction === "word-left") {
    host.setComposerState(moveCursorWordLeft(host.composer));
    return;
  }

  if (metaAction === "word-right") {
    host.setComposerState(moveCursorWordRight(host.composer));
    return;
  }

  if (metaAction === "delete-word-backward") {
    host.setComposerState(deleteWordBackward(host.composer));
    return;
  }

  if (key.name === "escape") {
    if (host.hasNotice()) {
      host.clearNotice();
      return;
    }

    if (host.hasTranscriptSearchQuery()) {
      host.clearTranscriptSearch();
      return;
    }

    if (!host.followTranscript()) {
      host.jumpTranscriptToBottom();
    }
    return;
  }

  if (key.name === "tab") {
    const context = host.currentSlashContext();
    if (context && context.matches.length > 0) {
      const direction = key.shift ? -1 : 1;
      host.setSlashCompletionIndex(
        (host.getSlashCompletionIndex() + direction + context.matches.length) % context.matches.length,
      );
    }
    return;
  }

  if (key.name === "backspace") {
    host.setComposerState(backspace(host.composer));
    return;
  }

  if (key.name === "delete") {
    host.setComposerState(deleteForward(host.composer));
    return;
  }

  if (key.name === "left") {
    host.setComposerState(moveCursorLeft(host.composer));
    return;
  }

  if (key.name === "right") {
    host.setComposerState(moveCursorRight(host.composer));
    return;
  }

  if (key.name === "up") {
    host.setComposerState(moveCursorUp(host.composer));
    return;
  }

  if (key.name === "down") {
    host.setComposerState(moveCursorDown(host.composer));
    return;
  }

  if (key.name === "home" || (key.ctrl && key.name === "a")) {
    host.setComposerState(moveCursorLineStart(host.composer));
    return;
  }

  if (key.name === "end" || (key.ctrl && key.name === "e")) {
    host.setComposerState(moveCursorLineEnd(host.composer));
    return;
  }

  if (isPrintableKey(sequence, key)) {
    host.setComposerState(insertText(host.composer, sequence));
  }
}
