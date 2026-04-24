import path from "node:path";
import {link, mkdir, rm, symlink, writeFile} from "node:fs/promises";

import {afterEach, describe, expect, it, vi} from "vitest";

import {
  DEFAULT_APPS_PORT,
  resolveAgentAppUrls,
  resolveOptionalAgentAppServerBinding,
  startAgentAppServer,
} from "../src/integrations/apps/http-server.js";
import {buildAgentAppCookieNames, type AgentAppSessionRecord} from "../src/domain/apps/auth.js";
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
      appPath: "/panda/apps/period-tracker/",
      appUrl: "http://127.0.0.1:8092/panda/apps/period-tracker/",
      localAppUrl: "http://127.0.0.1:8092/panda/apps/period-tracker/",
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
      appPath: "/panda/apps/period-tracker/",
      appUrl: "http://panda-core:8092/panda/apps/period-tracker/",
      localAppUrl: "http://127.0.0.1:8092/panda/apps/period-tracker/",
      internalAppUrl: "http://panda-core:8092/panda/apps/period-tracker/",
    });
  });

  it("rejects unsafe public app URL and cookie settings", async () => {
    expect(buildAgentAppCookieNames("a_b", "c")).not.toEqual(buildAgentAppCookieNames("a", "b_c"));

    expect(() => resolveAgentAppUrls({
      agentKey: "panda",
      appSlug: "period-tracker",
      env: {
        PANDA_APPS_BASE_URL: "http://panda.example.com",
      },
    })).toThrow("PANDA_APPS_BASE_URL must use https://");

    expect(() => resolveAgentAppUrls({
      agentKey: "panda",
      appSlug: "period-tracker",
      env: {
        PANDA_APPS_BASE_URL: "https://panda.example.com/nested",
      },
    })).toThrow("PANDA_APPS_BASE_URL must be a plain origin");

    const fixture = await createAgentAppFixture();
    fixtures.push(fixture);
    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });

    await expect(startAgentAppServer({
      host: "127.0.0.1",
      port: 0,
      service,
      auth: {
        createLaunchToken: vi.fn(),
        redeemLaunchToken: vi.fn(),
        getSessionByToken: vi.fn(),
        verifyCsrfToken: vi.fn(),
      },
      env: {
        PANDA_APPS_BASE_URL: "https://panda.example.com",
        PANDA_APPS_COOKIE_SECURE: "false",
      },
    })).rejects.toThrow("PANDA_APPS_COOKIE_SECURE=false is only allowed for local app hosts");

    expect(resolveAgentAppUrls({
      agentKey: "panda",
      appSlug: "period-tracker",
      env: {
        PANDA_APPS_BASE_URL: "http://127.0.0.1:8092",
      },
    }).appUrl).toBe("http://127.0.0.1:8092/panda/apps/period-tracker/");
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

    const html = await fetch(`${baseUrl}/${fixture.agentKey}/apps/${fixture.appSlug}/`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Counter");

    const sdk = await fetch(`${baseUrl}/panda-app-sdk.js`);
    expect(sdk.status).toBe(200);
    expect(await sdk.text()).toContain("window.panda");

    const bootstrap = await fetch(`${baseUrl}/api/apps/${fixture.agentKey}/${fixture.appSlug}/bootstrap`);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("cache-control")).toBe("no-store");
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

  it("rejects oversized app API JSON bodies before parsing them", async () => {
    const fixture = await createAgentAppFixture();
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });
    const server = await startAgentAppServer({
      host: "127.0.0.1",
      port: 0,
      service,
    });
    servers.push(server);

    const baseUrl = `http://${server.host}:${server.port}`;
    const action = await fetch(`${baseUrl}/api/apps/${fixture.agentKey}/${fixture.appSlug}/actions/increment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: {
          amount: 1,
          blob: "x".repeat(300_000),
        },
      }),
    });

    expect(action.status).toBe(413);
    await expect(action.json()).resolves.toMatchObject({
      ok: false,
      error: "App request body is too large.",
    });
  });

  it("does not serve static assets through symlinks that escape public", async () => {
    const fixture = await createAgentAppFixture();
    fixtures.push(fixture);

    const secretPath = path.join(fixture.appDir, "secret.txt");
    await writeFile(secretPath, "not for static serving");
    await symlink(secretPath, path.join(fixture.appDir, "public", "leak.txt"));

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });
    const server = await startAgentAppServer({
      host: "127.0.0.1",
      port: 0,
      service,
    });
    servers.push(server);

    const baseUrl = `http://${server.host}:${server.port}`;
    const leaked = await fetch(`${baseUrl}/${fixture.agentKey}/apps/${fixture.appSlug}/leak.txt`);
    expect(leaked.status).toBe(404);
    await expect(leaked.json()).resolves.toMatchObject({
      ok: false,
      error: "Static asset not found.",
    });
  });

  it("does not serve apps whose public directory symlink escapes the app", async () => {
    const fixture = await createAgentAppFixture({appSlug: "symlink-public"});
    fixtures.push(fixture);

    const publicDir = path.join(fixture.appDir, "public");
    const outsidePublicDir = path.join(fixture.dataDir, "outside-public");
    await rm(publicDir, {recursive: true, force: true});
    await mkdir(outsidePublicDir, {recursive: true});
    await writeFile(path.join(outsidePublicDir, "index.html"), "<!doctype html><p>escaped</p>");
    await symlink(outsidePublicDir, publicDir, "dir");

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });
    const server = await startAgentAppServer({
      host: "127.0.0.1",
      port: 0,
      service,
    });
    servers.push(server);

    const baseUrl = `http://${server.host}:${server.port}`;
    const escaped = await fetch(`${baseUrl}/${fixture.agentKey}/apps/${fixture.appSlug}/`);
    expect(escaped.status).toBe(404);
    await expect(escaped.json()).resolves.toMatchObject({
      ok: false,
      error: "Static asset not found.",
    });
  });

  it("does not serve static assets through hardlinks to files outside public", async () => {
    const fixture = await createAgentAppFixture();
    fixtures.push(fixture);

    const secretPath = path.join(fixture.appDir, "hardlink-secret.txt");
    await writeFile(secretPath, "not for static serving");
    await link(secretPath, path.join(fixture.appDir, "public", "hardlink.txt"));

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });
    const server = await startAgentAppServer({
      host: "127.0.0.1",
      port: 0,
      service,
    });
    servers.push(server);

    const baseUrl = `http://${server.host}:${server.port}`;
    const leaked = await fetch(`${baseUrl}/${fixture.agentKey}/apps/${fixture.appSlug}/hardlink.txt`);
    expect(leaked.status).toBe(404);
    await expect(leaked.json()).resolves.toMatchObject({
      ok: false,
      error: "Static asset not found.",
    });
  });

  it("does not let X-Forwarded-For spoof app rate limits", async () => {
    const fixture = await createAgentAppFixture();
    fixtures.push(fixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });
    const server = await startAgentAppServer({
      host: "127.0.0.1",
      port: 0,
      service,
      rateLimitPerMinute: 1,
    });
    servers.push(server);

    const baseUrl = `http://${server.host}:${server.port}`;
    const first = await fetch(`${baseUrl}/health`, {
      headers: {"x-forwarded-for": "198.51.100.1"},
    });
    expect(first.status).toBe(200);

    const spoofed = await fetch(`${baseUrl}/health`, {
      headers: {"x-forwarded-for": "198.51.100.2"},
    });
    expect(spoofed.status).toBe(429);
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

  it("can require one-time app links, app cookies, and csrf for public mode", async () => {
    const fixture = await createAgentAppFixture();
    fixtures.push(fixture);
    const otherFixture = await createAgentAppFixture({
      dataDir: fixture.dataDir,
      appSlug: "journal",
      name: "Journal",
    });
    fixtures.push(otherFixture);

    const service = new AgentAppService({
      env: {...process.env, DATA_DIR: fixture.dataDir},
    });
    const session: AgentAppSessionRecord = {
      id: "app-session-1",
      agentKey: fixture.agentKey,
      appSlug: fixture.appSlug,
      identityId: "identity-patrik",
      sessionId: "session-main",
      csrfTokenHash: "fake-hash",
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    const otherSession: AgentAppSessionRecord = {
      ...session,
      id: "app-session-2",
      appSlug: otherFixture.appSlug,
      csrfTokenHash: "fake-hash-2",
    };
    const auth = {
      createLaunchToken: vi.fn(),
      redeemLaunchToken: vi.fn(async () => ({
        session,
        sessionToken: "session-token",
        csrfToken: "csrf-token",
      })),
      getSessionByToken: vi.fn(async (token: string) => {
        if (token === "session-token") {
          return session;
        }
        if (token === "other-session-token") {
          return otherSession;
        }
        return null;
      }),
      verifyCsrfToken: vi.fn((record: AgentAppSessionRecord, token: string) => {
        return record.id === otherSession.id ? token === "other-csrf-token" : token === "csrf-token";
      }),
    };
    const server = await startAgentAppServer({
      host: "127.0.0.1",
      port: 0,
      service,
      auth,
      authMode: "required",
      cookieSecure: false,
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
          kind: "main",
          currentThreadId: "thread-main",
          createdAt: 1,
          updatedAt: 1,
        }),
      },
    });
    servers.push(server);

    const baseUrl = `http://${server.host}:${server.port}`;
    const appPath = `/${fixture.agentKey}/apps/${fixture.appSlug}/`;
    const cookieNames = buildAgentAppCookieNames(fixture.agentKey, fixture.appSlug);
    const otherCookieNames = buildAgentAppCookieNames(otherFixture.agentKey, otherFixture.appSlug);

    const denied = await fetch(`${baseUrl}${appPath}`);
    expect(denied.status).toBe(401);

    const preview = await fetch(`${baseUrl}/apps/open?token=launch-token`, {
      redirect: "manual",
    });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("Open Panda app");
    expect(auth.redeemLaunchToken).not.toHaveBeenCalled();

    auth.redeemLaunchToken.mockRejectedValueOnce(new Error("App launch link is invalid, expired, or already used."));
    const invalidOpen = await fetch(`${baseUrl}/apps/open?token=bad-launch-token`, {
      method: "POST",
      redirect: "manual",
    });
    expect(invalidOpen.status).toBe(401);
    await expect(invalidOpen.json()).resolves.toMatchObject({
      ok: false,
      error: "App launch link is invalid, expired, or already used.",
    });

    const opened = await fetch(`${baseUrl}/apps/open?token=launch-token`, {
      method: "POST",
      redirect: "manual",
    });
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe(appPath);
    expect(opened.headers.get("set-cookie")).toContain(cookieNames.session);
    expect(opened.headers.get("set-cookie")).toContain(cookieNames.csrf);
    expect(opened.headers.get("set-cookie")).toContain(`Path=/${fixture.agentKey}/apps/${fixture.appSlug}`);
    expect(auth.redeemLaunchToken).toHaveBeenCalledTimes(2);

    const cookie = `${cookieNames.session}=session-token; ${cookieNames.csrf}=csrf-token`;
    const html = await fetch(`${baseUrl}${appPath}`, {
      headers: {cookie},
    });
    expect(html.status).toBe(200);

    const missingBootstrapCsrf = await fetch(`${baseUrl}/api/apps/${fixture.agentKey}/${fixture.appSlug}/bootstrap`, {
      headers: {cookie},
    });
    expect(missingBootstrapCsrf.status).toBe(403);

    const bootstrap = await fetch(`${baseUrl}/api/apps/${fixture.agentKey}/${fixture.appSlug}/bootstrap`, {
      headers: {
        "x-panda-app-csrf": "csrf-token",
        cookie,
      },
    });
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      ok: true,
      context: {
        authenticated: true,
        identityId: "identity-patrik",
        sessionId: "session-main",
      },
    });

    const missingCsrf = await fetch(`${baseUrl}/api/apps/${fixture.agentKey}/${fixture.appSlug}/actions/increment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        input: {amount: 1},
      }),
    });
    expect(missingCsrf.status).toBe(403);

    const crossAppCookie = `${cookie}; ${otherCookieNames.session}=other-session-token`;
    const crossAppView = await fetch(`${baseUrl}/api/apps/${otherFixture.agentKey}/${otherFixture.appSlug}/views/summary`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-panda-app-csrf": "csrf-token",
        cookie: crossAppCookie,
      },
      body: JSON.stringify({}),
    });
    expect(crossAppView.status).toBe(403);

    const otherView = await fetch(`${baseUrl}/api/apps/${otherFixture.agentKey}/${otherFixture.appSlug}/views/summary`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-panda-app-csrf": "other-csrf-token",
        cookie: `${otherCookieNames.session}=other-session-token; ${otherCookieNames.csrf}=other-csrf-token`,
      },
      body: JSON.stringify({}),
    });
    expect(otherView.status).toBe(200);

    const action = await fetch(`${baseUrl}/api/apps/${fixture.agentKey}/${fixture.appSlug}/actions/increment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-panda-app-csrf": "csrf-token",
        cookie,
      },
      body: JSON.stringify({
        input: {amount: 2},
      }),
    });
    expect(action.status).toBe(200);
    await expect(action.json()).resolves.toMatchObject({
      ok: true,
      changes: 1,
    });
  });
});
