import {describe, expect, it, vi} from "vitest";

import {syncChatStoredThreadState} from "../src/ui/tui/chat-sync.js";
import {resolveStoredThreadDisplayConfig} from "../src/ui/shared/stored-thread.js";

describe("syncChatStoredThreadState", () => {
  it("applies the stored snapshot during background sync without daemon config", async () => {
    const thread = {
      id: "thread-sync",
      sessionId: "session-sync",
      createdAt: 1,
      updatedAt: 2,
    };
    const session = {
      id: "session-sync",
      agentKey: "panda",
      kind: "main" as const,
      currentThreadId: "thread-sync",
      createdAt: 1,
      updatedAt: 2,
    };
    const applyLoadedSnapshot = vi.fn();
    const requestRender = vi.fn();
    const services = {
      store: {
        getThread: vi.fn(async () => thread),
        listTranscriptPage: vi.fn(async () => ({records: []})),
        getLatestRun: vi.fn(async () => null),
      },
      getSession: vi.fn(async () => session),
    };
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
      getLastStoredSequence: () => 0,
      applyLoadedSnapshot,
      requestRender,
      isClosed: () => false,
      isSessionPickerActive: () => false,
      refreshSessionPicker: vi.fn(async () => {}),
    }, true);

    expect(applyLoadedSnapshot).toHaveBeenCalledWith(
      thread,
      session,
      [],
      null,
      resolveStoredThreadDisplayConfig(),
    );
    expect(services.store.listTranscriptPage).toHaveBeenCalledWith("thread-sync", {
      afterSequence: 0,
      limit: 500,
    });
    expect(requestRender).toHaveBeenCalledOnce();
  });
});
