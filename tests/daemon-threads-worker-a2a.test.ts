import {describe, expect, it, vi} from "vitest";

import {createDaemonThreadHelpers} from "../src/app/runtime/daemon-threads.js";

function createContext(parentAgentKey = "clawd") {
  const bindSession = vi.fn(async () => ({
    senderSessionId: "sender",
    recipientSessionId: "recipient",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  const createWorkerSession = vi.fn(async (input: any) => {
    const result = {
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
    await input.beforeHandoff?.(result);
    return result;
  });

  return {
    bindSession,
    createWorkerSession,
    context: {
      fallbackContext: {cwd: "/workspace"},
      a2aBindings: {bindSession},
      runtime: {
        agentStore: {
          getAgent: vi.fn(async () => ({
            agentKey: "clawd",
            displayName: "Clawd",
          })),
          listIdentityPairings: vi.fn(async () => [{agentKey: "clawd"}]),
        },
        sessionStore: {
          getSession: vi.fn(async () => ({
            id: "parent-session",
            agentKey: parentAgentKey,
            kind: "main",
            currentThreadId: "parent-thread",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })),
        },
        workerSessions: {
          createWorkerSession,
        },
      },
    } as any,
  };
}

describe("createDaemonThreadHelpers worker A2A setup", () => {
  it("binds parent and worker sessions before handoff", async () => {
    const {context, bindSession, createWorkerSession} = createContext();
    const helpers = createDaemonThreadHelpers(context);

    await expect(helpers.createWorkerSession({
      identity: {id: "identity-1", handle: "patrik"} as any,
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
    const {context, createWorkerSession} = createContext("luna");
    const helpers = createDaemonThreadHelpers(context);

    await expect(helpers.createWorkerSession({
      identity: {id: "identity-1", handle: "patrik"} as any,
      agentKey: "clawd",
      task: "Do the work.",
      parentSessionId: "parent-session",
    })).rejects.toThrow("must match parent session agent luna");
    expect(createWorkerSession).not.toHaveBeenCalled();
  });
});
