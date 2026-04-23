import {afterEach, describe, expect, it, vi} from "vitest";

import {
  DEFAULT_APPS_PORT,
  resolveAgentAppUrls,
  resolveOptionalAgentAppServerBinding,
  startAgentAppServer,
} from "../src/integrations/apps/http-server.js";
import {AgentAppService} from "../src/integrations/apps/sqlite-service.js";
import {createAgentAppFixture, type AgentAppFixture} from "./helpers/app-fixture.js";

describe("agent app server", () => {
  const fixtures: AgentAppFixture[] = [];
  const servers: Array<{close(): Promise<void>}> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it("resolves default bindings and app urls for local and internal access", () => {
    const binding = resolveOptionalAgentAppServerBinding({
      hostEnvKey: "PANDA_APPS_HOST",
      portEnvKey: "PANDA_APPS_PORT",
      defaultPort: DEFAULT_APPS_PORT,
      env: {},
    });

    expect(binding).toEqual({
      host: "127.0.0.1",
      port: DEFAULT_APPS_PORT,
    });

    expect(resolveAgentAppUrls({
      agentKey: "panda",
      appSlug: "period-tracker",
      env: {},
      binding,
    })).toEqual({
      appPath: "/apps/panda/period-tracker/",
      appUrl: "http://127.0.0.1:8092/apps/panda/period-tracker/",
      localAppUrl: "http://127.0.0.1:8092/apps/panda/period-tracker/",
    });

    expect(resolveAgentAppUrls({
      agentKey: "panda",
      appSlug: "period-tracker",
      env: {
        PANDA_APPS_HOST: "0.0.0.0",
        PANDA_APPS_PORT: "8092",
        PANDA_APPS_INTERNAL_BASE_URL: "http://panda-core:8092",
      },
    })).toEqual({
      appPath: "/apps/panda/period-tracker/",
      appUrl: "http://panda-core:8092/apps/panda/period-tracker/",
      localAppUrl: "http://127.0.0.1:8092/apps/panda/period-tracker/",
      internalAppUrl: "http://panda-core:8092/apps/panda/period-tracker/",
    });
  });

  it("serves ui assets, bootstrap data, and wakes the main session for wake actions", async () => {
    const fixture = await createAgentAppFixture({
      actions: {
        increment: {
          mode: "native+wake",
          sql: "update counter set value = value + coalesce(:amount, 1)",
          wakeMessage: "Counter changed.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["amount"],
            properties: {
              amount: {
                type: "integer",
                minimum: 1,
              },
            },
          },
        },
      },
    });
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });
    const submitInput = vi.fn(async () => undefined);
    const server = await startAgentAppServer({
      host: "127.0.0.1",
      port: 0,
      service,
      sessionStore: {
        getMainSession: async () => ({
          id: "session-main",
          agentKey: fixture.agentKey,
          kind: "main",
          currentThreadId: "thread-main",
          createdAt: 1,
          updatedAt: 1,
        }),
        getSession: async (sessionId: string) => ({
          id: sessionId,
          agentKey: fixture.agentKey,
          kind: "branch",
          currentThreadId: "thread-branch",
          createdAt: 1,
          updatedAt: 1,
        }),
      },
      coordinator: {
        submitInput,
      },
    });
    servers.push(server);

    const baseUrl = `http://${server.host}:${server.port}`;

    const html = await fetch(`${baseUrl}/apps/${fixture.agentKey}/${fixture.appSlug}/`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Counter");

    const sdk = await fetch(`${baseUrl}/panda-app-sdk.js`);
    expect(sdk.status).toBe(200);
    expect(await sdk.text()).toContain("window.panda");

    const bootstrap = await fetch(`${baseUrl}/api/apps/${fixture.agentKey}/${fixture.appSlug}/bootstrap`);
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      ok: true,
      app: {
        slug: fixture.appSlug,
        actionNames: ["increment"],
        actions: [{
          name: "increment",
          mode: "native+wake",
          requiredInputKeys: ["amount"],
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["amount"],
            properties: {
              amount: {
                type: "integer",
                minimum: 1,
              },
            },
          },
        }],
      },
      context: {
        sessionId: "session-main",
      },
    });

    const action = await fetch(`${baseUrl}/api/apps/${fixture.agentKey}/${fixture.appSlug}/actions/increment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: {amount: 3},
      }),
    });
    expect(action.status).toBe(200);
    await expect(action.json()).resolves.toMatchObject({
      ok: true,
      actionName: "increment",
      changes: 1,
      wakeRequested: true,
    });
    expect(submitInput).toHaveBeenCalledTimes(1);
    expect(submitInput).toHaveBeenCalledWith("thread-main", expect.objectContaining({
      source: "app_http",
      channelId: fixture.appSlug,
      metadata: expect.objectContaining({
        kind: "app_action",
        appSlug: fixture.appSlug,
        actionName: "increment",
      }),
    }), "wake");

    const summary = await fetch(`${baseUrl}/api/apps/${fixture.agentKey}/${fixture.appSlug}/views/summary`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
    });
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({
      ok: true,
      items: [{count: 4}],
    });
  });

  it("rejects explicit sessions that belong to a different agent", async () => {
    const fixture = await createAgentAppFixture();
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });
    const getSession = vi.fn(async () => ({
      id: "session-luna",
      agentKey: "luna",
      kind: "main",
      currentThreadId: "thread-luna",
      createdAt: 1,
      updatedAt: 1,
    }));
    const getMainSession = vi.fn(async () => ({
      id: "session-panda",
      agentKey: fixture.agentKey,
      kind: "main",
      currentThreadId: "thread-panda",
      createdAt: 1,
      updatedAt: 1,
    }));

    const server = await startAgentAppServer({
      host: "127.0.0.1",
      port: 0,
      service,
      sessionStore: {
        getSession,
        getMainSession,
      },
    });
    servers.push(server);

    const baseUrl = `http://${server.host}:${server.port}`;
    const foreignSessionPath = `${baseUrl}/api/apps/${fixture.agentKey}/${fixture.appSlug}`;

    const bootstrap = await fetch(`${foreignSessionPath}/bootstrap?sessionId=session-luna`);
    expect(bootstrap.status).toBe(400);
    await expect(bootstrap.json()).resolves.toMatchObject({
      ok: false,
      error: "Session session-luna belongs to luna, not panda.",
    });

    const action = await fetch(`${foreignSessionPath}/actions/increment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: "session-luna",
        input: {amount: 1},
      }),
    });
    expect(action.status).toBe(400);
    await expect(action.json()).resolves.toMatchObject({
      ok: false,
      error: "Session session-luna belongs to luna, not panda.",
    });

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(getMainSession).not.toHaveBeenCalled();
  });
});
