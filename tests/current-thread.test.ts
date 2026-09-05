import {describe, expect, it, vi} from "vitest";

import {
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

  it("submits by session so the store resolves the current thread atomically", async () => {
    const payload = {
      source: "test",
      message: stringToUserMessage("hello"),
    };
    const coordinator = {
      submitSessionInput: vi.fn(async () => ({
        input: {id: "input-1", threadId: "thread-after-reset"},
        disposition: "inserted" as const,
      })),
    };

    const target = await submitCurrentSessionInput({
      sessionId: "session-1",
      coordinator,
      mode: "queue",
      payload,
    });

    expect(target.threadId).toBe("thread-after-reset");
    expect(coordinator.submitSessionInput).toHaveBeenCalledWith("session-1", payload, "queue", undefined);
  });
});
