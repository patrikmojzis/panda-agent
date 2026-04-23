import {afterEach, describe, expect, it, vi} from "vitest";

import {startAgentAppServer} from "../src/integrations/apps/http-server.js";
import {AgentAppService} from "../src/integrations/apps/sqlite-service.js";
import {type ExampleAppFixture, installExampleAppFixture} from "./helpers/example-app.js";

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

  it("ships an identity-scoped context capsule with search params and paginated review", async () => {
    const fixture = await installExampleAppFixture({
      slug: "context-capsule",
    });
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });

    const app = await service.getApp(fixture.agentKey, fixture.slug);
    expect(app.identityScoped).toBe(true);
    expect(app.actions.capture_card).toMatchObject({
      mode: "native+wake",
      inputSchema: {
        type: "object",
        required: ["captured_on", "kind", "title", "confidence"],
      },
    });

    await expect(
      service.executeView(fixture.agentKey, fixture.slug, "summary"),
    ).rejects.toThrow("requires identityId");

    const summary = await service.executeView(fixture.agentKey, fixture.slug, "summary", {
      identityId: "demo-identity",
    });
    expect(summary.items).toEqual([{
      active_cards: 4,
      due_for_review: 3,
      preferences: 1,
      total_cards: 4,
    }]);

    const styleCards = await service.executeView(fixture.agentKey, fixture.slug, "search_cards", {
      identityId: "demo-identity",
      params: {tag: "style"},
    });
    expect(styleCards.items).toHaveLength(2);

    const reviewPage = await service.executeView(fixture.agentKey, fixture.slug, "review_queue", {
      identityId: "demo-identity",
      pageSize: 2,
    });
    expect(reviewPage.items).toHaveLength(2);
    expect(reviewPage.page).toMatchObject({
      mode: "offset",
      limit: 2,
      offset: 0,
      hasMore: true,
      nextOffset: 2,
    });

    await expect(
      service.executeAction(fixture.agentKey, fixture.slug, "capture_card", {
        identityId: "demo-identity",
        input: {
          captured_on: "2026-04-23",
          kind: "mystery",
          title: "Invalid card",
          confidence: 4,
        },
      }),
    ).rejects.toThrow("input.kind must be one of");

    const wake = vi.fn(async () => undefined);
    const capture = await service.executeAction(fixture.agentKey, fixture.slug, "capture_card", {
      identityId: "demo-identity",
      input: {
        captured_on: "2026-04-23",
        kind: "project",
        title: "Use bootstrap before app context reads",
        details: "Public app links carry identity through the app session.",
        confidence: 5,
        tags: ["project", "follow-up"],
      },
      wake,
    });
    expect(capture).toMatchObject({
      changes: 1,
      mode: "native+wake",
      wakeRequested: true,
    });
    expect(wake).toHaveBeenCalledWith(expect.stringContaining("captured a project memory card titled Use bootstrap"));
    expect(wake.mock.calls[0]?.[0]).not.toContain("Input:\n{");
  });

  it("ships a shared ops radar with filtered pagination and multi-statement wake actions", async () => {
    const fixture = await installExampleAppFixture({
      slug: "ops-radar",
    });
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });

    const app = await service.getApp(fixture.agentKey, fixture.slug);
    expect(app.identityScoped).toBe(false);
    expect(app.actions.open_incident).toMatchObject({
      mode: "native+wake",
      inputSchema: {
        type: "object",
        required: ["opened_at", "title", "severity"],
      },
    });

    const summary = await service.executeView(fixture.agentKey, fixture.slug, "summary");
    expect(summary.items).toEqual([{
      active_critical: 0,
      active_incidents: 3,
      total_incidents: 4,
      watching: 1,
    }]);

    const investigating = await service.executeView(fixture.agentKey, fixture.slug, "incident_list", {
      params: {status: "investigating"},
    });
    expect(investigating.items).toHaveLength(1);
    expect(investigating.items[0]).toMatchObject({
      severity: "high",
      status: "investigating",
      title: "Telegram delivery lag above threshold",
    });

    const activity = await service.executeView(fixture.agentKey, fixture.slug, "activity_feed", {
      pageSize: 2,
    });
    expect(activity.items).toHaveLength(2);
    expect(activity.page).toMatchObject({
      hasMore: true,
      nextOffset: 2,
    });

    const wake = vi.fn(async () => undefined);
    const opened = await service.executeAction(fixture.agentKey, fixture.slug, "open_incident", {
      input: {
        opened_at: "2026-04-23",
        title: "Public app bootstrap context drift",
        severity: "critical",
        owner: "Panda",
        source: "manual",
        details: "The UI must use bootstrap context when app auth is enabled.",
      },
      wake,
    });
    expect(opened).toMatchObject({
      changes: 2,
      mode: "native+wake",
      wakeRequested: true,
    });
    expect(wake).toHaveBeenCalledWith(expect.stringContaining("A critical incident was opened"));

    const critical = await service.executeView(fixture.agentKey, fixture.slug, "incident_list", {
      params: {severity: "critical"},
    });
    expect(critical.items[0]).toMatchObject({
      severity: "critical",
      status: "investigating",
      title: "Public app bootstrap context drift",
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
