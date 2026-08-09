import {afterEach, describe, expect, it, vi} from "vitest";

import {LiveVoiceSession} from "../src/integrations/voice/live-voice-session.js";

afterEach(() => vi.useRealTimers());

describe("LiveVoiceSession", () => {
  it("suppresses stale output until the provider confirms the user turn, even if Discord capture lingers", () => {
    const session = new LiveVoiceSession();
    expect(session.acceptOutput(960)).toBe(true);

    session.beginInput();
    expect(session.acceptOutput(960)).toBe(false);
    session.noteTurnDone({role: "user", transcript: "hello"});
    expect(session.acceptOutput(960)).toBe(true);
    session.endInput();

    expect(session.acceptOutput(960)).toBe(true);
    expect(session.getSnapshot()).toMatchObject({phase: "playing", inputEpoch: 1, suppressedOutputChunks: 1, suppressedOutputBytes: 960});
  });

  it("releases output after a bounded fallback when the provider omits user turn completion", async () => {
    vi.useFakeTimers();
    const session = new LiveVoiceSession({outputReleaseTimeoutMs: 50});
    session.beginInput();
    session.endInput();
    expect(session.acceptOutput(960)).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(session.acceptOutput(960)).toBe(true);
  });

  it("keeps bounded completed turns only in transient role-bearing reconnect history", () => {
    const session = new LiveVoiceSession({maxHistoryItems: 2, maxHistoryChars: 20});
    session.noteTurnDone({role: "user", transcript: "  first question  "});
    session.noteTurnDone({role: "assistant", transcript: "first answer"});
    session.noteTurnDone({role: "user", transcript: "second question"});

    expect(session.initialItems()).toEqual([
      {role: "user", text: "second question"},
    ]);
    expect(session.getSnapshot()).toMatchObject({historyItems: 1, historyChars: 15});
  });

  it("closes timers and rejects later media idempotently", () => {
    const session = new LiveVoiceSession();
    session.beginInput();
    session.endInput();
    session.close();
    session.close();
    expect(session.acceptOutput(960)).toBe(false);
    expect(session.getSnapshot()).toMatchObject({phase: "closed", suppressedOutputChunks: 1});
  });
});
