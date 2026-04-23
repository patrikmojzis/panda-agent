import {afterEach, describe, expect, it, vi} from "vitest";

import {startAgentAppServer} from "../src/integrations/apps/http-server.js";
import {AgentAppService} from "../src/integrations/apps/sqlite-service.js";
import {installExampleAppFixture, type ExampleAppFixture} from "./helpers/example-app.js";

describe("example apps", () => {
  const fixtures: ExampleAppFixture[] = [];
  const servers: Array<{close(): Promise<void>}> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it("ships a usable period tracker app with schema-backed validation", async () => {
    const fixture = await installExampleAppFixture({
      slug: "period-tracker",
    });
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });

    const app = await service.getApp(fixture.agentKey, fixture.slug);
    expect(app.identityScoped).toBe(true);
    expect(app.hasUi).toBe(true);
    expect(app.actions.log_entry).toMatchObject({
      mode: "native+wake",
      inputSchema: {
        type: "object",
        required: ["logged_on", "flow"],
      },
    });

    await expect(
      service.executeView(fixture.agentKey, fixture.slug, "summary"),
    ).rejects.toThrow("requires identityId");

    const summary = await service.executeView(fixture.agentKey, fixture.slug, "summary", {
      identityId: "angelina",
    });
    expect(summary.items).toEqual([{
      avg_energy: 3,
      entry_count: 3,
      heavy_days: 1,
      last_logged_on: "2026-04-20",
    }]);

    await expect(
      service.executeAction(fixture.agentKey, fixture.slug, "log_entry", {
        identityId: "angelina",
        input: {
          logged_on: "2026-04-22",
          flow: "nonsense",
        },
      }),
    ).rejects.toThrow("input.flow must be one of");

    const action = await service.executeAction(fixture.agentKey, fixture.slug, "log_entry", {
      identityId: "angelina",
      input: {
        logged_on: "2026-04-22",
        flow: "light",
        mood: "calm",
        energy: 4,
        symptoms: ["cramps", "bloating"],
        notes: "Handled by the app.",
      },
    });
    expect(action.changes).toBe(1);

    const recentEntries = await service.executeView(fixture.agentKey, fixture.slug, "recent_entries", {
      identityId: "angelina",
    });
    expect(recentEntries.items[0]).toMatchObject({
      logged_on: "2026-04-22",
      flow: "light",
      mood: "calm",
      energy: 4,
      notes: "Handled by the app.",
    });
    expect(recentEntries.items[0]?.symptoms_json).toBe("[\"cramps\",\"bloating\"]");
    expect(recentEntries.page).toMatchObject({
      mode: "offset",
      limit: 8,
      offset: 0,
      hasMore: false,
    });
  });

  it("wakes the main session when the period tracker logs through HTTP", async () => {
    const fixture = await installExampleAppFixture({
      slug: "period-tracker",
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
      identityStore: {
        getIdentityByHandle: async (handle: string) => ({
          id: handle === "angelina" ? "identity-angelina" : "identity-other",
          handle,
          displayName: handle,
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        }),
      },
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

    const response = await fetch(`http://${server.host}:${server.port}/api/apps/${fixture.agentKey}/${fixture.slug}/actions/log_entry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        identityHandle: "angelina",
        input: {
          logged_on: "2026-04-22",
          flow: "medium",
          mood: "calm",
          energy: 4,
          symptoms: ["cramps"],
          notes: "Wake test.",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      actionName: "log_entry",
      mode: "native+wake",
      changes: 1,
      wakeRequested: true,
    });
    expect(submitInput).toHaveBeenCalledTimes(1);
    expect(submitInput).toHaveBeenCalledWith("thread-main", expect.objectContaining({
      source: "app_http",
      channelId: fixture.slug,
      identityId: "identity-angelina",
      metadata: expect.objectContaining({
        kind: "app_action",
        appSlug: fixture.slug,
        actionName: "log_entry",
      }),
      message: expect.objectContaining({
        content: expect.stringContaining("The user logged a period entry for 2026-04-22 with flow medium"),
      }),
    }), "wake");
    const wakeMessage = submitInput.mock.calls[0]?.[1]?.message?.content;
    expect(wakeMessage).toContain("symptoms cramps");
    expect(wakeMessage).toContain("notes Wake test.");
    expect(wakeMessage).not.toContain("Input:\n{");
  });
});
