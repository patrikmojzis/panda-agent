import {describe, expect, it, vi} from "vitest";

import type {IdentityRecord} from "../src/domain/identity/index.js";
import type {SessionRecord} from "../src/domain/sessions/index.js";
import {
  createDaemonSubagentSessionCreator,
  type DaemonSubagentSessionContext,
} from "../src/app/runtime/daemon-subagent-sessions.js";
import type {
  CreateSubagentSessionInput,
  CreateSubagentSessionResult,
} from "../src/app/runtime/subagent-session-service.js";

function createIdentity(): IdentityRecord {
  return {
    id: "identity-1",
    handle: "patrik",
    displayName: "Patrik",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function createSubagentSessionResult(): CreateSubagentSessionResult {
  return {
    session: {
      id: "subagent-session",
      agentKey: "clawd",
      kind: "subagent",
      currentThreadId: "subagent-thread",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies SessionRecord,
    thread: {
      id: "subagent-thread",
      sessionId: "subagent-session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
}

function createContext() {
  const createSubagentSession = vi.fn(async (_input: CreateSubagentSessionInput) => createSubagentSessionResult());
  const resolveAccessibleAgentKey = vi.fn(async () => "clawd");
  const context: DaemonSubagentSessionContext = {
    resolveAccessibleAgentKey,
    subagentSessions: {
      createSubagentSession,
    },
  };

  return {
    context,
    createSubagentSession,
    createSubagentSessionForDaemon: createDaemonSubagentSessionCreator(context),
    resolveAccessibleAgentKey,
  };
}

describe("createDaemonSubagentSessionCreator", () => {
  it("creates a durable subagent through the subagent service", async () => {
    const {createSubagentSession, createSubagentSessionForDaemon, resolveAccessibleAgentKey} = createContext();

    await expect(createSubagentSessionForDaemon({
      identity: createIdentity(),
      agentKey: "clawd",
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      parentSessionId: "parent-session",
      prompt: "Do the work.",
      profile: "workspace",
      execution: "agent_workspace",
      credentialAllowlist: ["API_KEY"],
      toolGroups: undefined,
    })).resolves.toMatchObject({
      session: {id: "subagent-session"},
      thread: {id: "subagent-thread"},
    });

    expect(resolveAccessibleAgentKey).toHaveBeenCalledWith(expect.objectContaining({id: "identity-1"}), "clawd");
    expect(createSubagentSession).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: "clawd",
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      parentSessionId: "parent-session",
      task: "Do the work.",
      profile: "workspace",
      execution: "agent_workspace",
      credentialAllowlist: ["API_KEY"],
      createdByIdentityId: "identity-1",
    }));
  });

  it("does not translate access failures into legacy worker creation", async () => {
    const createSubagentSession = vi.fn();
    const context: DaemonSubagentSessionContext = {
      resolveAccessibleAgentKey: vi.fn(async () => {
        throw new Error("Identity patrik is not paired to agent luna.");
      }),
      subagentSessions: {createSubagentSession},
    };

    await expect(createDaemonSubagentSessionCreator(context)({
      identity: createIdentity(),
      agentKey: "luna",
      parentSessionId: "parent-session",
      prompt: "Do the work.",
    })).rejects.toThrow("not paired to agent luna");
    expect(createSubagentSession).not.toHaveBeenCalled();
  });
});
