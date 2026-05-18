import {describe, expect, it, vi} from "vitest";

import {Agent, type DefaultAgentSessionContext, RunContext} from "../src/index.js";
import {
  AppActionTool,
  type AppLinkAuthService,
  AppLinkCreateTool,
  AppListTool,
  type AppToolService,
  AppViewTool,
} from "../src/panda/tools/app-tools.js";
import type {AgentAppDefinition} from "../src/domain/apps/types.js";

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

function createAppServiceMock(overrides: Partial<AppToolService> = {}): AppToolService {
  return {
    createBlankApp: vi.fn(async () => ({
      actionPath: "/apps/food-tracker/actions.json",
      app: createAppDefinition(),
      manifestPath: "/apps/food-tracker/manifest.json",
      readmePath: "/apps/food-tracker/README.md",
      schemaApplied: false,
      schemaPath: "/apps/food-tracker/schema.sql",
      viewPath: "/apps/food-tracker/views.json",
    })),
    inspectApps: vi.fn(async () => ({
      apps: [],
      brokenApps: [],
    })),
    checkApps: vi.fn(async () => []),
    getApp: vi.fn(async () => createAppDefinition()),
    executeView: vi.fn(async () => ({
      items: [],
    })),
    executeAction: vi.fn(async () => ({
      mode: "native",
      changes: 0,
      wakeRequested: false,
    })),
    ...overrides,
  };
}

function createAppDefinition(): AgentAppDefinition {
  return {
    agentKey: "panda",
    slug: "food-tracker",
    name: "Food Tracker",
    description: "Macro logs.",
    identityScoped: false,
    appDir: "/apps/food-tracker",
    manifestPath: "/apps/food-tracker/manifest.json",
    viewsPath: "/apps/food-tracker/views.json",
    actionsPath: "/apps/food-tracker/actions.json",
    publicDir: "/apps/food-tracker/public",
    entryHtmlPath: "/apps/food-tracker/public/index.html",
    hasUi: true,
    dbPath: "/apps/food-tracker/data/app.sqlite",
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
  };
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
    }, createRunContext({
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

  it("uses the current input identity for app_view", async () => {
    const service = createAppServiceMock();
    const tool = new AppViewTool(service);

    await tool.handle({
      appSlug: "period-tracker",
      viewName: "summary",
    }, createRunContext({
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

  it("uses the current input identity for app_action", async () => {
    const service = createAppServiceMock();
    const tool = new AppActionTool(service);

    await tool.handle({
      appSlug: "period-tracker",
      actionName: "log_period",
      input: {flow: "medium"},
    }, createRunContext({
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

  it("uses the current input identity for app_link_create without returning raw identity ids", async () => {
    const service = createAppServiceMock({
      getApp: vi.fn(async () => createAppDefinition()),
    });
    const auth = {
      createLaunchToken: vi.fn(async () => ({
        token: "pal_launch-token",
        expiresAt: Date.UTC(2026, 4, 13, 12, 0, 0),
      })),
    };
    const tool = new AppLinkCreateTool(service, auth satisfies AppLinkAuthService);

    const details = readToolDetails(await tool.handle({
      appSlug: "food-tracker",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-main",
      threadId: "thread-main",
      currentInput: {
        source: "telegram",
        identityId: "identity-current",
      },
    })));

    expect(auth.createLaunchToken).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: "panda",
      appSlug: "food-tracker",
      identityId: "identity-current",
      sessionId: "session-main",
    }));
    expect(details.openUrl).toContain("/apps/open?token=pal_launch-token");
    expect(details).not.toHaveProperty("identityId");
  });

  it("rejects non-JSON app_view payloads before returning them to the model", async () => {
    const service = createAppServiceMock({
      executeView: vi.fn(async () => ({
        items: [{
          value: Number.NaN,
        }],
      })),
    });
    const tool = new AppViewTool(service);

    await expect(tool.handle({
      appSlug: "period-tracker",
      viewName: "summary",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-main",
      threadId: "thread-main",
    }))).rejects.toThrow("app_view result must be a JSON object.");
  });

  it("rejects non-JSON app_action payloads before returning them to the model", async () => {
    const service = createAppServiceMock({
      executeAction: vi.fn(async () => ({
        mode: "native",
        changes: 1,
        wakeRequested: false,
        rows: [{
          value: Number.NaN,
        }],
      })),
    });
    const tool = new AppActionTool(service);

    await expect(tool.handle({
      appSlug: "period-tracker",
      actionName: "log_period",
    }, createRunContext({
      agentKey: "panda",
      sessionId: "session-main",
      threadId: "thread-main",
    }))).rejects.toThrow("app_action result must be a JSON object.");
  });
});
