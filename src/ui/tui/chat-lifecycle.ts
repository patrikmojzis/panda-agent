import readline from "node:readline";

import type {RunPhase} from "./chat-shared.js";
import {BRACKETED_PASTE_OFF, BRACKETED_PASTE_ON} from "./chat-shared.js";
import {ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR_SCREEN, HIDE_CURSOR, SHOW_CURSOR,} from "./screen.js";
import {extendedKeysModeSequence, type KeyLike} from "./input.js";
import type {NoticeState} from "./chat-view.js";
import type {ChatRuntimeServices} from "./runtime.js";

interface ChatTerminalInput {
  pause(): void;
  resume(): void;
  on(event: "keypress", listener: (sequence: string | undefined, key: KeyLike) => void): void;
  off(event: "keypress", listener: (sequence: string | undefined, key: KeyLike) => void): void;
  setRawMode?(enabled: boolean): void;
}

interface ChatTerminalOutput {
  write(chunk: string): boolean;
  on(event: "resize", listener: () => void): void;
  off(event: "resize", listener: () => void): void;
}

export interface ChatRenderTickerHost {
  isClosed(): boolean;
  isDirty(): boolean;
  getNotice(): NoticeState | null;
  getLastSpinnerFrame(): number;
  spinnerFrameIndex(): number;
  render(): void;
}

export interface ChatCloseAfterRunHost {
  shouldCloseAfterRun(): boolean;
  isClosed(): boolean;
  isRunning(): boolean;
  isWaitingForCloseAfterRun(): boolean;
  setWaitingForCloseAfterRun(enabled: boolean): void;
  getServices(): ChatRuntimeServices | null;
  getCurrentThreadId(): string;
  close(): void;
}

export interface ChatCleanupHost {
  getTicker(): NodeJS.Timeout | null;
  setTicker(timer: NodeJS.Timeout | null): void;
  getSyncDebounceTimer(): NodeJS.Timeout | null;
  setSyncDebounceTimer(timer: NodeJS.Timeout | null): void;
  getRunPhase(): RunPhase;
  getCurrentThreadId(): string;
  getServices(): ChatRuntimeServices | null;
}

function setChatBracketedPasteMode(output: ChatTerminalOutput, enabled: boolean): void {
  output.write(enabled ? BRACKETED_PASTE_ON : BRACKETED_PASTE_OFF);
}

function setChatExtendedKeysMode(output: ChatTerminalOutput, enabled: boolean): void {
  output.write(extendedKeysModeSequence(enabled));
}

export function attachChatTerminal(input: {
  input: ChatTerminalInput;
  output: ChatTerminalOutput;
  keypressHandler: (sequence: string | undefined, key: KeyLike) => void;
  resizeHandler: () => void;
}): void {
  readline.emitKeypressEvents(input.input as NodeJS.ReadableStream);
  input.input.setRawMode?.(true);
  input.input.resume();
  input.input.on("keypress", input.keypressHandler);
  input.output.on("resize", input.resizeHandler);
  input.output.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR_SCREEN);
  setChatBracketedPasteMode(input.output, true);
  setChatExtendedKeysMode(input.output, true);
}

export async function cleanupChatTerminal(input: {
  input: ChatTerminalInput;
  output: ChatTerminalOutput;
  keypressHandler: (sequence: string | undefined, key: KeyLike) => void;
  resizeHandler: () => void;
  host: ChatCleanupHost;
}): Promise<void> {
  const ticker = input.host.getTicker();
  if (ticker) {
    clearInterval(ticker);
    input.host.setTicker(null);
  }

  const syncDebounceTimer = input.host.getSyncDebounceTimer();
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    input.host.setSyncDebounceTimer(null);
  }

  setChatBracketedPasteMode(input.output, false);
  setChatExtendedKeysMode(input.output, false);
  input.input.off("keypress", input.keypressHandler);
  input.input.pause();
  input.output.off("resize", input.resizeHandler);
  input.input.setRawMode?.(false);

  const services = input.host.getServices();
  const threadId = input.host.getCurrentThreadId();
  if (input.host.getRunPhase() === "thinking" && threadId) {
    try {
      if (await services?.abortThread(threadId, "TUI closed.")) {
        await services?.waitForCurrentRun(threadId);
      }
    } catch {
      // Closing the TUI should still continue even if abort/wait cleanup fails.
    }
  }

  input.output.write(HIDE_CURSOR + CLEAR_SCREEN + SHOW_CURSOR + ALT_SCREEN_OFF);
  await services?.close();
}

export function startChatRenderTicker(
  host: ChatRenderTickerHost,
  tickMs: number,
): NodeJS.Timeout {
  return setInterval(() => {
    if (host.isClosed()) {
      return;
    }

    const nextSpinnerFrame = host.spinnerFrameIndex();
    const notice = host.getNotice();
    const noticeExpired = Boolean(notice && notice.expiresAt <= Date.now());
    if (host.isDirty() || noticeExpired || nextSpinnerFrame !== host.getLastSpinnerFrame()) {
      host.render();
    }
  }, tickMs);
}

// Shutdown waiting is shell behavior, not chat logic.
export function scheduleChatCloseAfterRun(host: ChatCloseAfterRunHost): void {
  if (
    !host.shouldCloseAfterRun() ||
    host.isClosed() ||
    host.isRunning() ||
    host.isWaitingForCloseAfterRun()
  ) {
    return;
  }

  const services = host.getServices();
  const threadId = host.getCurrentThreadId();
  host.setWaitingForCloseAfterRun(true);

  setTimeout(() => {
    if (!host.shouldCloseAfterRun() || host.isClosed()) {
      host.setWaitingForCloseAfterRun(false);
      return;
    }

    if (!services) {
      host.setWaitingForCloseAfterRun(false);
      host.close();
      return;
    }

    void services.waitForCurrentRun(threadId)
      .catch(() => {
        // Ignore shutdown races and fall through to closing the TUI.
      })
      .finally(() => {
        host.setWaitingForCloseAfterRun(false);

        if (host.shouldCloseAfterRun() && !host.isClosed()) {
          host.close();
        }
      });
  }, 0);
}
