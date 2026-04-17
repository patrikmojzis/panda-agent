import {describe, expect, it, vi} from "vitest";

import {syncChatStoredThreadState} from "../src/ui/tui/chat-sync.js";
import type {ChatRuntimeServices} from "../src/ui/tui/runtime.js";

describe("syncChatStoredThreadState", () => {
  it("applies the stored snapshot during background sync without daemon config", async () => {
    const thread = {
      id: "thread-sync",
      sessionId: "session-sync",
      createdAt: 1,
      updatedAt: 2,
    };
    const applyLoadedSnapshot = vi.fn();
    const requestRender = vi.fn();
    const services = {
      store: {
        getThread: vi.fn(async () => thread),
        loadTranscript: vi.fn(async () => []),
        listRuns: vi.fn(async () => []),
      },
    } as unknown as ChatRuntimeServices;
    let syncInFlight = false;
    let lastStoredSyncAt = 0;

    await syncChatStoredThreadState({
      getCurrentThreadId: () => "thread-sync",
      getServices: () => services,
      getSyncDebounceTimer: () => null,
      setSyncDebounceTimer: vi.fn(),
      getSyncInFlight: () => syncInFlight,
      setSyncInFlight: (enabled) => {
        syncInFlight = enabled;
      },
      getSyncRequestedWhileBusy: () => false,
      setSyncRequestedWhileBusy: vi.fn(),
      getLastStoredSyncAt: () => lastStoredSyncAt,
      setLastStoredSyncAt: (value) => {
        lastStoredSyncAt = value;
      },
      applyLoadedSnapshot,
      requestRender,
      isClosed: () => false,
      isSessionPickerActive: () => false,
      refreshSessionPicker: vi.fn(async () => {}),
    }, true);

    expect(applyLoadedSnapshot).toHaveBeenCalledWith(thread, [], []);
    expect(requestRender).toHaveBeenCalledOnce();
  });
});
