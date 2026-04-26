import {describe, expect, it, vi} from "vitest";

import {Agent, type DefaultAgentSessionContext, RunContext} from "../src/index.js";
import {AppActionTool, AppListTool, AppViewTool} from "../src/panda/tools/app-tools.js";
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

function createAppServiceMock(overrides: Partial<AgentAppService> = {}): AgentAppService {
  return {
    inspectApps: vi.fn(async () => ({
      apps: [],
      brokenApps: [],
    })),
    executeView: vi.fn(async () => ({
      items: [],
    })),
    executeAction: vi.fn(async () => ({
      mode: "native",
      changes: 0,
      wakeRequested: false,
    })),
    ...overrides,
  } as unknown as AgentAppService;
}

function createAppDefinition() {
  return {
    agentKey: "panda",
    slug: "food-tracker",
    name: "Food Tracker",
    description: "Macro logs.",
    identityScoped: false,
    hasUi: true,
    views: {
      today_summary: {
        description: "Today totals.",
        sql: "select 1",
      },
    },
    actions: {
      delete_entry: {
        mode: "native",
        description: "Delete a food entry by id.",
        sql: "delete from entries where id = :id",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "integer",
            },
          },
          required: ["id"],
        },
      },
    },
  } as never;
}

function readToolDetails(result: unknown): Record<string, unknown> {
  return (result as {details: Record<string, unknown>}).details;
}

describe("app tools", () => {
  it("keeps app_list compact by default", async () => {
    const service = createAppServiceMock({
      inspectApps: vi.fn(async () => ({
        apps: [createAppDefinition()],
        brokenApps: [],
      })),
    });
    const tool = new AppListTool(service);

    const details = readToolDetails(await tool.handle({}, createRunContext({
      agentKey: "panda",
      sessionId: "session-main",
      threadId: "thread-main",
    })));

    expect(details).toEqual({
      detail: "summary",
      apps: [{
        slug: "food-tracker",
        name: "Food Tracker",
        description: "Macro logs.",
        identityScoped: false,
        hasUi: true,
        viewNames: ["today_summary"],
        actionNames: ["delete_entry"],
      }],
      brokenApps: [],
    });
    expect(JSON.stringify(details)).not.toContain("inputSchema");
    expect(JSON.stringify(details)).not.toContain("appUrl");
  });

  it("returns full app details only when scoped to one app", async () => {
    const service = createAppServiceMock({
      inspectApps: vi.fn(async () => ({
        apps: [createAppDefinition()],
        brokenApps: [],
      })),
    });
    const tool = new AppListTool(service);

    await expect(tool.handle({
      detail: "full",
    } as never, createRunContext({
      agentKey: "panda",
      sessionId: "session-main",
      threadId: "thread-main",
    }))).rejects.toThrow("requires appSlug");

    const details = readToolDetails(await tool.handle({
      appSlug: "food-tracker",
      detail: "full",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-main",
      threadId: "thread-main",
    })));
    const [app] = details.apps as Array<Record<string, unknown>>;
    const [action] = app.actions as Array<Record<string, unknown>>;

    expect(app.appUrl).toContain("/panda/apps/food-tracker/");
    expect(action.requiredInputKeys).toEqual(["id"]);
    expect((action.inputSchema as {required: string[]}).required).toEqual(["id"]);
  });

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
