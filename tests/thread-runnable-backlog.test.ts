import type {AssistantMessage} from "@earendil-works/pi-ai";
import {afterEach, describe, expect, it, vi} from "vitest";

import {ThreadRuntimeCoordinator} from "../src/app/sdk/thread-runtime.js";
import type {ThreadRunOwner, ThreadRunRecord} from "../src/domain/threads/runtime/types.js";
import {Agent} from "../src/kernel/agent/agent.js";
import {stringToUserMessage} from "../src/kernel/agent/helpers/input.js";
import type {LlmRuntime} from "../src/kernel/agent/runtime.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

const TEST_OWNER: ThreadRunOwner = {
  source: "panda-core",
  connectorKey: "test",
  holderId: "thread-runnable-backlog-test",
};

function assistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [{type: "text", text: "done"}],
    api: "openai-responses",
    model: "openai/gpt-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

class ImmediateRuntime implements LlmRuntime {
  readonly complete = vi.fn(async () => assistant());
  readonly stream = vi.fn(() => {
    throw new Error("Streaming was not expected in this test.");
  });
}

class BacklogStore extends TestThreadRuntimeStore {
  allowRefill = false;
  runnableListCalls = 0;
  completedRuns = 0;
  activeRuns = 0;
  maxActiveRuns = 0;

  override async listRunnableThreadIds(limit: number): Promise<readonly string[]> {
    this.runnableListCalls += 1;
    if (this.runnableListCalls > 1 && !this.allowRefill) {
      throw new Error("injected runnable backlog refill failure");
    }
    return super.listRunnableThreadIds(limit);
  }

  override async tryStartRun(
    threadId: string,
    owner: ThreadRunOwner,
    runId: string,
  ): Promise<ThreadRunRecord | null> {
    const run = await super.tryStartRun(threadId, owner, runId);
    if (run) {
      this.activeRuns += 1;
      this.maxActiveRuns = Math.max(this.maxActiveRuns, this.activeRuns);
    }
    return run;
  }

  override async completeRun(runId: string): Promise<ThreadRunRecord> {
    const run = await super.completeRun(runId);
    this.activeRuns -= 1;
    this.completedRuns += 1;
    return run;
  }

  override async failRun(runId: string, error?: string): Promise<ThreadRunRecord> {
    try {
      return await super.failRun(runId, error);
    } finally {
      this.activeRuns -= 1;
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runnable backlog reconciliation", () => {
  it("drains more than one startup batch and retries a failed refill only while backlog remains", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new BacklogStore();
    for (let index = 0; index < 250; index += 1) {
      const threadId = `backlog-thread-${String(index).padStart(3, "0")}`;
      await store.createThread({id: threadId, sessionId: `backlog-session-${index}`});
      await store.enqueueInput(threadId, {
        message: stringToUserMessage(`input ${index}`),
        // Heartbeats intentionally do not request the runtime's blind idle reroll.
        source: "heartbeat",
      });
    }

    const runtime = new ImmediateRuntime();
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      maxConcurrentRuns: 4,
      resolveDefinition: async () => ({
        agent: new Agent({name: "backlog-test", instructions: "Finish immediately."}),
        runtime,
      }),
    });
    await coordinator.handleStoreNotificationStatus("listening");

    try {
      await coordinator.start(TEST_OWNER);
      await vi.waitFor(() => {
        expect(store.completedRuns).toBe(100);
        expect(store.runnableListCalls).toBe(2);
      });

      store.allowRefill = true;
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => {
        expect(store.completedRuns).toBe(250);
      });
      expect(store.maxActiveRuns).toBeLessThanOrEqual(4);
      expect(store.runnableListCalls).toBeGreaterThanOrEqual(4);
      expect(store.runnableListCalls).toBeLessThanOrEqual(5);

      const callsAfterDrain = store.runnableListCalls;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(store.runnableListCalls).toBe(callsAfterDrain);
    } finally {
      await coordinator.stop();
    }
  });
});
