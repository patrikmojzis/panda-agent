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
import {ControlBriefingService} from "../src/domain/control/briefing-service.js";
import {ControlHeartbeatService} from "../src/domain/control/heartbeat-service.js";
import {ControlTodoService} from "../src/domain/control/todo-service.js";
import {CONTROL_SESSION_COOKIE, startControlServer, type ControlHttpServer} from "../src/integrations/control/http-server.js";

const pools: Array<{end(): Promise<void>}> = [];
const servers: ControlHttpServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (pools.length > 0) await pools.pop()?.end();
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, {recursive: true, force: true});
});

async function createHarness() {
  const db = newDb();
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
  const briefings = new ControlBriefingService({pool, sessions});
  const heartbeats = new ControlHeartbeatService({pool, sessions});
  const todos = new ControlTodoService({pool, sessions});
  await identities.ensureSchema();
  await agents.ensureSchema();
  await sessions.ensureSchema();
  await threads.ensureSchema();
  await credentials.ensureSchema();
  await auth.ensureSchema();

  await identities.createIdentity({id: "identity-patrik", handle: "patrik", displayName: "Patrik"});
  await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda", prompts: DEFAULT_AGENT_PROMPT_TEMPLATES});
  await agents.bootstrapAgent({agentKey: "luna", displayName: "Luna", prompts: DEFAULT_AGENT_PROMPT_TEMPLATES});
  await sessions.createSessionRecord({id: "session-panda", agentKey: "panda", kind: "main", currentThreadId: "thread-panda", createdByIdentityId: "identity-patrik"});
  await sessions.createSessionRecord({id: "session-luna", agentKey: "luna", kind: "main", currentThreadId: "thread-luna", createdByIdentityId: "identity-patrik"});
  await pool.query(`
    INSERT INTO "runtime"."credentials" (id, env_key, agent_key, value_ciphertext, value_iv, value_tag, key_version)
    VALUES ('00000000-0000-0000-0000-000000000001', 'API_TOKEN', 'panda', '\\x5345435245545f53454e54494e454c', '\\x6976', '\\x746167', 1)
  `);
  return {pool, agents, sessions, auth, reads, briefings, heartbeats, todos};
}

async function startHarnessServer(harness: Awaited<ReturnType<typeof createHarness>>) {
  const server = await startControlServer({host: "127.0.0.1", port: 0, auth: harness.auth, reads: harness.reads, briefings: harness.briefings, heartbeats: harness.heartbeats, todos: harness.todos});
  servers.push(server);
  return `http://${server.host}:${server.port}`;
}

function cookieHeader(response: Response): string {
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookies = raw.length > 0 ? raw : [response.headers.get("set-cookie") ?? ""];
  return cookies.map((cookie) => cookie.split(";")[0]).filter(Boolean).join("; ");
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
    expect(cookies).toContain(CONTROL_SESSION_COOKIE);
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

    expect((await fetch(`${base}/api/control/logout`, {method: "POST", headers: {cookie: cookies, "x-control-csrf": loginBody.csrfToken}})).status).toBe(200);
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
    const server = await startControlServer({host: "127.0.0.1", port: 0, auth: harness.auth, reads: harness.reads, briefings: harness.briefings, heartbeats: harness.heartbeats, todos: harness.todos, uiStaticDir: staticDir});
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
