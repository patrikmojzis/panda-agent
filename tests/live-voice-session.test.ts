import {describe, expect, it} from "vitest";

import {LiveVoiceSession} from "../src/integrations/voice/live-voice-session.js";

describe("LiveVoiceSession", () => {
  it("does not infer an interruption from local capture", () => {
    const session = new LiveVoiceSession();
    expect(session.acceptOutput()).toBe(true);

    session.beginInput();
    expect(session.acceptOutput()).toBe(true);
    session.endInput();

    expect(session.getSnapshot()).toMatchObject({phase: "playing", inputEpoch: 1, captureActive: false});
  });

  it("mirrors a provider-owned output clear without blocking replacement media", () => {
    const session = new LiveVoiceSession();
    expect(session.acceptOutput()).toBe(true);
    session.noteOutputAudioCleared();
    expect(session.getSnapshot().phase).toBe("listening");
    expect(session.acceptOutput()).toBe(true);
    expect(session.getSnapshot().phase).toBe("playing");
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
    expect(session.acceptOutput()).toBe(false);
    expect(session.getSnapshot()).toMatchObject({phase: "closed"});
  });
});
