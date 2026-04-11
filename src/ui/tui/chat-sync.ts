import type {ThreadMessageRecord, ThreadRecord, ThreadRunRecord,} from "../../domain/threads/runtime/index.js";
import {STORED_SYNC_MS} from "./chat-shared.js";
import {loadChatThreadSnapshot} from "./chat-session.js";
import type {ChatRuntimeServices} from "./runtime.js";

export interface ChatSyncHost {
  getCurrentThreadId(): string;
  getServices(): ChatRuntimeServices | null;
  getSyncDebounceTimer(): NodeJS.Timeout | null;
  setSyncDebounceTimer(timer: NodeJS.Timeout | null): void;
  getSyncInFlight(): boolean;
  setSyncInFlight(enabled: boolean): void;
  getSyncRequestedWhileBusy(): boolean;
  setSyncRequestedWhileBusy(enabled: boolean): void;
  getLastStoredSyncAt(): number;
  setLastStoredSyncAt(value: number): void;
  applyLoadedSnapshot(
    thread: ThreadRecord,
    transcript: readonly ThreadMessageRecord[],
    runs: readonly ThreadRunRecord[],
  ): void;
  requestRender(): void;
  isClosed(): boolean;
  isThreadPickerActive(): boolean;
  refreshThreadPicker(): Promise<void>;
}

export function scheduleChatStoredThreadSync(host: ChatSyncHost, delayMs = 150): void {
  if (!host.getCurrentThreadId() || !host.getServices()) {
    return;
  }

  const existingTimer = host.getSyncDebounceTimer();
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  host.setSyncDebounceTimer(setTimeout(() => {
    host.setSyncDebounceTimer(null);
    void syncChatStoredThreadState(host, true);
  }, delayMs));
}

export async function syncChatStoredThreadState(
  host: ChatSyncHost,
  force = false,
): Promise<void> {
  const threadId = host.getCurrentThreadId();
  const services = host.getServices();
  if (!threadId || !services) {
    return;
  }

  if (host.getSyncInFlight()) {
    if (force) {
      host.setSyncRequestedWhileBusy(true);
    }
    return;
  }

  const now = Date.now();
  if (!force && now - host.getLastStoredSyncAt() < STORED_SYNC_MS) {
    return;
  }

  if (force) {
    const debounceTimer = host.getSyncDebounceTimer();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      host.setSyncDebounceTimer(null);
    }
  }

  host.setSyncInFlight(true);
  host.setLastStoredSyncAt(Date.now());

  try {
    const snapshot = await loadChatThreadSnapshot({
      services,
      threadId,
    });

    if (threadId !== host.getCurrentThreadId()) {
      return;
    }

    host.applyLoadedSnapshot(snapshot.thread, snapshot.transcript, snapshot.runs);
    host.requestRender();
  } catch {
    // Ignore background sync failures here. Foreground actions surface their own errors.
  } finally {
    host.setSyncInFlight(false);
    if (host.getSyncRequestedWhileBusy()) {
      host.setSyncRequestedWhileBusy(false);
      queueMicrotask(() => {
        void syncChatStoredThreadState(host, true);
      });
    }
  }
}

export async function handleChatStoreNotification(
  host: ChatSyncHost,
  threadId: string,
): Promise<void> {
  if (host.isClosed()) {
    return;
  }

  if (threadId === host.getCurrentThreadId()) {
    scheduleChatStoredThreadSync(host);
  }

  if (host.isThreadPickerActive()) {
    await host.refreshThreadPicker();
    host.requestRender();
  }
}
