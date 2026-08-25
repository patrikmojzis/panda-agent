import {describe, expect, it, vi} from "vitest";

import {createDaemonSubagentSessionCreator} from "../src/app/runtime/daemon-subagent-sessions.js";

describe("daemon subagent session creation", () => {
  it("replays the persisted creation before consulting mutable identity pairings", async () => {
    let receipt: {
      identityId: string;
      agentKey: string;
      sessionId: string;
      threadId: string;
      kind: "subagent";
    } | null = null;
    const ensureIdentity = vi.fn(async () => ({id: "identity-1"}) as never);
    const resolveAccessibleAgentKey = vi.fn(async () => "panda");
    const createSubagentSession = vi.fn(async () => {
      receipt = {
        identityId: "identity-1",
        agentKey: "panda",
        sessionId: "subagent-session",
        threadId: "subagent-thread",
        kind: "subagent",
      };
      return {
        session: {id: "subagent-session", agentKey: "panda"},
        thread: {id: "subagent-thread", sessionId: "subagent-session"},
      } as never;
    });
    const create = createDaemonSubagentSessionCreator({
      ensureIdentity,
      resolveAccessibleAgentKey,
      sessions: {
        getSession: vi.fn(async () => ({agentKey: "panda"})),
        getSessionCreationOperation: vi.fn(async () => receipt),
      },
      subagentSessions: {createSubagentSession},
    });
    const input = {
      operationId: "request-1",
      replayAttempt: false,
      identityId: "identity-1",
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      parentSessionId: "parent-session",
      prompt: "Inspect the repository.",
    };

    await create(input);
    ensureIdentity.mockRejectedValue(new Error("identity was deleted"));
    resolveAccessibleAgentKey.mockRejectedValue(new Error("pairing was revoked"));
    await expect(create({...input, replayAttempt: true})).resolves.toMatchObject({
      session: {id: "subagent-session"},
      thread: {id: "subagent-thread"},
    });

    expect(ensureIdentity).toHaveBeenCalledTimes(1);
    expect(resolveAccessibleAgentKey).toHaveBeenCalledTimes(1);
    expect(createSubagentSession).toHaveBeenCalledTimes(2);
    expect(createSubagentSession).toHaveBeenLastCalledWith(expect.objectContaining({
      agentKey: "panda",
      createdByIdentityId: "identity-1",
    }));
  });
});
