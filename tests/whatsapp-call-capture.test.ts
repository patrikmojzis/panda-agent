import {afterEach, describe, expect, it, vi} from "vitest";

import {WhatsAppCallCapture} from "../src/integrations/channels/whatsapp/calls/capture.js";
import type {LiveVoiceCall} from "../src/integrations/voice/live-call.js";

describe("WhatsAppCallCapture", () => {
  afterEach(() => vi.useRealTimers());

  it("ends after 500 ms without audible speech even while RTP silence continues", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const beginCapture = vi.fn(() => ({status: "accepted" as const, captureId: "capture-1"}));
    const pushAudio = vi.fn(() => true);
    const endCapture = vi.fn();
    const call = {beginCapture, pushAudio, endCapture} as unknown as LiveVoiceCall;
    const transportAuthorization = {identityId: "identity-1", agentKey: "panda", actorBindingId: "11111111-1111-4111-8111-111111111111", authorizationVersion: "a".repeat(64)};
    const capture = new WhatsAppCallCapture({actorId: "caller", identityId: "identity-1", transportAuthorization, getCall: () => call});
    const audible = Buffer.alloc(960);
    for (let offset = 0; offset < audible.length; offset += 2) audible.writeInt16LE(2_000, offset);
    const silence = Buffer.alloc(960);

    capture.push(audible, Date.now());
    for (let index = 0; index < 4; index += 1) {
      vi.advanceTimersByTime(100);
      capture.push(silence, Date.now());
    }
    expect(endCapture).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);

    expect(beginCapture).toHaveBeenCalledWith("caller", 1_000, "identity-1", null, transportAuthorization);
    expect(pushAudio).toHaveBeenCalledTimes(5);
    expect(endCapture).toHaveBeenCalledWith("capture-1");
  });
});
