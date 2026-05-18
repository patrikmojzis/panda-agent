export type WhatsAppSocketHealthState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "stopped";

export interface WhatsAppHealthSnapshot {
  [key: string]: unknown;
  ok: boolean;
  connectorKey: string;
  initialized: boolean;
  lockHeld: boolean;
  listenersActive: boolean;
  socketState: WhatsAppSocketHealthState;
  socketStateAt: number | null;
  stopping: boolean;
}

export interface WhatsAppHealthStateOptions {
  connectorKey: string;
  reconnectGraceMs?: number;
  now?: () => number;
}

const DEFAULT_RECONNECT_GRACE_MS = 30_000;

export class WhatsAppHealthState {
  private readonly connectorKey: string;
  private readonly reconnectGraceMs: number;
  private readonly now: () => number;
  private initialized = false;
  private lockHeld = false;
  private listenersActive = false;
  private socketState: WhatsAppSocketHealthState = "idle";
  private socketStateAt = 0;

  constructor(options: WhatsAppHealthStateOptions) {
    this.connectorKey = options.connectorKey;
    this.reconnectGraceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  resetForRun(): void {
    this.initialized = false;
    this.lockHeld = false;
    this.listenersActive = false;
    this.markSocketState("idle");
  }

  markInitialized(value: boolean): void {
    this.initialized = value;
  }

  markLockHeld(value: boolean): void {
    this.lockHeld = value;
  }

  markListenersActive(value: boolean): void {
    this.listenersActive = value;
  }

  markSocketState(state: WhatsAppSocketHealthState): void {
    this.socketState = state;
    this.socketStateAt = this.now();
  }

  markStopped(): void {
    this.initialized = false;
    this.lockHeld = false;
    this.listenersActive = false;
    this.markSocketState("stopped");
  }

  snapshot(stopping: boolean): WhatsAppHealthSnapshot {
    const socketHealthy = this.socketState === "open"
      || (
        this.socketState === "reconnecting"
        && (this.now() - this.socketStateAt) <= this.reconnectGraceMs
      );

    return {
      ok: this.initialized
        && this.lockHeld
        && this.listenersActive
        && socketHealthy
        && !stopping,
      connectorKey: this.connectorKey,
      initialized: this.initialized,
      lockHeld: this.lockHeld,
      listenersActive: this.listenersActive,
      socketState: this.socketState,
      socketStateAt: this.socketStateAt || null,
      stopping,
    };
  }
}
