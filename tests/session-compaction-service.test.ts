import {describe, expect, it, vi} from "vitest";

import {
  SessionCompactionService,
  type SessionCompactionServiceOptions,
} from "../src/app/runtime/session-compaction-service.js";
import type {CompactThreadResult} from "../src/kernel/transcript/compaction.js";

function createHarness(options: {sessionThreads?: string[]} = {}) {
  const sessionThreads = [...(options.sessionThreads ?? ["thread-current", "thread-current"])];
  let lastSessionThread = sessionThreads[0] ?? "thread-current";
  const getSession = vi.fn(async (sessionId: string) => {
    lastSessionThread = sessionThreads.shift() ?? lastSessionThread;
    return {
      id: sessionId,
      agentKey: "panda",
      kind: "main" as const,
      currentThreadId: lastSessionThread,
      createdAt: 1,
      updatedAt: 1,
    };
  });
  const getThread = vi.fn(async (threadId: string) => ({
    id: threadId,
    sessionId: "session-1",
    createdAt: 1,
    updatedAt: 1,
  }));
  const runExclusively = vi.fn(async (_threadId: string, operation: () => Promise<unknown>) => operation());
  const compact = vi.fn(async () => ({
    tokensBefore: 1_200,
    tokensAfter: 350,
  }) as CompactThreadResult);
  const dependencies = {
    sessions: {getSession},
    threads: {
      appendRuntimeMessage: vi.fn(),
      getThread,
      hasRunnableInputs: vi.fn(async () => false),
      loadTranscript: vi.fn(),
    },
    coordinator: {
      resolveThreadRunConfig: vi.fn(async () => ({model: "openai/gpt-5.6-sol", thinking: "high" as const})),
      runExclusively,
    },
    compact,
    readMissingApiKeyMessage: vi.fn(() => undefined),
  } satisfies SessionCompactionServiceOptions;

  return {
    service: new SessionCompactionService(dependencies),
    compact,
    dependencies,
    getSession,
    getThread,
    runExclusively,
  };
}

describe("SessionCompactionService", () => {
  it("compacts the current session thread with custom instructions", async () => {
    const harness = createHarness();

    await expect(harness.service.compactSession("session-1", "Keep the incident timeline."))
      .resolves.toEqual({
        compacted: true,
        sessionId: "session-1",
        threadId: "thread-current",
        tokensBefore: 1_200,
        tokensAfter: 350,
      });

    expect(harness.runExclusively).toHaveBeenCalledWith("thread-current", expect.any(Function));
    expect(harness.compact).toHaveBeenCalledWith(expect.objectContaining({
      thread: expect.objectContaining({id: "thread-current"}),
      customInstructions: "Keep the incident timeline.",
      trigger: "manual",
    }));
  });

  it("re-resolves the current thread after acquiring the lease", async () => {
    const harness = createHarness({sessionThreads: ["thread-before-reset", "thread-after-reset", "thread-after-reset"]});

    await expect(harness.service.compactSession("session-1"))
      .resolves.toMatchObject({threadId: "thread-after-reset", compacted: true});

    expect(harness.runExclusively).toHaveBeenNthCalledWith(1, "thread-before-reset", expect.any(Function));
    expect(harness.runExclusively).toHaveBeenNthCalledWith(2, "thread-after-reset", expect.any(Function));
    expect(harness.getThread).toHaveBeenCalledWith("thread-after-reset");
    expect(harness.compact).toHaveBeenCalledTimes(1);
  });

  it("refuses compaction while runnable input is queued", async () => {
    const harness = createHarness();
    harness.dependencies.threads.hasRunnableInputs.mockResolvedValue(true);

    await expect(harness.service.compactSession("session-1"))
      .rejects.toThrow("Wait for queued input to run before compacting.");
    expect(harness.compact).not.toHaveBeenCalled();
  });
});
