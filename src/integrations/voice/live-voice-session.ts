export type LiveVoiceTranscriptRole = "user" | "assistant";

export interface LiveVoiceHistoryItem {
  role: LiveVoiceTranscriptRole;
  text: string;
}

export type LiveVoicePhase = "listening" | "receiving_user" | "playing" | "closed";

export interface LiveVoiceSessionSnapshot {
  phase: LiveVoicePhase;
  inputEpoch: number;
  captureActive: boolean;
  historyItems: number;
  historyChars: number;
}

export interface LiveVoiceSessionOptions {
  maxHistoryItems?: number;
  maxHistoryChars?: number;
  onStateChange?(): void;
}

const DEFAULT_MAX_HISTORY_ITEMS = 12;
const DEFAULT_MAX_HISTORY_CHARS = 12_000;

/** Owns channel-neutral live turn arbitration and transient reconnect context. */
export class LiveVoiceSession {
  private inputEpoch = 0;
  private captureActive = false;
  private outputActive = false;
  private closed = false;
  private readonly history: LiveVoiceHistoryItem[] = [];
  private historyChars = 0;

  constructor(private readonly options: LiveVoiceSessionOptions = {}) {}

  beginInput(): void {
    if (this.closed) return;
    this.inputEpoch += 1;
    this.captureActive = true;
    this.changed();
  }

  endInput(): void {
    if (this.closed || !this.captureActive) return;
    this.captureActive = false;
    this.changed();
  }

  /** Mirrors the provider-owned output clear without inferring speech locally. */
  noteOutputAudioCleared(): boolean {
    if (this.closed) return false;
    const hadOutput = this.outputActive;
    this.outputActive = false;
    this.changed();
    return hadOutput;
  }

  noteTurnDone(input: {role: "user" | "assistant" | "unknown"; transcript?: string}): void {
    if (this.closed) return;
    if (input.role === "user" || input.role === "assistant") this.remember(input.role, input.transcript);
    this.changed();
  }

  acceptOutput(): boolean {
    if (this.closed) return false;
    this.outputActive = true;
    this.changed();
    return true;
  }

  outputIdle(): void {
    if (this.closed) return;
    this.outputActive = false;
    this.changed();
  }

  initialItems(): LiveVoiceHistoryItem[] {
    return this.history.map((item) => ({...item}));
  }

  getSnapshot(): LiveVoiceSessionSnapshot {
    return {
      phase: this.phase(),
      inputEpoch: this.inputEpoch,
      captureActive: this.captureActive,
      historyItems: this.history.length,
      historyChars: this.historyChars,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.captureActive = false;
    this.outputActive = false;
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

  private phase(): LiveVoicePhase {
    if (this.closed) return "closed";
    if (this.captureActive) return "receiving_user";
    if (this.outputActive) return "playing";
    return "listening";
  }

  private changed(): void { this.options.onStateChange?.(); }
}
