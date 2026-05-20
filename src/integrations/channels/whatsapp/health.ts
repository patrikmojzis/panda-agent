import type {PostgresListenSnapshot} from "../../../lib/postgres-listen.js";

export type WhatsAppSocketHealthState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "stopped";

export interface WhatsAppHealthSnapshot {
  [key: string]: unknown;
  ok: boolean;
  connectorKey: string;
  initialized: boolean;
  lockHeld: boolean;
  listenersActive: boolean;
  listenerStatus: PostgresListenSnapshot["status"] | null;
  listenerLastErrorAt: number | null;
  listenerLastError: string | null;
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
  private listenerSnapshot: PostgresListenSnapshot | null = null;
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
    this.listenerSnapshot = null;
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

  markListenerSnapshot(snapshot: PostgresListenSnapshot): void {
    this.listenerSnapshot = snapshot;
    this.listenersActive = snapshot.listening;
  }

  markSocketState(state: WhatsAppSocketHealthState): void {
    this.socketState = state;
    this.socketStateAt = this.now();
  }

  markStopped(): void {
    this.initialized = false;
    this.lockHeld = false;
    this.listenersActive = false;
    this.listenerSnapshot = this.listenerSnapshot
      ? {
        ...this.listenerSnapshot,
        status: "closed",
        listening: false,
      }
      : null;
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
      listenerStatus: this.listenerSnapshot?.status ?? null,
      listenerLastErrorAt: this.listenerSnapshot?.lastErrorAt ?? null,
      listenerLastError: this.listenerSnapshot?.lastError ?? null,
      socketState: this.socketState,
      socketStateAt: this.socketStateAt || null,
      stopping,
    };
  }
}
