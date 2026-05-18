import {describe, expect, it, vi} from "vitest";

import {
  enqueueCurrentSessionInput,
  requireCurrentSessionThread,
  submitCurrentSessionInput,
} from "../src/domain/sessions/current-thread.js";
import type {SessionRecord} from "../src/domain/sessions/types.js";
import {stringToUserMessage} from "../src/kernel/agent/helpers/input.js";

function createSession(currentThreadId: string): SessionRecord {
  return {
    id: "session-1",
    agentKey: "panda",
    kind: "main",
    currentThreadId,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("current session thread delivery", () => {
  it("rejects blank current thread ids", () => {
    expect(() => requireCurrentSessionThread(createSession("   "))).toThrow(
      "Session session-1 has no current thread.",
    );
  });

  it("submits to the current thread resolved at delivery time", async () => {
    let currentThreadId = "thread-before-reset";
    const payload = {
      source: "test",
      message: stringToUserMessage("hello"),
    };
    const sessions = {
      getSession: vi.fn(async () => createSession(currentThreadId)),
    };
    const coordinator = {
      submitInput: vi.fn(async () => {}),
    };

    currentThreadId = "thread-after-reset";

    const target = await submitCurrentSessionInput({
      sessionId: "session-1",
      sessions,
      coordinator,
      mode: "queue",
      payload,
    });

    expect(target.threadId).toBe("thread-after-reset");
    expect(coordinator.submitInput).toHaveBeenCalledWith("thread-after-reset", payload, "queue");
  });

  it("queues to the current thread and defaults to wake delivery", async () => {
    let currentThreadId = "thread-before-reset";
    const payload = {
      source: "test",
      message: stringToUserMessage("hello"),
    };
    const sessions = {
      getSession: vi.fn(async () => createSession(currentThreadId)),
    };
    const threads = {
      enqueueInput: vi.fn(async () => ({
        id: "input-1",
      })),
    };

    currentThreadId = "thread-after-reset";

    const target = await enqueueCurrentSessionInput({
      sessionId: "session-1",
      sessions,
      threads,
      payload,
    });

    expect(target.threadId).toBe("thread-after-reset");
    expect(threads.enqueueInput).toHaveBeenCalledWith("thread-after-reset", payload, "wake");
  });
});
