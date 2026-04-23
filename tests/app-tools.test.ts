import {describe, expect, it, vi} from "vitest";

import {Agent, type DefaultAgentSessionContext, RunContext} from "../src/index.js";
import {AppActionTool, AppViewTool} from "../src/panda/tools/app-tools.js";
import type {AgentAppService} from "../src/integrations/apps/sqlite-service.js";

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "panda",
      instructions: "Use tools.",
    }),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

function createAppServiceMock(): AgentAppService {
  return {
    executeView: vi.fn(async () => ({
      items: [],
    })),
    executeAction: vi.fn(async () => ({
      mode: "native",
      changes: 0,
      wakeRequested: false,
    })),
  } as unknown as AgentAppService;
}

describe("app tools", () => {
  it("uses the current input identity for app_view even if args include another identity", async () => {
    const service = createAppServiceMock();
    const tool = new AppViewTool(service);

    await tool.handle({
      appSlug: "period-tracker",
      viewName: "summary",
      identityId: "identity-other",
    } as never, createRunContext({
      agentKey: "panda",
      sessionId: "session-main",
      threadId: "thread-main",
      currentInput: {
        source: "telegram",
        identityId: "identity-current",
      },
    }));

    expect(service.executeView).toHaveBeenCalledWith("panda", "period-tracker", "summary", expect.objectContaining({
      identityId: "identity-current",
    }));
  });

  it("uses the current input identity for app_action even if args include another identity", async () => {
    const service = createAppServiceMock();
    const tool = new AppActionTool(service);

    await tool.handle({
      appSlug: "period-tracker",
      actionName: "log_period",
      identityId: "identity-other",
      input: {flow: "medium"},
    } as never, createRunContext({
      agentKey: "panda",
      sessionId: "session-main",
      threadId: "thread-main",
      currentInput: {
        source: "telegram",
        identityId: "identity-current",
      },
    }));

    expect(service.executeAction).toHaveBeenCalledWith("panda", "period-tracker", "log_period", expect.objectContaining({
      identityId: "identity-current",
      input: {flow: "medium"},
    }));
  });
});
