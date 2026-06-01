import {mkdtemp, rm, writeFile, mkdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach, describe, expect, it, vi} from "vitest";

// This file boots several pg-mem-backed integration harnesses and local HTTP servers.
// Keep the timeout explicit so the default Vitest 5s limit does not make CI/load-dependent runs flaky.
vi.setConfig({testTimeout: 30_000});
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {PostgresCredentialStore} from "../src/domain/credentials/postgres.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/postgres.js";
import {PostgresControlAuthService} from "../src/domain/control/auth.js";
import {ControlReadService} from "../src/domain/control/read-service.js";
import {ControlHomeService} from "../src/domain/control/home-service.js";
import {ControlBriefingService} from "../src/domain/control/briefing-service.js";
import {ControlHeartbeatService} from "../src/domain/control/heartbeat-service.js";
import {ControlTodoService} from "../src/domain/control/todo-service.js";
import {ControlScheduledTasksService} from "../src/domain/control/scheduled-tasks-service.js";
import {ControlWatchesService} from "../src/domain/control/watches-service.js";
import {ControlRuntimeActivityService} from "../src/domain/control/runtime-activity-service.js";
import {ControlConnectorAccountsService} from "../src/domain/control/connector-accounts-service.js";
import {PostgresConnectorAccountStore} from "../src/domain/connectors/postgres.js";
import {PostgresWatchStore} from "../src/domain/watches/postgres.js";
import {PostgresScheduledTaskStore} from "../src/domain/scheduling/tasks/postgres.js";
import {CONTROL_CSRF_COOKIE, CONTROL_SESSION_COOKIE, startControlServer, type ControlHttpServer} from "../src/integrations/control/http-server.js";

const pools: Array<{end(): Promise<void>}> = [];
const servers: ControlHttpServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (pools.length > 0) await pools.pop()?.end();
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, {recursive: true, force: true});
});

async function createHarness() {
  const db = newDb({noAstCoverageCheck: true});
  db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  pools.push(pool);

  const identities = new PostgresIdentityStore({pool});
  const agents = new PostgresAgentStore({pool});
  const sessions = new PostgresSessionStore({pool});
  const credentials = new PostgresCredentialStore({pool});
  const threads = new PostgresThreadRuntimeStore({pool});
  const auth = new PostgresControlAuthService({pool});
  const reads = new ControlReadService({pool});
  const home = new ControlHomeService({pool, reads});
  const briefings = new ControlBriefingService({pool, sessions});
  const heartbeats = new ControlHeartbeatService({pool, sessions});
  const todos = new ControlTodoService({pool, sessions});
  const scheduledTaskStore = new PostgresScheduledTaskStore({pool});
  const watchStore = new PostgresWatchStore({pool});
  const controlScheduledTasks = new ControlScheduledTasksService({pool});
  const controlWatches = new ControlWatchesService({pool});
  const controlRuntimeActivity = new ControlRuntimeActivityService({pool});
  const connectorAccountStore = new PostgresConnectorAccountStore({pool});
  const controlConnectorAccounts = new ControlConnectorAccountsService({pool});
  await identities.ensureSchema();
  await agents.ensureSchema();
  await sessions.ensureSchema();
  await threads.ensureSchema();
  await credentials.ensureSchema();
  await auth.ensureSchema();
  await scheduledTaskStore.ensureSchema();
  await watchStore.ensureSchema();
  await connectorAccountStore.ensureSchema();

  await identities.createIdentity({id: "identity-patrik", handle: "patrik", displayName: "Patrik"});
  await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda", prompts: DEFAULT_AGENT_PROMPT_TEMPLATES});
  await agents.bootstrapAgent({agentKey: "luna", displayName: "Luna", prompts: DEFAULT_AGENT_PROMPT_TEMPLATES});
  await sessions.createSessionRecord({id: "session-panda", agentKey: "panda", kind: "main", currentThreadId: "thread-panda", createdByIdentityId: "identity-patrik"});
  await sessions.createSessionRecord({id: "session-luna", agentKey: "luna", kind: "main", currentThreadId: "thread-luna", createdByIdentityId: "identity-patrik"});
  await pool.query(`
    INSERT INTO "runtime"."credentials" (id, env_key, agent_key, value_ciphertext, value_iv, value_tag, key_version)
    VALUES ('00000000-0000-0000-0000-000000000001', 'API_TOKEN', 'panda', '\\x5345435245545f53454e54494e454c', '\\x6976', '\\x746167', 1)
  `);
  return {pool, agents, sessions, auth, reads, home, briefings, heartbeats, todos, scheduledTaskStore, watchStore, connectorAccountStore, controlScheduledTasks, controlWatches, controlRuntimeActivity, controlConnectorAccounts};
}

async function startHarnessServer(harness: Awaited<ReturnType<typeof createHarness>>) {
  const server = await startControlServer({host: "127.0.0.1", port: 0, auth: harness.auth, reads: harness.reads, home: harness.home, briefings: harness.briefings, heartbeats: harness.heartbeats, todos: harness.todos, scheduledTasks: harness.controlScheduledTasks, watches: harness.controlWatches, runtimeActivity: harness.controlRuntimeActivity, connectorAccounts: harness.controlConnectorAccounts});
  servers.push(server);
  return `http://${server.host}:${server.port}`;
}

function setCookieHeaders(response: Response): string[] {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw.length > 0 ? raw : [response.headers.get("set-cookie") ?? ""];
}

function cookieHeader(response: Response): string {
  return setCookieHeaders(response).map((cookie) => cookie.split(";")[0]).filter(Boolean).join("; ");
}

describe("Control auth HTTP", () => {
  it("fails closed before login and reports bootstrap grant state", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);

    expect((await fetch(`${base}/api/control/bootstrap`)).status).toBe(200);
    await expect((await fetch(`${base}/api/control/bootstrap`)).json()).resolves.toEqual({hasGrant: false});
    expect((await fetch(`${base}/api/control/me`)).status).toBe(401);

    await harness.auth.createGrant({identityId: "identity-patrik", role: "admin"});
    await expect((await fetch(`${base}/api/control/bootstrap`)).json()).resolves.toEqual({hasGrant: true});
  });

  it("rejects expired Control login tokens", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role: "admin"});
    await harness.pool.query(`
      UPDATE "runtime"."control_grants"
      SET login_token_expires_at = NOW() - INTERVAL '1 minute'
      WHERE id = $1
    `, [grant.grant.id]);

    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({error: "Control login token is invalid, expired, or already used."});
  });

  it("logs in with an explicit grant, requires CSRF for logout, and exposes no secret credential values", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role: "admin"});

    const login = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(login.status).toBe(200);
    const loginBody = await login.json() as {csrfToken: string};
    const cookies = cookieHeader(login);
    const setCookies = setCookieHeaders(login);
    expect(cookies).toContain(CONTROL_SESSION_COOKIE);
    expect(setCookies.find((cookie) => cookie.startsWith(`${CONTROL_SESSION_COOKIE}=`))).toContain("HttpOnly");
    expect(setCookies.find((cookie) => cookie.startsWith(`${CONTROL_SESSION_COOKIE}=`))).toContain("Path=/api/control");
    expect(setCookies.find((cookie) => cookie.startsWith(`${CONTROL_CSRF_COOKIE}=`))).not.toContain("HttpOnly");
    expect(setCookies.find((cookie) => cookie.startsWith(`${CONTROL_CSRF_COOKIE}=`))).toContain("Path=/");
    const reused = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(reused.status).toBe(401);
    await expect(reused.json()).resolves.toEqual({error: "Control login token is invalid, expired, or already used."});

    expect((await fetch(`${base}/api/control/logout`, {method: "POST", headers: {cookie: cookies}})).status).toBe(403);
    const credentials = await fetch(`${base}/api/control/credentials`, {headers: {cookie: cookies}});
    expect(credentials.status).toBe(200);
    const text = JSON.stringify(await credentials.json());
    expect(text).toContain("API_TOKEN");
    expect(text).not.toContain("SECRET_SENTINEL");
    expect(text).not.toContain("5345435245545f53454e54494e454c");

    const logout = await fetch(`${base}/api/control/logout`, {method: "POST", headers: {cookie: cookies, "x-control-csrf": loginBody.csrfToken}});
    expect(logout.status).toBe(200);
    const clearedCookies = setCookieHeaders(logout);
    expect(clearedCookies.find((cookie) => cookie.startsWith(`${CONTROL_SESSION_COOKIE}=`))).toContain("HttpOnly");
    expect(clearedCookies.find((cookie) => cookie.startsWith(`${CONTROL_SESSION_COOKIE}=`))).toContain("Path=/api/control");
    expect(clearedCookies.find((cookie) => cookie.startsWith(`${CONTROL_CSRF_COOKIE}=`))).not.toContain("HttpOnly");
    expect(clearedCookies.find((cookie) => cookie.startsWith(`${CONTROL_CSRF_COOKIE}=`))).toContain("Path=/");
    expect((await fetch(`${base}/api/control/me`, {headers: {cookie: cookies}})).status).toBe(401);
  });

  it("does not expose unexpected internal error messages over HTTP", async () => {
    const harness = await createHarness();
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role: "admin"});
    const login = await harness.auth.loginWithToken(grant.loginToken);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await startControlServer({
      host: "127.0.0.1",
      port: 0,
      auth: harness.auth,
      home: harness.home,
      reads: {
        getOverview: async () => {
          throw new Error("database password leaked in stack");
        },
        listAgents: harness.reads.listAgents.bind(harness.reads),
        listCredentials: harness.reads.listCredentials.bind(harness.reads),
        listAuditEvents: harness.reads.listAuditEvents.bind(harness.reads),
      } as ControlReadService,
      briefings: harness.briefings,
      heartbeats: harness.heartbeats,
      todos: harness.todos,
      scheduledTasks: harness.controlScheduledTasks,
      watches: harness.controlWatches,
      runtimeActivity: harness.controlRuntimeActivity,
      connectorAccounts: harness.controlConnectorAccounts,
    });
    servers.push(server);

    const response = await fetch(`http://${server.host}:${server.port}/api/control/overview`, {
      headers: {cookie: `${CONTROL_SESSION_COOKIE}=${login.sessionToken}`},
    });
    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).toBe(JSON.stringify({error: "internal_error"}));
    expect(text).not.toContain("database password");
    expect(errorSpy).toHaveBeenCalledWith("Control HTTP request failed", {error: "internal_error"});
    errorSpy.mockRestore();
  });


  it("serves Control UI static assets for non-API paths without falling API paths through to the SPA", async () => {
    const harness = await createHarness();
    const staticDir = await mkdtemp(join(tmpdir(), "panda-control-ui-"));
    tempDirs.push(staticDir);
    await mkdir(join(staticDir, "assets"));
    await writeFile(join(staticDir, "index.html"), `<div id="root">Control UI shell</div>`);
    await writeFile(join(staticDir, "assets", "app.js"), "console.log('control-ui');");
    const server = await startControlServer({host: "127.0.0.1", port: 0, auth: harness.auth, reads: harness.reads, home: harness.home, briefings: harness.briefings, heartbeats: harness.heartbeats, todos: harness.todos, scheduledTasks: harness.controlScheduledTasks, watches: harness.controlWatches, runtimeActivity: harness.controlRuntimeActivity, connectorAccounts: harness.controlConnectorAccounts, uiStaticDir: staticDir});
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;

    const app = await fetch(`${base}/agents`);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("text/html");
    await expect(app.text()).resolves.toContain("Control UI shell");

    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    await expect(asset.text()).resolves.toContain("control-ui");

    const api = await fetch(`${base}/api/control/health`);
    expect(api.status).toBe(200);
    expect(api.headers.get("content-type")).toContain("application/json");
    await expect(api.json()).resolves.toEqual({ok: true});

    const nonControlApi = await fetch(`${base}/api/not-control`);
    expect(nonControlApi.status).toBe(404);
    expect(nonControlApi.headers.get("content-type")).toContain("application/json");
    await expect(nonControlApi.json()).resolves.toEqual({error: "not_found"});
  });

  it("counts scoped running runs through agent_sessions instead of a nonexistent thread agent column", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const scopedGrant = await harness.auth.createGrant({identityId: "identity-patrik", role: "scoped", agentKey: "panda"});
    const scopedSession = (await harness.auth.loginWithToken(scopedGrant.loginToken)).session;
    await harness.pool.query(`
      INSERT INTO "runtime"."threads" (id, session_id) VALUES
        ('thread-running-panda', 'session-panda'),
        ('thread-running-luna', 'session-luna')
    `);
    await harness.pool.query(`
      INSERT INTO "runtime"."runs" (id, thread_id, status, started_at) VALUES
        ('00000000-0000-0000-0000-000000000201', 'thread-running-panda', 'running', NOW()),
        ('00000000-0000-0000-0000-000000000202', 'thread-running-luna', 'running', NOW())
    `);

    await expect(harness.reads.getOverview(scopedSession)).resolves.toMatchObject({runningRuns: 1});
  });

  it("limits scoped visibility to agents with both Control grant and identity pairing", async () => {
    const harness = await createHarness();
    const adminGrant = await harness.auth.createGrant({identityId: "identity-patrik", role: "admin"});
    const adminSession = (await harness.auth.loginWithToken(adminGrant.loginToken)).session;
    await expect(harness.reads.listAgents(adminSession)).resolves.toHaveLength(2);

    const scopedGrant = await harness.auth.createGrant({identityId: "identity-patrik", role: "scoped", agentKey: "panda"});
    const scopedSession = (await harness.auth.loginWithToken(scopedGrant.loginToken)).session;
    await expect(harness.reads.listAgents(scopedSession)).resolves.toEqual([]);

    await harness.agents.ensurePairing("panda", "identity-patrik");
    await expect(harness.reads.listAgents(scopedSession)).resolves.toMatchObject([{agentKey: "panda"}]);
  });
});

describe("Control audit events HTTP", () => {
  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>, role: "admin" | "scoped" = "admin", agentKey = "panda") {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role, ...(role === "scoped" ? {agentKey} : {})});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    const body = await response.json() as {csrfToken: string};
    return {cookies: cookieHeader(response), csrfToken: body.csrfToken};
  }

  it("allows admin to list login and write audit events with sanitized metadata", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "admin");

    const write = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/briefing`, {
      method: "PUT",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({content: "private briefing body must not leave audit API"}),
    });
    expect(write.status).toBe(200);

    const response = await fetch(`${base}/api/control/audit-events?limit=10`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {auditEvents: Array<{eventType: string; metadata: Record<string, unknown>}>};
    expect(body.auditEvents.some((event) => event.eventType === "login")).toBe(true);
    const briefing = body.auditEvents.find((event) => event.eventType === "session_briefing_write");
    expect(briefing?.metadata).toMatchObject({action: "put", agentKey: "panda", targetSessionId: "session-panda", slug: "session"});
    expect(JSON.stringify(briefing)).toContain("sha256");
    expect(JSON.stringify(briefing)).toContain("length");
    expect(JSON.stringify(body)).not.toContain("private briefing body");
  });

  it("prevents scoped users from seeing another identity or invisible-agent audit event", async () => {
    const harness = await createHarness();
    await harness.pool.query(`INSERT INTO "runtime"."identities" (id, handle, display_name) VALUES ('identity-other', 'other', 'Other')`);
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.agents.ensurePairing("luna", "identity-other");
    await harness.auth.recordAudit({identityId: "identity-other", eventType: "session_briefing_write", metadata: {action: "put", agentKey: "luna", targetSessionId: "session-luna", secret: "hidden-other"}});
    await harness.auth.recordAudit({identityId: "identity-patrik", eventType: "session_briefing_write", metadata: {action: "put", agentKey: "luna", targetSessionId: "session-luna", secret: "hidden-luna"}});
    await harness.auth.recordAudit({identityId: "identity-patrik", eventType: "unknown_event", metadata: {agentKey: "panda", secret: "hidden-visible-agent-unknown"}});
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");

    const response = await fetch(`${base}/api/control/audit-events?limit=20`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("identity-other");
    expect(text).not.toContain("hidden-other");
    expect(text).not.toContain("hidden-luna");
    expect(text).not.toContain("session-luna");
    expect(text).not.toContain("unknown_event");
    expect(text).not.toContain("hidden-visible-agent-unknown");
  });

  it("allows scoped users to see their own visible-agent mutation audit event", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");

    const saved = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/heartbeat`, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({enabled: true, everyMinutes: 30, confirm: "update-heartbeat"}),
    });
    expect(saved.status).toBe(200);

    const response = await fetch(`${base}/api/control/audit-events?limit=20`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {auditEvents: Array<{eventType: string; metadata: Record<string, unknown>}>};
    const heartbeat = body.auditEvents.find((event) => event.eventType === "session_heartbeat_config_write");
    expect(heartbeat?.metadata).toMatchObject({action: "patch", agentKey: "panda", targetSessionId: "session-panda"});
    expect(JSON.stringify(heartbeat)).toContain("everyMinutes");
    expect(JSON.stringify(heartbeat)).toContain("nextFireAt");
  });

  it("does not return arbitrary or unknown audit metadata fields", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "admin");
    await harness.auth.recordAudit({identityId: "identity-patrik", eventType: "session_briefing_write", metadata: {action: "put", agentKey: "panda", targetSessionId: "session-panda", slug: "session", token: "secret-token", prompt: "private prompt", old: {wasSet: false, length: 0, sha256: null, raw: "old"}, next: {wasSet: true, length: 12, sha256: "abc", content: "next"}}});
    await harness.auth.recordAudit({identityId: "identity-patrik", eventType: "unknown_event", metadata: {token: "unknown-secret", arbitrary: {nested: true}}});

    const response = await fetch(`${base}/api/control/audit-events?limit=20`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {auditEvents: Array<{eventType: string; metadata: Record<string, unknown>}>};
    expect(body.auditEvents.find((event) => event.eventType === "unknown_event")?.metadata).toEqual({});
    const text = JSON.stringify(body);
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("private prompt");
    expect(text).not.toContain("unknown-secret");
    expect(text).not.toContain("arbitrary");
    expect(text).not.toContain("content");
    expect(text).not.toContain("raw");
  });
});


describe("Control session briefing HTTP", () => {
  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>, role: "admin" | "scoped" = "scoped") {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role, ...(role === "scoped" ? {agentKey: "panda"} : {})});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    const body = await response.json() as {csrfToken: string};
    return {cookies: cookieHeader(response), csrfToken: body.csrfToken};
  }

  it("reads, writes, clears, and audits only redacted session briefing summaries", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);
    const path = `${base}/api/control/agents/panda/sessions/session-panda/briefing`;

    const empty = await fetch(path, {headers: {cookie: auth.cookies}});
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({briefing: {agentKey: "panda", sessionId: "session-panda", slug: "session", content: "", wasSet: false}});

    const missingCsrf = await fetch(path, {method: "PUT", headers: {cookie: auth.cookies}, body: JSON.stringify({content: "do not save"})});
    expect(missingCsrf.status).toBe(403);

    const blank = await fetch(path, {method: "PUT", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({content: "   "})});
    expect(blank.status).toBe(400);
    await expect(blank.json()).resolves.toEqual({error: "Session briefing content must not be blank. Use clear to delete the briefing."});

    const saved = await fetch(path, {method: "PUT", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({content: "  private briefing text  "})});
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({briefing: {content: "private briefing text", wasSet: true}});

    const deleteWithoutConfirm = await fetch(path, {method: "DELETE", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({confirm: "wrong"})});
    expect(deleteWithoutConfirm.status).toBe(400);

    const cleared = await fetch(path, {method: "DELETE", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({confirm: "clear-session-briefing"})});
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({briefing: {content: "", wasSet: false}});

    const audit = await harness.pool.query(`SELECT event_type, metadata::text AS metadata FROM "runtime"."control_audit_events" WHERE event_type = 'session_briefing_write' ORDER BY created_at ASC`);
    expect(audit.rows).toHaveLength(2);
    const auditText = JSON.stringify(audit.rows);
    expect(auditText).toContain("sha256");
    expect(auditText).toContain("length");
    expect(auditText).not.toContain("private briefing text");
    expect(auditText).not.toContain("do not save");
  });


  it("allows admin to access an unpaired session while scoped still requires pairing", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");
    const scoped = await login(base, harness, "scoped");

    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/briefing`, {headers: {cookie: admin.cookies}})).status).toBe(200);
    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/briefing`, {headers: {cookie: scoped.cookies}})).status).toBe(404);
  });

  it("allows admin to access an unpaired heartbeat while scoped still requires pairing", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");
    const scoped = await login(base, harness, "scoped");

    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/heartbeat`, {headers: {cookie: admin.cookies}})).status).toBe(200);
    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/heartbeat`, {headers: {cookie: scoped.cookies}})).status).toBe(404);
  });

  it("requires both Control grant visibility and identity-agent pairing, and checks session belongs to path agent", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const noPairing = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/briefing`, {headers: {cookie: auth.cookies}});
    expect(noPairing.status).toBe(404);

    await harness.agents.ensurePairing("panda", "identity-patrik");
    const visible = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/briefing`, {headers: {cookie: auth.cookies}});
    expect(visible.status).toBe(200);

    const wrongAgent = await fetch(`${base}/api/control/agents/luna/sessions/session-panda/briefing`, {headers: {cookie: auth.cookies}});
    expect(wrongAgent.status).toBe(404);

    await harness.agents.ensurePairing("luna", "identity-patrik");
    const noScopedGrant = await fetch(`${base}/api/control/agents/luna/sessions/session-luna/briefing`, {headers: {cookie: auth.cookies}});
    expect(noScopedGrant.status).toBe(404);
  });
});


describe("Control session heartbeat HTTP", () => {
  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>, role: "admin" | "scoped" = "scoped") {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role, ...(role === "scoped" ? {agentKey: "panda"} : {})});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    const body = await response.json() as {csrfToken: string};
    return {cookies: cookieHeader(response), csrfToken: body.csrfToken};
  }

  it("reads, updates, rejects unsafe fields, enforces CSRF/min cadence, and audits redacted heartbeat metadata", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);
    const path = `${base}/api/control/agents/panda/sessions/session-panda/heartbeat`;

    const initial = await fetch(path, {headers: {cookie: auth.cookies}});
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({heartbeat: {agentKey: "panda", sessionId: "session-panda", enabled: true, everyMinutes: 60}});

    const missingCsrf = await fetch(path, {method: "PATCH", headers: {cookie: auth.cookies}, body: JSON.stringify({enabled: true, everyMinutes: 30, confirm: "update-heartbeat"})});
    expect(missingCsrf.status).toBe(403);
    expect(await harness.sessions.getHeartbeat("session-panda")).toMatchObject({enabled: true, everyMinutes: 60});

    const tooFast = await fetch(path, {method: "PATCH", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({everyMinutes: 5, confirm: "update-heartbeat"})});
    expect(tooFast.status).toBe(400);
    expect(await harness.sessions.getHeartbeat("session-panda")).toMatchObject({enabled: true, everyMinutes: 60});

    const unknown = await fetch(path, {method: "PATCH", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({enabled: true, everyMinutes: 30, confirm: "update-heartbeat", nextFireAt: "2099-01-01T00:00:00.000Z", fireNow: true})});
    expect(unknown.status).toBe(400);
    expect(await harness.sessions.getHeartbeat("session-panda")).toMatchObject({enabled: true, everyMinutes: 60});

    const missingConfirm = await fetch(path, {method: "PATCH", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({enabled: true, everyMinutes: 30})});
    expect(missingConfirm.status).toBe(400);
    expect(await harness.sessions.getHeartbeat("session-panda")).toMatchObject({enabled: true, everyMinutes: 60});

    const disableWithoutConfirm = await fetch(path, {method: "PATCH", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({enabled: false})});
    expect(disableWithoutConfirm.status).toBe(400);
    expect(await harness.sessions.getHeartbeat("session-panda")).toMatchObject({enabled: true, everyMinutes: 60});

    const saved = await fetch(path, {method: "PATCH", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({enabled: true, everyMinutes: 30, confirm: "update-heartbeat"})});
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({heartbeat: {enabled: true, everyMinutes: 30}});

    const after = await fetch(path, {headers: {cookie: auth.cookies}});
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toMatchObject({heartbeat: {agentKey: "panda", sessionId: "session-panda", enabled: true, everyMinutes: 30}});

    const audit = await harness.pool.query(`SELECT event_type, metadata::text AS metadata FROM "runtime"."control_audit_events" WHERE event_type = 'session_heartbeat_config_write' ORDER BY created_at ASC`);
    expect(audit.rows).toHaveLength(1);
    const auditText = JSON.stringify(audit.rows);
    expect(auditText).toContain("everyMinutes");
    expect(auditText).toContain("nextFireAt");
    expect(auditText).not.toContain("fireNow");
    expect(auditText).not.toContain("2099-01-01");
  });


  it("rejects enabling a legacy below-minimum cadence unless the patch raises it", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.pool.query(`
      UPDATE "runtime"."session_heartbeats"
      SET enabled = FALSE, every_minutes = 1, next_fire_at = NOW() + INTERVAL '1 minute'
      WHERE session_id = 'session-panda'
    `);
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);
    const path = `${base}/api/control/agents/panda/sessions/session-panda/heartbeat`;

    const unsafeEnable = await fetch(path, {method: "PATCH", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({enabled: true, confirm: "update-heartbeat"})});
    expect(unsafeEnable.status).toBe(400);
    expect(await harness.sessions.getHeartbeat("session-panda")).toMatchObject({enabled: false, everyMinutes: 1});

    const auditAfterReject = await harness.pool.query(`SELECT COUNT(*)::int AS count FROM "runtime"."control_audit_events" WHERE event_type = 'session_heartbeat_config_write'`);
    expect(Number((auditAfterReject.rows[0] as Record<string, unknown>).count)).toBe(0);

    const safeEnable = await fetch(path, {method: "PATCH", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({enabled: true, everyMinutes: 15, confirm: "update-heartbeat"})});
    expect(safeEnable.status).toBe(200);
    await expect(safeEnable.json()).resolves.toMatchObject({heartbeat: {enabled: true, everyMinutes: 15}});
  });

  it("requires both Control grant visibility and identity-agent pairing, and checks session belongs to path agent", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const noPairing = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/heartbeat`, {headers: {cookie: auth.cookies}});
    expect(noPairing.status).toBe(404);

    await harness.agents.ensurePairing("panda", "identity-patrik");
    const visible = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/heartbeat`, {headers: {cookie: auth.cookies}});
    expect(visible.status).toBe(200);

    const wrongAgent = await fetch(`${base}/api/control/agents/luna/sessions/session-panda/heartbeat`, {headers: {cookie: auth.cookies}});
    expect(wrongAgent.status).toBe(404);

    await harness.agents.ensurePairing("luna", "identity-patrik");
    const noScopedGrant = await fetch(`${base}/api/control/agents/luna/sessions/session-luna/heartbeat`, {headers: {cookie: auth.cookies}});
    expect(noScopedGrant.status).toBe(404);

    const blockedPatch = await fetch(`${base}/api/control/agents/luna/sessions/session-luna/heartbeat`, {method: "PATCH", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({enabled: true, confirm: "update-heartbeat"})});
    expect(blockedPatch.status).toBe(404);
  });
});


describe("Control session todos HTTP", () => {
  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>, role: "admin" | "scoped" = "scoped") {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role, ...(role === "scoped" ? {agentKey: "panda"} : {})});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    return {cookies: cookieHeader(response)};
  }

  it("rejects unauthenticated reads", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/todos`);
    expect(response.status).toBe(401);
  });

  it("allows admin to read an unpaired todo while scoped still requires pairing", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");
    const scoped = await login(base, harness, "scoped");

    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/todos`, {headers: {cookie: admin.cookies}})).status).toBe(200);
    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/todos`, {headers: {cookie: scoped.cookies}})).status).toBe(404);
  });

  it("returns authorized same-agent session todos with item order, status, content, counts, and whitelisted fields", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.sessions.replaceSessionTodo({sessionId: "session-panda", items: [
      {status: "pending", content: "First private todo"},
      {status: "blocked", content: "Second blocked todo"},
      {status: "done", content: "Third done todo"},
    ]});
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/todos`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {todo: Record<string, unknown>};

    expect(Object.keys(body.todo).sort()).toEqual(["counts", "createdAt", "items", "itemsHash", "sessionId", "updatedAt"]);
    expect(body.todo).toMatchObject({
      sessionId: "session-panda",
      items: [
        {status: "pending", content: "First private todo"},
        {status: "blocked", content: "Second blocked todo"},
        {status: "done", content: "Third done todo"},
      ],
      counts: {pending: 1, in_progress: 0, blocked: 1, done: 1},
    });
    expect(typeof body.todo.itemsHash).toBe("string");
    expect(typeof body.todo.createdAt).toBe("string");
    expect(typeof body.todo.updatedAt).toBe("string");
    const text = JSON.stringify(body);
    expect(text).not.toContain("agentKey");
    expect(text).not.toContain("created_by_identity_id");
    expect(text).not.toContain("items_hash");
  });

  it("returns a stable empty DTO when the session has no todo row", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.sessions.replaceSessionTodo({sessionId: "session-panda", items: []});
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/todos`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({todo: {
      sessionId: "session-panda",
      items: [],
      itemsHash: null,
      createdAt: null,
      updatedAt: null,
      counts: {pending: 0, in_progress: 0, blocked: 0, done: 0},
    }});
  });

  it("does not leak distinctive cross-agent todo content", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.agents.ensurePairing("luna", "identity-patrik");
    await harness.sessions.replaceSessionTodo({sessionId: "session-luna", items: [{status: "pending", content: "LUNA_DISTINCTIVE_PRIVATE_TODO"}]});
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/luna/sessions/session-luna/todos`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(404);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("LUNA_DISTINCTIVE_PRIVATE_TODO");
  });

  it("checks that the target session belongs to the path agent", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.sessions.replaceSessionTodo({sessionId: "session-panda", items: [{status: "pending", content: "PATH_AGENT_PRIVATE_TODO"}]});
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/luna/sessions/session-panda/todos`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(404);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("PATH_AGENT_PRIVATE_TODO");
  });
});


describe("Control Watches HTTP", () => {
  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>, role: "admin" | "scoped" = "scoped", agentKey = "panda") {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role, ...(role === "scoped" ? {agentKey} : {})});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    return {cookies: cookieHeader(response)};
  }

  it("rejects unauthenticated watch reads", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches`);
    expect(response.status).toBe(401);
  });

  it("allows admin to read unpaired watches while scoped still requires pairing", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");
    const scoped = await login(base, harness, "scoped");

    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches`, {headers: {cookie: admin.cookies}})).status).toBe(200);
    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches`, {headers: {cookie: scoped.cookies}})).status).toBe(404);
  });

  it("returns a stable empty watches DTO when the visible session has no watches", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({watches: {agentKey: "panda", sessionId: "session-panda", watches: []}});
  });

  it("returns authorized same-agent watches with a strongly redacted DTO", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const watch = await harness.watchStore.createWatch({
      sessionId: "session-panda",
      createdByIdentityId: "identity-patrik",
      title: "Safe visible watch title",
      intervalMinutes: 15,
      source: {
        kind: "http_json",
        url: "https://private.example.test/SECRET_PRIVATE_URL",
        method: "POST",
        headers: [{name: "X-PRIVATE-HEADER", value: "SECRET_HEADER_VALUE", credentialEnvKey: "SECRET_ENV_KEY"}],
        auth: {type: "bearer", credentialEnvKey: "SECRET_AUTH_ENV"},
        body: "SECRET_BODY_VALUE",
        result: {observation: "collection", itemsPath: "PRIVATE_ITEMS_SELECTOR", itemIdPath: "id", itemCursorPath: "cursor", summaryPath: "SECRET_SUMMARY_PATH"},
      },
      detector: {kind: "new_items", maxItems: 5},
      state: {privateState: "SECRET_STATE_VALUE"},
      nextPollAt: Date.parse("2040-01-01T00:00:00.000Z"),
    });
    await harness.pool.query(`
      UPDATE "runtime"."watches"
      SET last_error = 'SECRET_LAST_ERROR_VALUE', cooldown_until = '2040-01-01T00:10:00.000Z'
      WHERE id = $1
    `, [watch.id]);
    await harness.pool.query(`
      INSERT INTO "runtime"."watch_runs" (id, watch_id, session_id, scheduled_for, status, error, created_at, started_at, finished_at)
      VALUES
        ('00000000-0000-0000-0000-000000000201', $1, 'session-panda', '2039-12-31T10:00:00.000Z', 'failed', 'SECRET_RUN_ERROR_VALUE', '2039-12-31T10:01:00.000Z', '2039-12-31T10:01:00.000Z', '2039-12-31T10:02:00.000Z'),
        ('00000000-0000-0000-0000-000000000202', $1, 'session-panda', '2039-12-30T10:00:00.000Z', 'changed', NULL, '2039-12-30T10:01:00.000Z', '2039-12-30T10:01:00.000Z', '2039-12-30T10:02:00.000Z')
    `, [watch.id]);
    await harness.pool.query(`
      INSERT INTO "runtime"."watch_events" (id, watch_id, session_id, event_kind, summary, dedupe_key, payload, created_at)
      VALUES ('00000000-0000-0000-0000-000000000301', $1, 'session-panda', 'new_items', 'SECRET_EVENT_SUMMARY_VALUE', 'SECRET_DEDUPE_KEY_VALUE', '{"private":"SECRET_EVENT_PAYLOAD_VALUE"}'::jsonb, '2039-12-31T10:03:00.000Z')
    `, [watch.id]);
    await harness.watchStore.createWatch({
      sessionId: "session-luna",
      title: "LUNA_PRIVATE_WATCH_TITLE",
      intervalMinutes: 5,
      source: {kind: "sql_query", credentialEnvKey: "SECRET_SQL_ENV", dialect: "postgres", query: "SELECT SECRET_SQL_QUERY FROM private_table", result: {observation: "scalar", valueField: "SECRET_SQL_VALUE_FIELD"}},
      detector: {kind: "percent_change", percent: 10},
    });
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches?limit=10`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {watches: {watches: Array<Record<string, unknown>>}};
    expect(Object.keys(body.watches).sort()).toEqual(["agentKey", "sessionId", "watches"]);
    expect(body.watches.watches).toHaveLength(1);
    const returned = body.watches.watches[0]!;
    expect(returned).toMatchObject({
      id: watch.id,
      title: "Safe visible watch title",
      sourceKind: "http_json",
      detectorKind: "new_items",
      observationKind: "collection",
      intervalMinutes: 15,
      enabled: true,
      lifecycleStatus: "cooldown",
      nextPollAt: "2040-01-01T00:00:00.000Z",
      disabledAt: null,
      cooldownUntil: "2040-01-01T00:10:00.000Z",
      recentRunCount: 2,
      eventCount: 1,
      latestRun: {
        id: "00000000-0000-0000-0000-000000000201",
        status: "failed",
        scheduledFor: "2039-12-31T10:00:00.000Z",
        startedAt: "2039-12-31T10:01:00.000Z",
        finishedAt: "2039-12-31T10:02:00.000Z",
        createdAt: "2039-12-31T10:01:00.000Z",
      },
    });
    expect(Object.keys(returned).sort()).toEqual(["cooldownUntil", "createdAt", "detectorKind", "disabledAt", "enabled", "eventCount", "id", "intervalMinutes", "latestRun", "lifecycleStatus", "nextPollAt", "observationKind", "recentRunCount", "sourceKind", "title", "updatedAt"]);
    const text = JSON.stringify(body);
    for (const sentinel of [
      "SECRET_PRIVATE_URL",
      "X-PRIVATE-HEADER",
      "SECRET_HEADER_VALUE",
      "SECRET_ENV_KEY",
      "SECRET_AUTH_ENV",
      "SECRET_BODY_VALUE",
      "PRIVATE_ITEMS_SELECTOR",
      "SECRET_SUMMARY_PATH",
      "SECRET_STATE_VALUE",
      "SECRET_LAST_ERROR_VALUE",
      "SECRET_RUN_ERROR_VALUE",
      "SECRET_EVENT_SUMMARY_VALUE",
      "SECRET_DEDUPE_KEY_VALUE",
      "SECRET_EVENT_PAYLOAD_VALUE",
      "LUNA_PRIVATE_WATCH_TITLE",
      "SECRET_SQL_QUERY",
      "SECRET_SQL_ENV",
      "source_config",
      "detector_config",
      "last_error",
      "dedupe",
      "payload",
      "state",
      "error",
      "url",
      "headers",
      "body",
      "selector",
      "query",
    ]) expect(text).not.toContain(sentinel);
  });

  it("does not leak cross-agent Mongo or IMAP watch details and checks path-agent ownership", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.agents.ensurePairing("luna", "identity-patrik");
    const panda = await harness.watchStore.createWatch({
      sessionId: "session-panda",
      title: "PANDA_PATH_WATCH_TITLE",
      intervalMinutes: 5,
      source: {kind: "http_html", url: "https://private.example.test/PATH_PRIVATE_URL", result: {observation: "snapshot", mode: "selector_text", selector: "PATH_PRIVATE_SELECTOR"}},
      detector: {kind: "snapshot_changed"},
    });
    await harness.watchStore.createWatch({
      sessionId: "session-luna",
      title: "LUNA_PRIVATE_IMAP_WATCH_TITLE",
      intervalMinutes: 5,
      source: {kind: "imap_mailbox", host: "imap.private.example", mailbox: "SECRET_IMAP_MAILBOX", username: "SECRET_IMAP_USER", passwordCredentialEnvKey: "SECRET_IMAP_PASSWORD_ENV"},
      detector: {kind: "new_items"},
    });
    await harness.watchStore.createWatch({
      sessionId: "session-luna",
      title: "LUNA_PRIVATE_MONGO_WATCH_TITLE",
      intervalMinutes: 5,
      source: {kind: "mongodb_query", credentialEnvKey: "SECRET_MONGO_ENV", database: "SECRET_MONGO_DB", collection: "SECRET_MONGO_COLLECTION", operation: "find", filter: {private: "SECRET_MONGO_FILTER"}, result: {observation: "collection", itemIdField: "_id", itemCursorField: "updatedAt"}},
      detector: {kind: "new_items"},
    });
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");

    const wrongAgent = await fetch(`${base}/api/control/agents/luna/sessions/session-panda/watches`, {headers: {cookie: auth.cookies}});
    expect(wrongAgent.status).toBe(404);
    const wrongAgentText = JSON.stringify(await wrongAgent.json());
    expect(wrongAgentText).not.toContain("PANDA_PATH_WATCH_TITLE");
    expect(wrongAgentText).not.toContain("PATH_PRIVATE_URL");
    expect(wrongAgentText).not.toContain("PATH_PRIVATE_SELECTOR");

    const crossAgent = await fetch(`${base}/api/control/agents/luna/sessions/session-luna/watches`, {headers: {cookie: auth.cookies}});
    expect(crossAgent.status).toBe(404);
    const text = JSON.stringify(await crossAgent.json());
    for (const sentinel of ["LUNA_PRIVATE_IMAP_WATCH_TITLE", "SECRET_IMAP_MAILBOX", "SECRET_IMAP_USER", "SECRET_IMAP_PASSWORD_ENV", "LUNA_PRIVATE_MONGO_WATCH_TITLE", "SECRET_MONGO_ENV", "SECRET_MONGO_DB", "SECRET_MONGO_COLLECTION", "SECRET_MONGO_FILTER", panda.id]) {
      expect(text).not.toContain(sentinel);
    }
  });
});

describe("Control scheduled tasks HTTP", () => {
  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>, role: "admin" | "scoped" = "scoped", agentKey = "panda") {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role, ...(role === "scoped" ? {agentKey} : {})});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    return {cookies: cookieHeader(response)};
  }

  it("rejects unauthenticated scheduled task reads", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/scheduled-tasks`);
    expect(response.status).toBe(401);
  });

  it("allows admin to read unpaired scheduled tasks while scoped still requires pairing", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");
    const scoped = await login(base, harness, "scoped");

    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/scheduled-tasks`, {headers: {cookie: admin.cookies}})).status).toBe(200);
    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/scheduled-tasks`, {headers: {cookie: scoped.cookies}})).status).toBe(404);
  });

  it("returns a stable empty scheduled tasks DTO when the visible session has no tasks", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/scheduled-tasks`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({scheduledTasks: {agentKey: "panda", sessionId: "session-panda", tasks: []}});
  });

  it("returns authorized same-agent scheduled tasks with whitelisted task and recent-run fields", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const once = await harness.scheduledTaskStore.createTask({
      sessionId: "session-panda",
      createdByIdentityId: "identity-patrik",
      title: "Once task with a long but safe visible title",
      instruction: "PRIVATE_ONCE_INSTRUCTION_MUST_NOT_LEAK",
      schedule: {kind: "once", runAt: "2040-01-01T10:00:00.000Z"},
    });
    const recurring = await harness.scheduledTaskStore.createTask({
      sessionId: "session-panda",
      createdByIdentityId: "identity-patrik",
      title: "Recurring task",
      instruction: "PRIVATE_RECURRING_INSTRUCTION_MUST_NOT_LEAK",
      schedule: {kind: "recurring", cron: "5 12 * * *", timezone: "Europe/Bratislava"},
    });
    await harness.pool.query(`
      INSERT INTO "runtime"."scheduled_task_runs" (id, task_id, session_id, scheduled_for, status, error, created_at, started_at, finished_at)
      VALUES
        ('00000000-0000-0000-0000-000000000101', $1, 'session-panda', '2039-12-31T10:00:00.000Z', 'failed', 'RAW_ERROR_MUST_NOT_LEAK', '2039-12-31T10:01:00.000Z', '2039-12-31T10:01:00.000Z', '2039-12-31T10:02:00.000Z'),
        ('00000000-0000-0000-0000-000000000102', $1, 'session-panda', '2039-12-30T10:00:00.000Z', 'succeeded', NULL, '2039-12-30T10:01:00.000Z', '2039-12-30T10:01:00.000Z', '2039-12-30T10:02:00.000Z'),
        ('00000000-0000-0000-0000-000000000103', $1, 'session-panda', '2039-12-29T10:00:00.000Z', 'cancelled', NULL, '2039-12-29T10:01:00.000Z', NULL, '2039-12-29T10:02:00.000Z'),
        ('00000000-0000-0000-0000-000000000104', $1, 'session-panda', '2039-12-28T10:00:00.000Z', 'succeeded', NULL, '2039-12-28T10:01:00.000Z', NULL, '2039-12-28T10:02:00.000Z')
    `, [once.id]);
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/scheduled-tasks?limit=10`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {scheduledTasks: {tasks: Array<Record<string, unknown>>}};
    expect(Object.keys(body.scheduledTasks).sort()).toEqual(["agentKey", "sessionId", "tasks"]);
    expect(body.scheduledTasks.tasks.map((task) => task.id).sort()).toEqual([once.id, recurring.id].sort());
    const onceTask = body.scheduledTasks.tasks.find((task) => task.id === once.id)!;
    const recurringTask = body.scheduledTasks.tasks.find((task) => task.id === recurring.id)!;
    expect(onceTask).toMatchObject({
      id: once.id,
      title: "Once task with a long but safe visible title",
      schedule: {kind: "once", runAt: "2040-01-01T10:00:00.000Z"},
      enabled: true,
      lifecycleStatus: "scheduled",
      nextFireAt: "2040-01-01T10:00:00.000Z",
      completedAt: null,
      cancelledAt: null,
    });
    expect(recurringTask).toMatchObject({
      id: recurring.id,
      title: "Recurring task",
      schedule: {kind: "recurring", cron: "5 12 * * *", timezone: "Europe/Bratislava"},
    });
    expect((onceTask.recentRuns as unknown[])).toHaveLength(3);
    expect((onceTask.recentRuns as Array<{id: string}>).map((run) => run.id)).toEqual([
      "00000000-0000-0000-0000-000000000101",
      "00000000-0000-0000-0000-000000000102",
      "00000000-0000-0000-0000-000000000103",
    ]);
    expect(Object.keys((onceTask.recentRuns as Array<Record<string, unknown>>)[0]!).sort()).toEqual(["finishedAt", "id", "scheduledFor", "startedAt", "status"]);
    expect(Object.keys(onceTask).sort()).toEqual(["cancelledAt", "completedAt", "createdAt", "enabled", "id", "lifecycleStatus", "nextFireAt", "recentRuns", "schedule", "title", "updatedAt"]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("PRIVATE_ONCE_INSTRUCTION_MUST_NOT_LEAK");
    expect(text).not.toContain("PRIVATE_RECURRING_INSTRUCTION_MUST_NOT_LEAK");
    expect(text).not.toContain("RAW_ERROR_MUST_NOT_LEAK");
    expect(text).not.toContain("instruction");
    expect(text).not.toContain("createdByIdentityId");
    expect(text).not.toContain("createdFromMessageId");
    expect(text).not.toContain("claimedBy");
    expect(text).not.toContain("error");
  });

  it("does not leak distinctive cross-agent scheduled task title or instruction", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.agents.ensurePairing("luna", "identity-patrik");
    await harness.scheduledTaskStore.createTask({
      sessionId: "session-luna",
      title: "LUNA_DISTINCTIVE_PRIVATE_TASK_TITLE",
      instruction: "LUNA_DISTINCTIVE_PRIVATE_TASK_INSTRUCTION",
      schedule: {kind: "once", runAt: "2040-02-01T10:00:00.000Z"},
    });
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");

    const response = await fetch(`${base}/api/control/agents/luna/sessions/session-luna/scheduled-tasks`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(404);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("LUNA_DISTINCTIVE_PRIVATE_TASK_TITLE");
    expect(text).not.toContain("LUNA_DISTINCTIVE_PRIVATE_TASK_INSTRUCTION");
  });

  it("checks the scheduled task session belongs to the path agent and bounds task limit", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const first = await harness.scheduledTaskStore.createTask({sessionId: "session-panda", title: "First by next fire", instruction: "FIRST_INSTRUCTION", schedule: {kind: "once", runAt: "2040-01-01T00:00:00.000Z"}});
    const second = await harness.scheduledTaskStore.createTask({sessionId: "session-panda", title: "Second by next fire", instruction: "SECOND_INSTRUCTION", schedule: {kind: "once", runAt: "2040-01-02T00:00:00.000Z"}});
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");

    const limited = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/scheduled-tasks?limit=1`, {headers: {cookie: auth.cookies}});
    expect(limited.status).toBe(200);
    await expect(limited.json()).resolves.toMatchObject({scheduledTasks: {tasks: [{id: first.id}]}});

    const all = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/scheduled-tasks?limit=250`, {headers: {cookie: auth.cookies}});
    expect(all.status).toBe(200);
    const body = await all.json() as {scheduledTasks: {tasks: Array<{id: string}>}};
    expect(body.scheduledTasks.tasks.map((task) => task.id)).toEqual([first.id, second.id]);

    const wrongAgent = await fetch(`${base}/api/control/agents/luna/sessions/session-panda/scheduled-tasks`, {headers: {cookie: auth.cookies}});
    expect(wrongAgent.status).toBe(404);
    const text = JSON.stringify(await wrongAgent.json());
    expect(text).not.toContain("First by next fire");
    expect(text).not.toContain("FIRST_INSTRUCTION");
  });
});


describe("Control Runtime Activity HTTP", () => {
  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>, role: "admin" | "scoped" = "scoped", agentKey = "panda") {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role, ...(role === "scoped" ? {agentKey} : {})});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    return {cookies: cookieHeader(response)};
  }

  async function seedThreads(harness: Awaited<ReturnType<typeof createHarness>>) {
    await harness.pool.query(`
      INSERT INTO "runtime"."threads" (id, session_id) VALUES
        ('thread-panda', 'session-panda'),
        ('thread-luna', 'session-luna')
    `);
  }

  it("rejects unauthenticated runtime activity reads", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity`);
    expect(response.status).toBe(401);
  });

  it("allows admin to read unpaired runtime activity while scoped still requires pairing", async () => {
    const harness = await createHarness();
    await seedThreads(harness);
    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");
    const scoped = await login(base, harness, "scoped");

    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity`, {headers: {cookie: admin.cookies}})).status).toBe(200);
    expect((await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity`, {headers: {cookie: scoped.cookies}})).status).toBe(404);
  });

  it("returns a stable empty runtime activity DTO when the visible session has no runs", async () => {
    const harness = await createHarness();
    await seedThreads(harness);
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({runtimeActivity: {agentKey: "panda", sessionId: "session-panda", summary: {running: 0, completed: 0, failed: 0, latestStartedAt: null, latestFinishedAt: null}, runs: []}});
  });

  it("returns authorized same-session runs with whitelisted fields and hides raw runtime data", async () => {
    const harness = await createHarness();
    await seedThreads(harness);
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.pool.query(`
      INSERT INTO "runtime"."runs" (id, thread_id, status, started_at, finished_at, abort_requested_at, abort_reason, error) VALUES
        ('00000000-0000-0000-0000-000000000401', 'thread-panda', 'failed', '2040-01-02T10:00:00.000Z', '2040-01-02T10:00:05.000Z', '2040-01-02T10:00:02.000Z', 'PRIVATE_ABORT_REASON_MUST_NOT_LEAK', 'Provider failed failureKind=provider_timeout PRIVATE_RAW_RUN_ERROR_MUST_NOT_LEAK'),
        ('00000000-0000-0000-0000-000000000402', 'thread-panda', 'completed', '2040-01-01T10:00:00.000Z', '2040-01-01T10:00:01.500Z', NULL, NULL, NULL),
        ('00000000-0000-0000-0000-000000000403', 'thread-panda', 'running', '2040-01-03T10:00:00.000Z', NULL, NULL, NULL, 'PRIVATE_RUNNING_ERROR_MUST_NOT_LEAK'),
        ('00000000-0000-0000-0000-000000000404', 'thread-luna', 'failed', '2040-01-04T10:00:00.000Z', '2040-01-04T10:00:01.000Z', NULL, NULL, 'LUNA_PRIVATE_RAW_RUN_ERROR')
    `);
    await harness.pool.query(`
      INSERT INTO "runtime"."messages" (id, thread_id, origin, source, run_id, run_thread_id, created_at, message, metadata)
      VALUES ('00000000-0000-0000-0000-000000000501', 'thread-panda', 'assistant', 'assistant', '00000000-0000-0000-0000-000000000401', 'thread-panda', '2040-01-02T10:00:03.000Z', '{"role":"assistant","content":"PRIVATE_TRANSCRIPT_MESSAGE_MUST_NOT_LEAK"}'::jsonb, '{"private":"PRIVATE_MESSAGE_METADATA_MUST_NOT_LEAK"}'::jsonb)
    `);
    await harness.pool.query(`
      INSERT INTO "runtime"."inputs" (id, thread_id, source, input_order, applied_at, created_at, message, metadata)
      VALUES ('00000000-0000-0000-0000-000000000502', 'thread-panda', 'runtime', 1, '2040-01-02T10:00:00.000Z', '2040-01-02T10:00:00.000Z', '{"content":"PRIVATE_INPUT_MESSAGE_MUST_NOT_LEAK"}'::jsonb, '{"private":"PRIVATE_INPUT_METADATA_MUST_NOT_LEAK"}'::jsonb)
    `);
    await harness.pool.query(`
      INSERT INTO "runtime"."tool_jobs" (id, thread_id, run_id, run_thread_id, kind, status, summary, started_at, finished_at, result, error, progress)
      VALUES ('00000000-0000-0000-0000-000000000503', 'thread-panda', '00000000-0000-0000-0000-000000000401', 'thread-panda', 'bash', 'failed', 'PRIVATE_TOOL_SUMMARY_MUST_NOT_LEAK', '2040-01-02T10:00:00.000Z', '2040-01-02T10:00:01.000Z', '{"stdout":"PRIVATE_TOOL_RESULT_MUST_NOT_LEAK"}'::jsonb, 'PRIVATE_TOOL_ERROR_MUST_NOT_LEAK', '{"tail":"PRIVATE_TOOL_PROGRESS_MUST_NOT_LEAK"}'::jsonb)
    `);
    await harness.pool.query(`
      INSERT INTO "runtime"."bash_jobs" (id, thread_id, run_id, run_thread_id, status, command, mode, initial_cwd, started_at, finished_at, stdout, stderr, tracked_env_keys)
      VALUES ('00000000-0000-0000-0000-000000000504', 'thread-panda', '00000000-0000-0000-0000-000000000401', 'thread-panda', 'completed', 'echo PRIVATE_BASH_COMMAND_MUST_NOT_LEAK', 'foreground', '/workspace', '2040-01-02T10:00:00.000Z', '2040-01-02T10:00:01.000Z', 'PRIVATE_STDOUT_MUST_NOT_LEAK', 'PRIVATE_STDERR_MUST_NOT_LEAK', '["PRIVATE_ENV_KEY_MUST_NOT_LEAK"]'::jsonb)
    `);
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity?limit=10`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {runtimeActivity: {summary: Record<string, unknown>; runs: Array<Record<string, unknown>>}};
    expect(Object.keys(body.runtimeActivity).sort()).toEqual(["agentKey", "runs", "sessionId", "summary"]);
    expect(body.runtimeActivity.summary).toEqual({running: 1, completed: 1, failed: 1, latestStartedAt: "2040-01-03T10:00:00.000Z", latestFinishedAt: "2040-01-02T10:00:05.000Z"});
    expect(body.runtimeActivity.runs).toHaveLength(3);
    expect(body.runtimeActivity.runs[0]).toMatchObject({id: "00000000-0000-0000-0000-000000000403", status: "running", startedAt: "2040-01-03T10:00:00.000Z", finishedAt: null, durationMs: null, abortRequestedAt: null, failureCategory: null});
    expect(body.runtimeActivity.runs[1]).toMatchObject({id: "00000000-0000-0000-0000-000000000401", status: "failed", startedAt: "2040-01-02T10:00:00.000Z", finishedAt: "2040-01-02T10:00:05.000Z", durationMs: 5000, abortRequestedAt: "2040-01-02T10:00:02.000Z", failureCategory: "provider_timeout"});
    expect(Object.keys(body.runtimeActivity.runs[1]!).sort()).toEqual(["abortRequestedAt", "durationMs", "failureCategory", "finishedAt", "id", "startedAt", "status"]);
    const text = JSON.stringify(body);
    for (const sentinel of [
      "PRIVATE_ABORT_REASON_MUST_NOT_LEAK",
      "PRIVATE_RAW_RUN_ERROR_MUST_NOT_LEAK",
      "PRIVATE_RUNNING_ERROR_MUST_NOT_LEAK",
      "LUNA_PRIVATE_RAW_RUN_ERROR",
      "PRIVATE_TRANSCRIPT_MESSAGE_MUST_NOT_LEAK",
      "PRIVATE_MESSAGE_METADATA_MUST_NOT_LEAK",
      "PRIVATE_INPUT_MESSAGE_MUST_NOT_LEAK",
      "PRIVATE_INPUT_METADATA_MUST_NOT_LEAK",
      "PRIVATE_TOOL_SUMMARY_MUST_NOT_LEAK",
      "PRIVATE_TOOL_RESULT_MUST_NOT_LEAK",
      "PRIVATE_TOOL_ERROR_MUST_NOT_LEAK",
      "PRIVATE_TOOL_PROGRESS_MUST_NOT_LEAK",
      "PRIVATE_BASH_COMMAND_MUST_NOT_LEAK",
      "PRIVATE_STDOUT_MUST_NOT_LEAK",
      "PRIVATE_STDERR_MUST_NOT_LEAK",
      "PRIVATE_ENV_KEY_MUST_NOT_LEAK",
      "error",
      "abortReason",
      "message",
      "metadata",
      "stdout",
      "stderr",
      "command",
      "result",
      "progress",
    ]) expect(text).not.toContain(sentinel);
  });

  it("checks path-agent ownership, scoped agent visibility, and runtime activity limits", async () => {
    const harness = await createHarness();
    await seedThreads(harness);
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.agents.ensurePairing("luna", "identity-patrik");
    await harness.pool.query(`
      INSERT INTO "runtime"."runs" (id, thread_id, status, started_at, finished_at, error) VALUES
        ('00000000-0000-0000-0000-000000000601', 'thread-panda', 'completed', '2040-01-01T00:00:00.000Z', '2040-01-01T00:00:01.000Z', NULL),
        ('00000000-0000-0000-0000-000000000602', 'thread-panda', 'completed', '2040-01-02T00:00:00.000Z', '2040-01-02T00:00:01.000Z', NULL),
        ('00000000-0000-0000-0000-000000000603', 'thread-luna', 'failed', '2040-01-03T00:00:00.000Z', '2040-01-03T00:00:01.000Z', 'LUNA_LIMIT_PRIVATE_ERROR')
    `);
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");

    const limited = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity?limit=1`, {headers: {cookie: auth.cookies}});
    expect(limited.status).toBe(200);
    await expect(limited.json()).resolves.toMatchObject({runtimeActivity: {runs: [{id: "00000000-0000-0000-0000-000000000602"}]}});

    const clamped = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity?limit=250`, {headers: {cookie: auth.cookies}});
    expect(clamped.status).toBe(200);
    const clampedBody = await clamped.json() as {runtimeActivity: {runs: unknown[]}};
    expect(clampedBody.runtimeActivity.runs).toHaveLength(2);

    const invalid = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity?limit=0`, {headers: {cookie: auth.cookies}});
    expect(invalid.status).toBe(400);

    const wrongPath = await fetch(`${base}/api/control/agents/luna/sessions/session-panda/runtime-activity`, {headers: {cookie: auth.cookies}});
    expect(wrongPath.status).toBe(404);
    const wrongPathText = JSON.stringify(await wrongPath.json());
    expect(wrongPathText).not.toContain("00000000-0000-0000-0000-000000000601");

    const crossAgent = await fetch(`${base}/api/control/agents/luna/sessions/session-luna/runtime-activity`, {headers: {cookie: auth.cookies}});
    expect(crossAgent.status).toBe(404);
    const crossText = JSON.stringify(await crossAgent.json());
    expect(crossText).not.toContain("LUNA_LIMIT_PRIVATE_ERROR");
    expect(crossText).not.toContain("00000000-0000-0000-0000-000000000603");
  });

  async function seedConnectorAccounts(harness: Awaited<ReturnType<typeof createHarness>>) {
    await harness.pool.query(`
      INSERT INTO "runtime"."connector_accounts" (
        id,
        source,
        account_key,
        connector_key,
        owner_kind,
        owner_identity_id,
        owner_agent_key,
        display_name,
        external_account_id,
        external_username,
        status,
        config,
        metadata,
        created_at,
        updated_at
      ) VALUES
        ('10000000-0000-0000-0000-000000000001', 'discord', 'panda-main', 'discord:panda-main', 'agent', NULL, 'panda', 'Panda Discord', 'PRIVATE_EXTERNAL_ACCOUNT_ID_SAFE_TO_SHOW', 'panda-user', 'enabled', '{"token":"PRIVATE_CONFIG_TOKEN_MUST_NOT_LEAK","webhookUrl":"https://hooks.example/PRIVATE_WEBHOOK_MUST_NOT_LEAK","authHeader":"Bearer PRIVATE_AUTH_HEADER_MUST_NOT_LEAK"}'::jsonb, '{"channel":"PRIVATE_METADATA_CHANNEL_MUST_NOT_LEAK","message":"PRIVATE_METADATA_MESSAGE_MUST_NOT_LEAK"}'::jsonb, '2040-01-01T00:00:00.000Z', '2040-01-01T00:00:01.000Z'),
        ('10000000-0000-0000-0000-000000000002', 'telegram', 'system-default', 'telegram:system-default', 'system', NULL, NULL, 'System Telegram', 'system-ext', 'system-user', 'enabled', '{"botToken":"PRIVATE_SYSTEM_CONFIG_TOKEN_MUST_NOT_LEAK"}'::jsonb, '{"webhook":"PRIVATE_SYSTEM_METADATA_WEBHOOK_MUST_NOT_LEAK"}'::jsonb, '2040-01-02T00:00:00.000Z', '2040-01-02T00:00:01.000Z'),
        ('10000000-0000-0000-0000-000000000003', 'discord', 'luna-main', 'discord:luna-main', 'agent', NULL, 'luna', 'Luna Discord PRIVATE_LUNA_DISPLAY_SAFE_TO_EXCLUDE', 'luna-ext', 'luna-user', 'enabled', '{"token":"PRIVATE_LUNA_CONFIG_TOKEN_MUST_NOT_LEAK"}'::jsonb, '{"channel":"PRIVATE_LUNA_METADATA_MUST_NOT_LEAK"}'::jsonb, '2040-01-03T00:00:00.000Z', '2040-01-03T00:00:01.000Z'),
        ('10000000-0000-0000-0000-000000000004', 'discord', 'identity-main', 'discord:identity-main', 'identity', 'identity-patrik', NULL, 'Identity Discord PRIVATE_IDENTITY_DISPLAY_SAFE_TO_EXCLUDE', 'identity-ext', 'identity-user', 'enabled', '{"token":"PRIVATE_IDENTITY_CONFIG_TOKEN_MUST_NOT_LEAK"}'::jsonb, '{"channel":"PRIVATE_IDENTITY_METADATA_MUST_NOT_LEAK"}'::jsonb, '2040-01-04T00:00:00.000Z', '2040-01-04T00:00:01.000Z')
    `);
    await harness.pool.query(`
      INSERT INTO "runtime"."connector_account_secrets" (account_id, secret_key, value_ciphertext, value_iv, value_tag, key_version, created_at, updated_at) VALUES
        ('10000000-0000-0000-0000-000000000001', 'bot_token', '\\x505249564154455f434950484552544558545f4d5553545f4e4f545f4c45414b', '\\x505249564154455f49565f4d5553545f4e4f545f4c45414b', '\\x505249564154455f5441475f4d5553545f4e4f545f4c45414b', 7, '2040-01-01T00:00:02.000Z', '2040-01-01T00:00:03.000Z'),
        ('10000000-0000-0000-0000-000000000002', 'webhook_token', '\\x53595354454d5f434950484552544558545f4d5553545f4e4f545f4c45414b', '\\x53595354454d5f49565f4d5553545f4e4f545f4c45414b', '\\x53595354454d5f5441475f4d5553545f4e4f545f4c45414b', 3, '2040-01-02T00:00:02.000Z', '2040-01-02T00:00:03.000Z')
    `);
  }

  it("rejects unauthenticated connector account reads", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);

    const response = await fetch(`${base}/api/control/agents/panda/connectors`);
    expect(response.status).toBe(401);
  });

  it("allows admin to read path-agent and system connector summaries without raw private fields", async () => {
    const harness = await createHarness();
    await seedConnectorAccounts(harness);
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "admin");

    const response = await fetch(`${base}/api/control/agents/panda/connectors?limit=10`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {connectors: {agentKey: string; summary: Record<string, number>; accounts: Array<Record<string, unknown>>}};
    expect(Object.keys(body.connectors).sort()).toEqual(["accounts", "agentKey", "summary"]);
    expect(body.connectors).toMatchObject({agentKey: "panda", summary: {total: 2, agentOwned: 1, systemOwned: 1}});
    expect(body.connectors.accounts.map((account) => account.accountKey).sort()).toEqual(["panda-main", "system-default"]);
    expect(body.connectors.accounts.find((account) => account.accountKey === "panda-main")).toMatchObject({
      id: "10000000-0000-0000-0000-000000000001",
      source: "discord",
      connectorKey: "discord:panda-main",
      displayName: "Panda Discord",
      externalAccountId: "PRIVATE_EXTERNAL_ACCOUNT_ID_SAFE_TO_SHOW",
      externalUsername: "panda-user",
      status: "enabled",
      ownerKind: "agent",
      ownerAgentKey: "panda",
      createdAt: "2040-01-01T00:00:00.000Z",
      updatedAt: "2040-01-01T00:00:01.000Z",
      secretKeys: [{secretKey: "bot_token", createdAt: "2040-01-01T00:00:02.000Z", updatedAt: "2040-01-01T00:00:03.000Z"}],
    });
    expect(Object.keys(body.connectors.accounts[0]!).sort()).toEqual(["accountKey", "connectorKey", "createdAt", "displayName", "externalAccountId", "externalUsername", "id", "ownerAgentKey", "ownerKind", "secretKeys", "source", "status", "updatedAt"]);
    const text = JSON.stringify(body);
    for (const sentinel of [
      "PRIVATE_CONFIG_TOKEN_MUST_NOT_LEAK",
      "PRIVATE_WEBHOOK_MUST_NOT_LEAK",
      "PRIVATE_AUTH_HEADER_MUST_NOT_LEAK",
      "PRIVATE_METADATA_CHANNEL_MUST_NOT_LEAK",
      "PRIVATE_METADATA_MESSAGE_MUST_NOT_LEAK",
      "PRIVATE_SYSTEM_CONFIG_TOKEN_MUST_NOT_LEAK",
      "PRIVATE_SYSTEM_METADATA_WEBHOOK_MUST_NOT_LEAK",
      "PRIVATE_LUNA_CONFIG_TOKEN_MUST_NOT_LEAK",
      "PRIVATE_LUNA_METADATA_MUST_NOT_LEAK",
      "PRIVATE_IDENTITY_CONFIG_TOKEN_MUST_NOT_LEAK",
      "PRIVATE_IDENTITY_METADATA_MUST_NOT_LEAK",
      "505249564154455f434950484552544558545f4d5553545f4e4f545f4c45414b",
      "PRIVATE_CIPHERTEXT_MUST_NOT_LEAK",
      "PRIVATE_IV_MUST_NOT_LEAK",
      "PRIVATE_TAG_MUST_NOT_LEAK",
      "valueCiphertext",
      "valueIv",
      "valueTag",
      "keyVersion",
      "config",
      "metadata",
      "authHeader",
      "webhookUrl",
    ]) expect(text).not.toContain(sentinel);
  });

  it("scopes connector accounts to the paired path agent and validates path visibility and limits", async () => {
    const harness = await createHarness();
    await seedConnectorAccounts(harness);
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.agents.ensurePairing("luna", "identity-patrik");
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");

    const response = await fetch(`${base}/api/control/agents/panda/connectors`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {connectors: {summary: Record<string, number>; accounts: Array<Record<string, unknown>>}};
    expect(body.connectors.summary).toEqual({total: 1, agentOwned: 1, systemOwned: 0});
    expect(body.connectors.accounts.map((account) => account.accountKey)).toEqual(["panda-main"]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("system-default");
    expect(text).not.toContain("luna-main");
    expect(text).not.toContain("identity-main");
    expect(text).not.toContain("PRIVATE_SYSTEM_CONFIG_TOKEN_MUST_NOT_LEAK");
    expect(text).not.toContain("PRIVATE_LUNA_CONFIG_TOKEN_MUST_NOT_LEAK");
    expect(text).not.toContain("PRIVATE_IDENTITY_CONFIG_TOKEN_MUST_NOT_LEAK");

    const wrongPath = await fetch(`${base}/api/control/agents/luna/connectors`, {headers: {cookie: auth.cookies}});
    expect(wrongPath.status).toBe(404);
    const wrongText = JSON.stringify(await wrongPath.json());
    expect(wrongText).not.toContain("luna-main");
    expect(wrongText).not.toContain("PRIVATE_LUNA_CONFIG_TOKEN_MUST_NOT_LEAK");

    const limited = await fetch(`${base}/api/control/agents/panda/connectors?limit=1`, {headers: {cookie: auth.cookies}});
    expect(limited.status).toBe(200);
    const limitedBody = await limited.json() as {connectors: {accounts: unknown[]}};
    expect(limitedBody.connectors.accounts).toHaveLength(1);

    const clamped = await fetch(`${base}/api/control/agents/panda/connectors?limit=250`, {headers: {cookie: auth.cookies}});
    expect(clamped.status).toBe(200);

    const invalid = await fetch(`${base}/api/control/agents/panda/connectors?limit=0`, {headers: {cookie: auth.cookies}});
    expect(invalid.status).toBe(400);
  });

});


describe("Control Home HTTP", () => {
  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>, role: "admin" | "scoped" = "scoped", agentKey = "panda") {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role, ...(role === "scoped" ? {agentKey} : {})});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    return {cookies: cookieHeader(response)};
  }

  it("authenticates home reads and scoped unpaired grants reveal no private rows", async () => {
    const harness = await createHarness();
    await harness.pool.query(`UPDATE "runtime"."agent_sessions" SET display_name = 'LUNA_UNPAIRED_PRIVATE_LABEL' WHERE id = 'session-luna'`);
    const base = await startHarnessServer(harness);

    expect((await fetch(`${base}/api/control/home`)).status).toBe(401);

    const scoped = await login(base, harness, "scoped", "panda");
    const response = await fetch(`${base}/api/control/home`, {headers: {cookie: scoped.cookies}});
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("session-panda");
    expect(text).not.toContain("session-luna");
    expect(text).not.toContain("LUNA_UNPAIRED_PRIVATE_LABEL");
  });

  it("isolates scoped home data across agents and sessions", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.agents.ensurePairing("luna", "identity-patrik");
    await harness.pool.query(`UPDATE "runtime"."agent_sessions" SET display_name = 'Panda operator room' WHERE id = 'session-panda'`);
    await harness.pool.query(`UPDATE "runtime"."agent_sessions" SET display_name = 'LUNA_DISTINCTIVE_PRIVATE_LABEL' WHERE id = 'session-luna'`);
    await harness.sessions.replaceSessionTodo({sessionId: "luna", items: []}).catch(() => undefined);
    await harness.sessions.replaceSessionTodo({sessionId: "session-luna", items: [{status: "blocked", content: "LUNA_DISTINCTIVE_PRIVATE_TODO"}]});
    await harness.scheduledTaskStore.createTask({
      sessionId: "session-luna",
      title: "LUNA_DISTINCTIVE_PRIVATE_TASK_TITLE",
      instruction: "LUNA_DISTINCTIVE_PRIVATE_TASK_INSTRUCTION",
      schedule: {kind: "once", runAt: "2040-02-01T10:00:00.000Z"},
    });
    const base = await startHarnessServer(harness);
    const scoped = await login(base, harness, "scoped", "panda");

    const response = await fetch(`${base}/api/control/home`, {headers: {cookie: scoped.cookies}});
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("session-panda");
    expect(text).toContain("Panda operator room");
    expect(text).not.toContain("luna");
    expect(text).not.toContain("session-luna");
    expect(text).not.toContain("LUNA_DISTINCTIVE_PRIVATE_LABEL");
    expect(text).not.toContain("LUNA_DISTINCTIVE_PRIVATE_TODO");
    expect(text).not.toContain("LUNA_DISTINCTIVE_PRIVATE_TASK_TITLE");
    expect(text).not.toContain("LUNA_DISTINCTIVE_PRIVATE_TASK_INSTRUCTION");
  });

  it("returns cockpit status, attention, sessions, upcoming automations, and sanitized activity", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.pool.query(`UPDATE "runtime"."agent_sessions" SET display_name = 'Panda mission control' WHERE id = 'session-panda'`);
    await harness.pool.query(`
      UPDATE "runtime"."session_heartbeats"
      SET enabled = FALSE, every_minutes = 60, next_fire_at = '2040-01-01T00:00:00.000Z'
      WHERE session_id = 'session-panda'
    `);
    await harness.sessions.replaceSessionTodo({sessionId: "session-panda", items: [
      {status: "blocked", content: "BLOCKED_TODO_PRIVATE_CONTENT"},
      {status: "in_progress", content: "IN_PROGRESS_TODO_PRIVATE_CONTENT"},
      {status: "done", content: "DONE_TODO_PRIVATE_CONTENT"},
    ]});
    const task = await harness.scheduledTaskStore.createTask({
      sessionId: "session-panda",
      createdByIdentityId: "identity-patrik",
      title: "Visible safe wakeup title",
      instruction: "HOME_PRIVATE_INSTRUCTION_MUST_NOT_LEAK",
      schedule: {kind: "once", runAt: "2040-01-02T10:00:00.000Z"},
    });
    await harness.pool.query(`
      INSERT INTO "runtime"."scheduled_task_runs" (id, task_id, session_id, scheduled_for, status, error, created_at, started_at, finished_at)
      VALUES ('00000000-0000-0000-0000-000000000301', $1, 'session-panda', '2039-12-31T10:00:00.000Z', 'failed', 'HOME_RAW_RUN_ERROR_MUST_NOT_LEAK', '2039-12-31T10:01:00.000Z', '2039-12-31T10:01:00.000Z', '2039-12-31T10:02:00.000Z')
    `, [task.id]);
    await harness.auth.recordAudit({
      identityId: "identity-patrik",
      sessionId: "00000000-0000-0000-0000-000000000399",
      eventType: "session_heartbeat_config_write",
      metadata: {action: "patch", agentKey: "panda", targetSessionId: "session-panda", old: {enabled: true, everyMinutes: 60, nextFireAt: "2039-01-01T00:00:00.000Z", secret: "AUDIT_UNKNOWN_METADATA_MUST_NOT_LEAK"}, next: {enabled: false, everyMinutes: 60, nextFireAt: "2040-01-01T00:00:00.000Z"}},
    });
    const base = await startHarnessServer(harness);
    const scoped = await login(base, harness, "scoped", "panda");

    const response = await fetch(`${base}/api/control/home`, {headers: {cookie: scoped.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {home: Record<string, any>};
    expect(typeof body.home.generatedAt).toBe("string");
    expect(body.home.scope).toMatchObject({identityId: "identity-patrik", role: "scoped", visibleAgentCount: 1, visibleSessionCount: 1});
    expect(body.home.status.level).toBe("attention");
    expect(body.home.status.reasonCodes).toEqual(expect.arrayContaining(["blocked_todos", "in_progress_todos", "failed_task", "disabled_heartbeat"]));
    expect(body.home.attentionItems.map((item: {type: string}) => item.type)).toEqual(expect.arrayContaining(["blocked_todos", "in_progress_todos", "failed_task", "disabled_heartbeat"]));
    expect(body.home.sessions[0]).toMatchObject({
      agentKey: "panda",
      sessionId: "session-panda",
      label: "Panda mission control",
      heartbeat: {enabled: false, everyMinutes: 60, nextFireAt: "2040-01-01T00:00:00.000Z"},
      todoCounts: {pending: 0, in_progress: 1, blocked: 1, done: 1},
      lastTaskStatus: "failed",
    });
    expect(body.home.upcomingAutomations[0]).toMatchObject({taskId: task.id, agentKey: "panda", sessionId: "session-panda", title: "Visible safe wakeup title", scheduleKind: "once"});
    expect(body.home.recentActivity.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.home.recentActivity)).toContain("session_heartbeat_config_write");
  });

  it("redacts todo content, scheduled instructions, raw errors, credential values, and unknown audit metadata", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.sessions.replaceSessionTodo({sessionId: "session-panda", items: [{status: "blocked", content: "HOME_TODO_CONTENT_MUST_NOT_LEAK"}]});
    const task = await harness.scheduledTaskStore.createTask({
      sessionId: "session-panda",
      title: "Safe home title",
      instruction: "HOME_SCHEDULED_INSTRUCTION_MUST_NOT_LEAK",
      schedule: {kind: "once", runAt: "2040-03-01T10:00:00.000Z"},
    });
    await harness.pool.query(`
      INSERT INTO "runtime"."scheduled_task_runs" (id, task_id, session_id, scheduled_for, status, error, created_at, started_at, finished_at)
      VALUES ('00000000-0000-0000-0000-000000000302', $1, 'session-panda', '2040-02-28T10:00:00.000Z', 'failed', 'HOME_RUN_ERROR_MUST_NOT_LEAK', '2040-02-28T10:01:00.000Z', '2040-02-28T10:01:00.000Z', '2040-02-28T10:02:00.000Z')
    `, [task.id]);
    await harness.auth.recordAudit({identityId: "identity-patrik", sessionId: "00000000-0000-0000-0000-000000000399", eventType: "unknown_future_event", metadata: {secret: "HOME_AUDIT_METADATA_MUST_NOT_LEAK", agentKey: "panda"}});
    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");

    const response = await fetch(`${base}/api/control/home`, {headers: {cookie: admin.cookies}});
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("Safe home title");
    for (const forbidden of [
      "HOME_TODO_CONTENT_MUST_NOT_LEAK",
      "HOME_SCHEDULED_INSTRUCTION_MUST_NOT_LEAK",
      "HOME_RUN_ERROR_MUST_NOT_LEAK",
      "HOME_AUDIT_METADATA_MUST_NOT_LEAK",
      "SECRET_SENTINEL",
      "5345435245545f53454e54494e454c",
      "value_ciphertext",
      "instruction",
      "error",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("is read-only: no CSRF required and no audit rows are created by GET home", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");
    const before = await harness.pool.query(`SELECT COUNT(*)::int AS count FROM "runtime"."control_audit_events"`);

    const response = await fetch(`${base}/api/control/home`, {headers: {cookie: admin.cookies}});
    expect(response.status).toBe(200);

    const after = await harness.pool.query(`SELECT COUNT(*)::int AS count FROM "runtime"."control_audit_events"`);
    expect(Number((after.rows[0] as Record<string, unknown>).count)).toBe(Number((before.rows[0] as Record<string, unknown>).count));
  });
});
