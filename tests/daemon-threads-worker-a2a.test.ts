import {describe, expect, it, vi} from "vitest";

import type {BindA2ASessionInput} from "../src/domain/a2a/types.js";
import type {IdentityRecord} from "../src/domain/identity/index.js";
import type {SessionRecord} from "../src/domain/sessions/index.js";
import {
  createDaemonWorkerSessionCreator,
  type DaemonWorkerSessionContext,
} from "../src/app/runtime/daemon-worker-sessions.js";
import type {
  CreateWorkerSessionInput,
  CreateWorkerSessionResult,
} from "../src/app/runtime/worker-session-service.js";

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

function createWorkerSessionResult(): CreateWorkerSessionResult {
  return {
    session: {
      id: "worker-session",
      agentKey: "clawd",
      kind: "worker",
      currentThreadId: "worker-thread",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    thread: {
      id: "worker-thread",
      sessionId: "worker-session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    environment: {
      id: "worker:worker-session",
      agentKey: "clawd",
      kind: "disposable_container",
      state: "ready",
      runnerUrl: "http://worker:8080",
      runnerCwd: "/workspace",
      rootPath: "/workspace",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    binding: {
      sessionId: "worker-session",
      environmentId: "worker:worker-session",
      alias: "self",
      isDefault: true,
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "allowlist", skillKeys: []},
      toolPolicy: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
}

function createParentSession(agentKey: string): SessionRecord {
  return {
    id: "parent-session",
    agentKey,
    kind: "main",
    currentThreadId: "parent-thread",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function createContext(parentAgentKey = "clawd") {
  const bindSession = vi.fn(async (input: BindA2ASessionInput) => ({
    ...input,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  const createWorkerSession = vi.fn(async (input: CreateWorkerSessionInput) => {
    const result = createWorkerSessionResult();
    await input.beforeHandoff?.(result);
    return result;
  });
  const resolveAccessibleAgentKey = vi.fn(async () => "clawd");
  const context: DaemonWorkerSessionContext = {
    a2aBindings: {bindSession},
    resolveAccessibleAgentKey,
    sessions: {
      getSession: vi.fn(async () => createParentSession(parentAgentKey)),
    },
    workerSessions: {
      createWorkerSession,
    },
  };

  return {
    bindSession,
    context,
    createWorkerSession,
    createWorkerSessionForDaemon: createDaemonWorkerSessionCreator(context),
  };
}

describe("createDaemonWorkerSessionCreator", () => {
  it("binds parent and worker sessions before handoff", async () => {
    const {bindSession, createWorkerSession, createWorkerSessionForDaemon} = createContext();

    await expect(createWorkerSessionForDaemon({
      identity: createIdentity(),
      agentKey: "clawd",
      sessionId: "worker-session",
      threadId: "worker-thread",
      task: "Do the work.",
      parentSessionId: "parent-session",
    })).resolves.toMatchObject({
      session: {id: "worker-session"},
      thread: {id: "worker-thread"},
    });

    expect(createWorkerSession).toHaveBeenCalledWith(expect.objectContaining({
      beforeHandoff: expect.any(Function),
    }));
    expect(bindSession).toHaveBeenCalledWith({
      senderSessionId: "parent-session",
      recipientSessionId: "worker-session",
    });
    expect(bindSession).toHaveBeenCalledWith({
      senderSessionId: "worker-session",
      recipientSessionId: "parent-session",
    });
  });

  it("rejects worker sessions for a different parent agent", async () => {
    const {createWorkerSession, createWorkerSessionForDaemon} = createContext("luna");

    await expect(createWorkerSessionForDaemon({
      identity: createIdentity(),
      agentKey: "clawd",
      task: "Do the work.",
      parentSessionId: "parent-session",
    })).rejects.toThrow("must match parent session agent luna");
    expect(createWorkerSession).not.toHaveBeenCalled();
  });
});
