import {describe, expect, it, vi} from "vitest";

import {prepareLiveVoiceCall, resolveLiveVoiceSelection} from "../src/integrations/voice/call-start.js";

describe("live voice call start", () => {
  it("resolves and persists one immutable agent/provider voice snapshot", async () => {
    const validateVoice = vi.fn((voice: string) => voice);
    const agents = {getAgent: vi.fn(async () => ({agentKey: "panda", displayName: "Panda", status: "active" as const, liveVoice: "cove", createdAt: 1, updatedAt: 1}))};
    const provider = {id: "test-live", model: "test-model", validateVoice, createSession: vi.fn()};
    const resolvedVoice = await resolveLiveVoiceSelection({agentKey: "panda", agents, provider});
    const upsertSession = vi.fn(async (input) => input);
    const prepared = await prepareLiveVoiceCall({
      source: "whatsapp", connectorKey: "connector-1", scopeKey: "call-1", roomKey: "call-1", sessionId: "session-1", agentKey: "panda",
      instructions: "WhatsApp instructions", provider, resolvedVoice, agents,
      voice: {upsertSession} as never,
      output: {pushPcm: vi.fn(), interrupt: vi.fn(), reset: vi.fn(), getSnapshot: () => ({state: "idle", responseEpoch: 0, queuedMs: 0, overruns: 0})},
      log: vi.fn(), onTerminalFailure: vi.fn(),
    });
    expect(agents.getAgent).toHaveBeenCalledOnce();
    expect(validateVoice).toHaveBeenCalledTimes(2);
    expect(prepared.voice).toBe("cove");
    expect(upsertSession).toHaveBeenCalledWith(expect.objectContaining({provider: "test-live", model: "test-model", voice: "cove", state: "connecting"}));
  });
});
