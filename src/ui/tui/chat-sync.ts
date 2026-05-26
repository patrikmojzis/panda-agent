import type {SessionRecord} from "../../domain/sessions/types.js";
import type {InferenceProjection, ThreadMessageRecord, ThreadRecord, ThreadRunRecord} from "../../domain/threads/runtime/types.js";
import {loadStoredThreadSnapshot, resolveStoredThreadDisplayConfig} from "../shared/stored-thread.js";
import type {ThinkingLevel} from "@mariozechner/pi-ai";
import {STORED_SYNC_MS} from "./chat-shared.js";
import type {ChatRuntimeThreadStore} from "./runtime.js";

interface ChatSyncServices {
  store: ChatRuntimeThreadStore;
  getSession(sessionId: string): Promise<SessionRecord>;
  resolveThreadRunConfig?(threadId: string): Promise<{
    model: string;
    thinking?: ThinkingLevel;
    inferenceProjection?: InferenceProjection;
  }>;
}

export interface ChatSyncHost {
  getCurrentThreadId(): string;
  getServices(): ChatSyncServices | null;
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
    session: SessionRecord,
    transcript: readonly ThreadMessageRecord[],
    runs: readonly ThreadRunRecord[],
    displayConfig: {model: string; thinking?: ThinkingLevel},
  ): void;
  requestRender(): void;
  isClosed(): boolean;
  isSessionPickerActive(): boolean;
  refreshSessionPicker(): Promise<void>;
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
    const snapshot = await loadStoredThreadSnapshot({
      store: services.store,
      threadId,
    });

    if (threadId !== host.getCurrentThreadId()) {
      return;
    }

    const [session, displayConfig] = await Promise.all([
      services.getSession(snapshot.thread.sessionId),
      services.resolveThreadRunConfig
        ? services.resolveThreadRunConfig(snapshot.thread.id).catch(() => resolveStoredThreadDisplayConfig())
        : Promise.resolve(resolveStoredThreadDisplayConfig()),
    ]);
    host.applyLoadedSnapshot(snapshot.thread, session, snapshot.transcript, snapshot.runs, displayConfig);
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

  if (host.isSessionPickerActive()) {
    await host.refreshSessionPicker();
    host.requestRender();
  }
}
