import {randomUUID} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {WatchRunner, type WatchRunnerOptions} from "../src/domain/watches/runner.js";
import type {ClaimWatchResult, WatchEvaluationResult} from "../src/domain/watches/types.js";
import {waitFor} from "./helpers/wait-for.js";

function harness() {
  const now = Date.now();
  const claim: ClaimWatchResult = {
    watch: {id: randomUUID(), sessionId: "session", title: "Price", intervalMinutes: 5,
      source: {kind: "http_json", url: "https://example.com", result: {observation: "scalar", valuePath: "price"}},
      detector: {kind: "percent_change", percent: 10}, enabled: true, createdAt: now, updatedAt: now},
    run: {id: randomUUID(), watchId: "watch", sessionId: "session", scheduledFor: now, status: "claimed", createdAt: now},
  };
  claim.run.watchId = claim.watch.id;
  const evaluation: WatchEvaluationResult = {changed: true, nextState: {baseline: 120},
    event: {eventKind: "percent_change", summary: "Price moved", dedupeKey: "detector-fingerprint"}};
  const watches = {
    listDueWatches: vi.fn().mockResolvedValueOnce([claim.watch]).mockResolvedValue([]),
    claimWatch: vi.fn(async () => claim), startWatchRun: vi.fn(async () => ({...claim.run, status: "running" as const})),
    renewWatchClaim: vi.fn(async () => true), acceptWatchEvaluation: vi.fn(async () => ({...claim.run, status: "changed" as const})),
    failWatchRun: vi.fn(async () => ({...claim.run, status: "failed" as const})),
  } satisfies WatchRunnerOptions["watches"];
  const getSession = vi.fn(async () => ({id: "session", agentKey: "panda", kind: "main" as const,
    currentThreadId: "current-thread", createdByIdentityId: "creator", createdAt: now, updatedAt: now}));
  const evaluateWatch = vi.fn(async () => evaluation);
  const onError = vi.fn();
  return {claim, evaluation, watches, getSession, evaluateWatch, onError,
    runner: (extra: Partial<WatchRunnerOptions> = {}) => new WatchRunner({watches, sessions: {getSession},
      evaluateWatch, onError, pollIntervalMs: 60_000, ...extra})};
}

async function drain(runner: WatchRunner) {
  await runner.start();
  try { await runner.triggerDrain(); } finally { await runner.stop(); }
}

describe("WatchRunner", () => {
  it("accepts a changed evaluation as one owned operation using the current session context", async () => {
    const h = harness();
    await drain(h.runner());
    expect(h.evaluateWatch).toHaveBeenCalledWith(h.claim.watch, {agentKey: "panda", identityId: "creator"});
    expect(h.watches.acceptWatchEvaluation).toHaveBeenCalledExactlyOnceWith({runId: h.claim.run.id, evaluation: h.evaluation});
    expect(h.watches.failWatchRun).not.toHaveBeenCalled();
  });

  it("passes no-change detector state through the same ownership gate", async () => {
    const h = harness();
    h.evaluateWatch.mockResolvedValue({changed: false, nextState: {baseline: 100}});
    await drain(h.runner());
    expect(h.watches.acceptWatchEvaluation).toHaveBeenCalledWith({runId: h.claim.run.id,
      evaluation: {changed: false, nextState: {baseline: 100}}});
  });

  it("does not evaluate a claim whose start fence was lost", async () => {
    const h = harness();
    h.watches.startWatchRun.mockResolvedValueOnce(null);
    await drain(h.runner());
    expect(h.evaluateWatch).not.toHaveBeenCalled();
    expect(h.watches.acceptWatchEvaluation).not.toHaveBeenCalled();
  });

  it("renews during evaluation and never settles a claim after renewal was rejected", async () => {
    const h = harness();
    let finish!: (value: WatchEvaluationResult) => void;
    h.evaluateWatch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    h.watches.renewWatchClaim.mockResolvedValue(false);
    const runner = h.runner({claimTtlMs: 15});
    await runner.start();
    try {
      await waitFor(() => expect(h.watches.renewWatchClaim).toHaveBeenCalled());
      finish(h.evaluation);
      await runner.triggerDrain();
      expect(h.watches.acceptWatchEvaluation).not.toHaveBeenCalled();
      expect(h.watches.failWatchRun).not.toHaveBeenCalled();
    } finally { await runner.stop(); }
  });

  it("records evaluator failures with their run generation", async () => {
    const h = harness();
    h.evaluateWatch.mockRejectedValue(new Error("Source unavailable"));
    await drain(h.runner());
    expect(h.watches.failWatchRun).toHaveBeenCalledWith({runId: h.claim.run.id, error: "Source unavailable"});
    expect(h.watches.acceptWatchEvaluation).not.toHaveBeenCalled();
  });

  it("retries acceptance receipts without reevaluating or falsely failing a committed run", async () => {
    const h = harness();
    h.watches.acceptWatchEvaluation.mockRejectedValueOnce(new Error("COMMIT acknowledgement lost"));
    await drain(h.runner());
    expect(h.watches.acceptWatchEvaluation).toHaveBeenCalledTimes(2);
    expect(h.evaluateWatch).toHaveBeenCalledTimes(1);
    expect(h.watches.failWatchRun).not.toHaveBeenCalled();
  });

  it("bounds acceptance retries and leaves uncertain receipt recovery to the store", async () => {
    const h = harness();
    h.watches.acceptWatchEvaluation.mockRejectedValue(new Error("database unavailable"));
    await drain(h.runner());
    expect(h.watches.acceptWatchEvaluation).toHaveBeenCalledTimes(3);
    expect(h.watches.failWatchRun).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith(expect.any(Error), h.claim.watch.id);
  });
});
