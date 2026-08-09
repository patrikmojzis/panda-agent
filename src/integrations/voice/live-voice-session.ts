export type LiveVoiceTranscriptRole = "user" | "assistant";

export interface LiveVoiceHistoryItem {
  role: LiveVoiceTranscriptRole;
  text: string;
}

export type LiveVoicePhase = "listening" | "receiving_user" | "awaiting_output" | "playing" | "closed";

export interface LiveVoiceSessionSnapshot {
  phase: LiveVoicePhase;
  inputEpoch: number;
  captureActive: boolean;
  awaitingUserTurn: boolean;
  historyItems: number;
  historyChars: number;
  suppressedOutputChunks: number;
  suppressedOutputBytes: number;
}

export interface LiveVoiceSessionOptions {
  outputReleaseTimeoutMs?: number;
  maxHistoryItems?: number;
  maxHistoryChars?: number;
  onStateChange?(): void;
}

const DEFAULT_OUTPUT_RELEASE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_HISTORY_ITEMS = 12;
const DEFAULT_MAX_HISTORY_CHARS = 12_000;

/** Owns channel-neutral live turn arbitration and transient reconnect context. */
export class LiveVoiceSession {
  private phase: LiveVoicePhase = "listening";
  private inputEpoch = 0;
  private captureActive = false;
  private awaitingUserTurn = false;
  private readonly history: LiveVoiceHistoryItem[] = [];
  private historyChars = 0;
  private releaseTimer?: NodeJS.Timeout;
  private suppressedOutputChunks = 0;
  private suppressedOutputBytes = 0;

  constructor(private readonly options: LiveVoiceSessionOptions = {}) {}

  beginInput(): void {
    if (this.phase === "closed") return;
    this.clearReleaseTimer();
    this.inputEpoch += 1;
    this.captureActive = true;
    this.awaitingUserTurn = true;
    this.phase = "receiving_user";
    this.changed();
  }

  endInput(): void {
    if (this.phase === "closed" || !this.captureActive) return;
    this.captureActive = false;
    this.phase = "awaiting_output";
    if (this.awaitingUserTurn) this.scheduleOutputRelease();
    this.changed();
  }

  noteTurnDone(input: {role: "user" | "assistant" | "unknown"; transcript?: string}): void {
    if (this.phase === "closed") return;
    if (input.role === "user" || input.role === "assistant") this.remember(input.role, input.transcript);
    if (input.role === "user") {
      this.awaitingUserTurn = false;
      this.clearReleaseTimer();
      this.phase = "awaiting_output";
    }
    this.changed();
  }

  acceptOutput(byteLength: number): boolean {
    if (this.phase === "closed" || this.awaitingUserTurn) {
      this.suppressedOutputChunks += 1;
      this.suppressedOutputBytes += Math.max(0, byteLength);
      this.changed();
      return false;
    }
    this.phase = "playing";
    this.changed();
    return true;
  }

  outputIdle(): void {
    if (this.phase === "closed" || this.awaitingUserTurn) return;
    this.phase = this.captureActive ? "awaiting_output" : "listening";
    this.changed();
  }

  initialItems(): LiveVoiceHistoryItem[] {
    return this.history.map((item) => ({...item}));
  }

  getSnapshot(): LiveVoiceSessionSnapshot {
    return {
      phase: this.phase,
      inputEpoch: this.inputEpoch,
      captureActive: this.captureActive,
      awaitingUserTurn: this.awaitingUserTurn,
      historyItems: this.history.length,
      historyChars: this.historyChars,
      suppressedOutputChunks: this.suppressedOutputChunks,
      suppressedOutputBytes: this.suppressedOutputBytes,
    };
  }

  close(): void {
    if (this.phase === "closed") return;
    this.clearReleaseTimer();
    this.captureActive = false;
    this.awaitingUserTurn = false;
    this.phase = "closed";
    this.changed();
  }

  private remember(role: LiveVoiceTranscriptRole, transcript: string | undefined): void {
    const text = transcript?.trim();
    if (!text) return;
    const maxChars = Math.max(1, this.options.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS);
    const bounded = text.slice(0, maxChars);
    this.history.push({role, text: bounded});
    this.historyChars += bounded.length;
    const maxItems = Math.max(1, this.options.maxHistoryItems ?? DEFAULT_MAX_HISTORY_ITEMS);
    while (this.history.length > maxItems || this.historyChars > maxChars) {
      const removed = this.history.shift();
      if (!removed) break;
      this.historyChars -= removed.text.length;
    }
  }

  private scheduleOutputRelease(): void {
    this.clearReleaseTimer();
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      if (this.phase === "closed" || this.captureActive || !this.awaitingUserTurn) return;
      this.awaitingUserTurn = false;
      this.phase = "awaiting_output";
      this.changed();
    }, this.options.outputReleaseTimeoutMs ?? DEFAULT_OUTPUT_RELEASE_TIMEOUT_MS);
    this.releaseTimer.unref?.();
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
  }

  private changed(): void { this.options.onStateChange?.(); }
}
