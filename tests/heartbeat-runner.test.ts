import {describe, expect, it, vi} from "vitest";
import {HeartbeatRunner, type HeartbeatRunnerOptions} from "../src/domain/scheduling/heartbeats/runner.js";
import type {SessionHeartbeatRecord} from "../src/domain/sessions/types.js";

function harness() {
  const now = Date.now();
  const heartbeat: SessionHeartbeatRecord = {sessionId: "session", enabled: true, everyMinutes: 30,
    configRevision: 0, nextFireAt: now - 1000, createdAt: now, updatedAt: now};
  const session = {id: "session", agentKey: "panda", kind: "main" as const, currentThreadId: "current-thread",
    createdByIdentityId: "creator", createdAt: now, updatedAt: now};
  const sessions = {
    getSession: vi.fn(async () => ({...session})), getHeartbeat: vi.fn(async () => ({...heartbeat})),
    listDueHeartbeats: vi.fn().mockResolvedValueOnce([heartbeat]).mockResolvedValue([]),
    claimHeartbeat: vi.fn(async (claim) => {
      Object.assign(heartbeat, {claimedBy: claim.claimedBy, claimExpiresAt: claim.claimExpiresAt});
      return {...heartbeat};
    }),
    recordHeartbeatResult: vi.fn(async () => ({...heartbeat})),
  } satisfies HeartbeatRunnerOptions["sessions"];
  const isThreadBusy = vi.fn(async () => false);
  const onError = vi.fn();
  return {heartbeat, session, sessions, isThreadBusy, onError,
    runner: (extra: Partial<HeartbeatRunnerOptions> = {}) => new HeartbeatRunner({sessions,
      coordinator: {isThreadBusy}, onError, pollIntervalMs: 60_000, ...extra})};
}

async function drain(runner: HeartbeatRunner) {
  await runner.start();
  try { await runner.triggerDrain(); } finally { await runner.stop(); }
}

describe("HeartbeatRunner", () => {
  it("passes prompt and settlement together under a unique claim token", async () => {
    const h = harness();
    await drain(h.runner({resolvePromptContext: () => ({guidance: "Check unfinished promises.", canConfigureCadence: true})}));
    expect(h.sessions.recordHeartbeatResult).toHaveBeenCalledTimes(1);
    expect(h.sessions.recordHeartbeatResult).toHaveBeenCalledWith(expect.objectContaining({
      claimedBy: expect.stringMatching(/^[0-9a-f-]{36}$/), sessionId: "session", lastFireAt: expect.any(Number),
      input: expect.objectContaining({source: "heartbeat", identityId: "creator",
        message: expect.objectContaining({content: expect.stringContaining("Check unfinished promises.")}),
        metadata: {heartbeat: {kind: "interval", scheduledFor: new Date(h.heartbeat.nextFireAt).toISOString(), sessionId: "session"}}}),
    }));
  });

  it("settles busy work without proposing an input", async () => {
    const h = harness();
    h.isThreadBusy.mockResolvedValue(true);
    await drain(h.runner());
    expect(h.sessions.recordHeartbeatResult).toHaveBeenCalledWith(expect.objectContaining({lastSkipReason: "busy"}));
    expect(h.sessions.recordHeartbeatResult.mock.calls[0]?.[0]).not.toHaveProperty("input");
  });

  it("refreshes cadence text while keeping the claimed schedule and revision", async () => {
    const h = harness();
    const scheduledFor = h.heartbeat.nextFireAt;
    await drain(h.runner({resolvePromptContext: () => {
      Object.assign(h.heartbeat, {everyMinutes: 15, configRevision: 1, lastCadenceChangeReason: "Investigation", nextFireAt: Date.now() + 900000});
      return {canConfigureCadence: true};
    }}));
    expect(h.sessions.recordHeartbeatResult).toHaveBeenCalledWith(expect.objectContaining({configRevision: 0,
      input: expect.objectContaining({message: expect.objectContaining({content: expect.stringContaining("Current heartbeat interval: 15 minutes.")}),
        metadata: {heartbeat: {kind: "interval", scheduledFor: new Date(scheduledFor).toISOString(), sessionId: "session"}}})}));
  });

  it.each(["disabled", "replaced", "expired"])("does not propose a %s claim after prompt resolution", async (reason) => {
    const h = harness();
    await drain(h.runner({resolvePromptContext: () => {
      if (reason === "disabled") h.heartbeat.enabled = false;
      if (reason === "replaced") h.heartbeat.claimedBy = "replacement";
      if (reason === "expired") h.heartbeat.claimExpiresAt = 1;
      return {canConfigureCadence: false};
    }}));
    expect(h.sessions.recordHeartbeatResult).not.toHaveBeenCalled();
  });

  it("rechecks busy state on the current thread after prompt resolution resets the session", async () => {
    const h = harness();
    h.isThreadBusy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await drain(h.runner({resolvePromptContext: () => {
      h.session.currentThreadId = "reset-thread";
      return {canConfigureCadence: false};
    }}));
    expect(h.isThreadBusy).toHaveBeenLastCalledWith("reset-thread");
    expect(h.sessions.recordHeartbeatResult).toHaveBeenCalledWith(expect.objectContaining({lastSkipReason: "busy"}));
    expect(h.sessions.recordHeartbeatResult.mock.calls[0]?.[0]).not.toHaveProperty("input");
  });

  it("retries the same atomic receipt without rerendering a heartbeat", async () => {
    const h = harness();
    const resolvePromptContext = vi.fn(() => ({canConfigureCadence: true}));
    h.sessions.recordHeartbeatResult.mockRejectedValueOnce(new Error("COMMIT acknowledgement lost"));
    await drain(h.runner({resolvePromptContext}));
    expect(h.sessions.recordHeartbeatResult).toHaveBeenCalledTimes(2);
    expect(h.sessions.recordHeartbeatResult.mock.calls[1]?.[0]).toEqual(h.sessions.recordHeartbeatResult.mock.calls[0]?.[0]);
    expect(resolvePromptContext).toHaveBeenCalledTimes(1);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("reports prompt failures through the owned settlement seam", async () => {
    const h = harness();
    await drain(h.runner({resolvePromptContext: () => { throw new Error("prompt unavailable"); }}));
    expect(h.sessions.recordHeartbeatResult).toHaveBeenCalledWith(expect.objectContaining({lastSkipReason: "prompt unavailable"}));
    expect(h.onError).toHaveBeenCalled();
  });
});
