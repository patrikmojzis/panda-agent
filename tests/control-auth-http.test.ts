import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {PostgresCredentialStore} from "../src/domain/credentials/postgres.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/postgres.js";
import {PostgresControlAuthService} from "../src/domain/control/auth.js";
import {ControlReadService} from "../src/domain/control/read-service.js";
import {CONTROL_SESSION_COOKIE, startControlServer, type ControlHttpServer} from "../src/integrations/control/http-server.js";

const pools: Array<{end(): Promise<void>}> = [];
const servers: ControlHttpServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (pools.length > 0) await pools.pop()?.end();
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
  return {pool, agents, auth, reads};
}

async function startHarnessServer(harness: Awaited<ReturnType<typeof createHarness>>) {
  const server = await startControlServer({host: "127.0.0.1", port: 0, auth: harness.auth, reads: harness.reads});
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
      } as ControlReadService,
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
