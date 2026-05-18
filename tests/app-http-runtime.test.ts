import {describe, expect, it, vi} from "vitest";

import {
  buildAgentAppWakeHandler,
  resolveAgentAppApiRequestContext,
} from "../src/integrations/apps/http-runtime.js";
import type {AgentAppSessionRecord} from "../src/domain/apps/auth.js";
import type {SessionRecord} from "../src/domain/sessions/index.js";

describe("agent app HTTP runtime", () => {
  it("does not let authenticated app requests override an unbound runtime session", async () => {
    const appSession: AgentAppSessionRecord = {
      id: "app-session-1",
      agentKey: "panda",
      appSlug: "journal",
      identityId: "identity-patrik",
      csrfTokenHash: "hash",
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    const getSession = vi.fn(async (sessionId: string): Promise<SessionRecord> => ({
      id: sessionId,
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-foreign",
      createdAt: 1,
      updatedAt: 1,
    }));

    const context = await resolveAgentAppApiRequestContext({
      agentKey: "panda",
      appSession,
      body: {
        identityId: "identity-attacker",
        sessionId: "session-foreign",
      },
      requestUrl: new URL("http://apps.local/api/apps/panda/journal/bootstrap?sessionId=session-query"),
      sessionStore: {
        getSession,
      },
    });

    expect(context).toEqual({
      authenticated: true,
      identityId: "identity-patrik",
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("does not echo explicit session ids when the requested app session is missing", async () => {
    await expect(resolveAgentAppApiRequestContext({
      agentKey: "panda",
      appSession: null,
      body: {
        sessionId: "session-secret",
      },
      requestUrl: new URL("http://apps.local/api/apps/panda/journal/bootstrap"),
      sessionStore: {
        getSession: async () => {
          throw new Error("Unknown session session-secret");
        },
      },
    })).rejects.toMatchObject({
      statusCode: 404,
      message: "Requested session is not valid for this app.",
    });
  });

  it("does not echo session ownership details when the requested app session belongs elsewhere", async () => {
    await expect(resolveAgentAppApiRequestContext({
      agentKey: "panda",
      appSession: null,
      body: {
        sessionId: "session-foreign",
      },
      requestUrl: new URL("http://apps.local/api/apps/panda/journal/bootstrap"),
      sessionStore: {
        getSession: async (sessionId): Promise<SessionRecord> => ({
          id: sessionId,
          agentKey: "other-agent",
          kind: "main",
          currentThreadId: "thread-foreign",
          createdAt: 1,
          updatedAt: 1,
        }),
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: "Requested session is not valid for this app.",
    });
  });

  it("wakes the current session thread when the app action emits after reset", async () => {
    const session: SessionRecord = {
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-before-reset",
      createdAt: 1,
      updatedAt: 1,
    };
    const submitInput = vi.fn(async () => undefined);
    const wake = buildAgentAppWakeHandler({
      agentKey: "panda",
      appSlug: "period-tracker",
      actionName: "log_period",
      sessionId: session.id,
      sessionStore: {
        getSession: async (sessionId) => {
          expect(sessionId).toBe(session.id);
          return session;
        },
      },
      coordinator: {
        submitInput,
      },
    });

    session.currentThreadId = "thread-after-reset";
    await wake("Period tracker logged a new entry.");

    expect(submitInput).toHaveBeenCalledWith("thread-after-reset", expect.objectContaining({
      source: "app_http",
      channelId: "period-tracker",
      metadata: expect.objectContaining({
        kind: "app_action",
        agentKey: "panda",
        appSlug: "period-tracker",
        actionName: "log_period",
      }),
    }), "wake");
  });
});
