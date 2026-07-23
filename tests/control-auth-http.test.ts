import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {PostgresExecutionEnvironmentStore} from "../src/domain/execution-environments/postgres.js";
import {PostgresCredentialStore} from "../src/domain/credentials/postgres.js";
import {CredentialService} from "../src/domain/credentials/resolver.js";
import {PostgresMcpConfigStore} from "../src/domain/mcp/postgres.js";
import {ControlMcpService} from "../src/domain/control/mcp-service.js";
import {McpManagementService, type McpOAuthManager} from "../src/domain/mcp/management-service.js";
import {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/postgres.js";
import {PostgresControlAuthService} from "../src/domain/control/auth.js";
import {ControlReadService} from "../src/domain/control/read-service.js";
import {ControlHomeService} from "../src/domain/control/home-service.js";
import {ControlOperatorService} from "../src/domain/control/operator-service.js";
import {ControlBriefingService} from "../src/domain/control/briefing-service.js";
import {ControlHeartbeatService} from "../src/domain/control/heartbeat-service.js";
import {ControlScheduledTasksService} from "../src/domain/control/scheduled-tasks-service.js";
import {ControlWatchesService} from "../src/domain/control/watches-service.js";
import {ControlRuntimeActivityService} from "../src/domain/control/runtime-activity-service.js";
import {ControlConnectorAccountsService} from "../src/domain/control/connector-accounts-service.js";
import {ControlModelCallTraceService} from "../src/domain/control/model-call-trace-service.js";
import {PostgresModelCallTraceStore} from "../src/domain/model-call-traces/postgres.js";
import {A2ASessionBindingRepo} from "../src/domain/a2a/repo.js";
import {PostgresConnectorAccountStore} from "../src/domain/connectors/postgres.js";
import {PostgresEmailStore} from "../src/domain/email/postgres.js";
import {ConversationRepo} from "../src/domain/sessions/conversations/repo.js";
import {PostgresGatewayStore} from "../src/domain/gateway/postgres.js";
import {PostgresWikiBindingStore} from "../src/domain/wiki/postgres.js";
import {WikiBindingService} from "../src/domain/wiki/service.js";
import {PostgresWatchStore} from "../src/domain/watches/postgres.js";
import {PostgresScheduledTaskStore} from "../src/domain/scheduling/tasks/postgres.js";
import {
    CONTROL_CSRF_COOKIE,
    CONTROL_SESSION_COOKIE,
    type ControlHttpServer,
    startControlServer
} from "../src/integrations/control/http-server.js";

// This file boots several pg-mem-backed integration harnesses and local HTTP servers.
// Keep the timeout explicit so the default Vitest 5s limit does not make CI/load-dependent runs flaky.
vi.setConfig({testTimeout: 30_000});

const pools: Array<{end(): Promise<void>}> = [];
const servers: ControlHttpServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (pools.length > 0) await pools.pop()?.end();
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, {recursive: true, force: true});
});

async function createHarness(options: {
  telegramBotIdentityClient?: { getBotIdentity(token: string): Promise<{id: string; username?: string; displayName?: string}> };
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  mcpOAuth?: McpOAuthManager;
} = {}) {
  const db = newDb({noAstCoverageCheck: true});
  db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  pools.push(pool);

  const identities = new PostgresIdentityStore({pool});
  const agents = new PostgresAgentStore({pool});
  const sessions = new PostgresSessionStore({pool});
  const executionEnvironments = new PostgresExecutionEnvironmentStore({pool});
  const credentials = new PostgresCredentialStore({pool});
  const mcpConfigs = new PostgresMcpConfigStore(pool);
  const threads = new PostgresThreadRuntimeStore({pool});
  const auth = new PostgresControlAuthService({pool});
  const reads = new ControlReadService({pool});
  const home = new ControlHomeService({pool, reads});
  const briefings = new ControlBriefingService({pool, sessions});
  const heartbeats = new ControlHeartbeatService({pool, sessions});
  const scheduledTaskStore = new PostgresScheduledTaskStore({pool});
  const watchStore = new PostgresWatchStore({pool});
  const controlScheduledTasks = new ControlScheduledTasksService({pool, store: scheduledTaskStore});
  const controlWatches = new ControlWatchesService({pool, store: watchStore});
  const controlRuntimeActivity = new ControlRuntimeActivityService({pool});
  const connectorAccountStore = new PostgresConnectorAccountStore({pool});
  const controlConnectorAccounts = new ControlConnectorAccountsService({pool});
  const modelCallTraces = new PostgresModelCallTraceStore({pool});
  const controlModelCallTraces = new ControlModelCallTraceService({pool});
  const a2aBindings = new A2ASessionBindingRepo({pool});
  const emailStore = new PostgresEmailStore({pool});
  const conversations = new ConversationRepo({pool});
  const gatewayStore = new PostgresGatewayStore({pool});
  const wikiBindingStore = new PostgresWikiBindingStore({pool});
  const credentialCrypto = new CredentialCrypto("control-test-master-key");
  const credentialService = new CredentialService({store: credentials, crypto: credentialCrypto});
  const mcpManagement = new McpManagementService({
    configs: mcpConfigs,
    credentials: credentialService,
    runner: {
      async listTools() { return {value: {tools: []}, diagnostics: {transport: "stdio", stderr: "", stderrTruncated: false}}; },
      async callTool() { throw new Error("Control test runner does not call MCP tools."); },
    },
    oauth: options.mcpOAuth,
    audit: auth,
  });
  const controlMcp = new ControlMcpService({reads, management: mcpManagement});
  const wikiBindingService = new WikiBindingService({store: wikiBindingStore, crypto: credentialCrypto});
  const operator = new ControlOperatorService({
    pool,
    reads,
    a2aBindings,
    agents,
    sessions,
    executionEnvironments,
    threads,
    identities,
    credentials: credentialService,
    email: emailStore,
    connectorAccounts: connectorAccountStore,
    connectorCrypto: credentialCrypto,
    conversations,
    gateway: gatewayStore,
    subagents: {
      ensureSchema: async () => {},
      seedBuiltinProfiles: async () => [],
      upsertProfile: async () => {
        throw new Error("not implemented");
      },
      getProfile: async () => null,
      listProfiles: async () => [],
      setProfileEnabled: async () => {
        throw new Error("not implemented");
      },
    },
    wikiBindings: {
      store: wikiBindingStore,
      service: wikiBindingService,
    },
    telegramBotIdentityClient: options.telegramBotIdentityClient ?? {
      getBotIdentity: async () => ({id: "424242", username: "panda_bot", displayName: "Panda Bot"}),
    },
    fetchImpl: options.fetchImpl,
    env: options.env,
  });
  await identities.ensureSchema();
  await agents.ensureSchema();
  await sessions.ensureSchema();
  await executionEnvironments.ensureSchema();
  await threads.ensureSchema();
  await credentials.ensureSchema();
  await mcpConfigs.ensureSchema();
  await auth.ensureSchema();
  await scheduledTaskStore.ensureSchema();
  await watchStore.ensureSchema();
  await connectorAccountStore.ensureSchema();
  await modelCallTraces.ensureSchema();
  await a2aBindings.ensureSchema();
  await emailStore.ensureSchema();
  await conversations.ensureSchema();
  await gatewayStore.ensureSchema();
  await wikiBindingStore.ensureSchema();

  await identities.createIdentity({id: "identity-patrik", handle: "patrik", displayName: "Patrik"});
  await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
  await agents.bootstrapAgent({agentKey: "luna", displayName: "Luna"});
  await sessions.createSessionRecord({id: "session-panda", agentKey: "panda", kind: "main", currentThreadId: "thread-panda", createdByIdentityId: "identity-patrik"});
  await sessions.createSessionRecord({id: "session-luna", agentKey: "luna", kind: "main", currentThreadId: "thread-luna", createdByIdentityId: "identity-patrik"});
  await pool.query(`
    INSERT INTO "runtime"."credentials" (id, env_key, agent_key, value_ciphertext, value_iv, value_tag, key_version)
    VALUES ('00000000-0000-0000-0000-000000000001', 'API_TOKEN', 'panda', '\\x5345435245545f53454e54494e454c', '\\x6976', '\\x746167', 1)
  `);
  return {pool, identities, agents, sessions, executionEnvironments, a2aBindings, auth, reads, home, operator, controlMcp, mcpConfigs, briefings, heartbeats, scheduledTaskStore, watchStore, connectorAccountStore, credentialCrypto, emailStore, wikiBindingStore, controlScheduledTasks, controlWatches, controlRuntimeActivity, controlConnectorAccounts, modelCallTraces, controlModelCallTraces};
}

async function startHarnessServer(harness: Awaited<ReturnType<typeof createHarness>>, options: {env?: NodeJS.ProcessEnv} = {}) {
  const server = await startControlServer({host: "127.0.0.1", port: 0, auth: harness.auth, reads: harness.reads, home: harness.home, operator: harness.operator, mcp: harness.controlMcp, briefings: harness.briefings, heartbeats: harness.heartbeats, scheduledTasks: harness.controlScheduledTasks, watches: harness.controlWatches, runtimeActivity: harness.controlRuntimeActivity, connectorAccounts: harness.controlConnectorAccounts, modelCallTraces: harness.controlModelCallTraces, identityStore: harness.identities, env: options.env});
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

  it("manages agent MCP servers with CSRF, scoped visibility, safe DTOs, counts, and producer-allowlisted raw audit", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role: "admin"});
    const login = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    const loginBody = await login.json() as {csrfToken: string};
    const cookies = cookieHeader(login);
    const config = {
      transport: "stdio",
      enabled: true,
      command: "COMMAND_AUDIT_SENTINEL",
      args: ["ARG_AUDIT_SENTINEL"],
      cwd: "/CWD_AUDIT_SENTINEL",
      env: {
        API_TOKEN: {credentialEnvKey: "API_TOKEN"},
        TENANT: {value: "LITERAL_AUDIT_SENTINEL"},
      },
      timeoutMs: 30_000,
    };

    const noCsrf = await fetch(`${base}/api/control/agents/panda/mcp-servers/fixture`, {
      method: "PUT",
      headers: {cookie: cookies, "content-type": "application/json"},
      body: JSON.stringify(config),
    });
    expect(noCsrf.status).toBe(403);

    const put = await fetch(`${base}/api/control/agents/panda/mcp-servers/fixture`, {
      method: "PUT",
      headers: {cookie: cookies, "content-type": "application/json", "x-control-csrf": loginBody.csrfToken},
      body: JSON.stringify(config),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as {server: Record<string, unknown>; version: number};
    expect(putBody.version).toBe(1);
    expect(putBody.server).toMatchObject({
      serverName: "fixture",
      transport: "stdio",
      command: "COMMAND_AUDIT_SENTINEL",
      args: ["ARG_AUDIT_SENTINEL"],
      credentialEnvKeys: ["API_TOKEN"],
      status: "credential_unreadable",
    });
    expect(JSON.stringify(putBody)).not.toContain("SECRET_SENTINEL");

    const list = await fetch(`${base}/api/control/agents/panda/mcp-servers`, {headers: {cookie: cookies}});
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({count: 1, version: 1, servers: [{serverName: "fixture"}]});
    const stale = await fetch(`${base}/api/control/agents/panda/mcp-servers/fixture`, {
      method: "PUT",
      headers: {cookie: cookies, "content-type": "application/json", "x-control-csrf": loginBody.csrfToken, "if-match": "0"},
      body: JSON.stringify(config),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({error: "stale_version", currentVersion: 1});
    const agent = await fetch(`${base}/api/control/agents/panda`, {headers: {cookie: cookies}});
    await expect(agent.json()).resolves.toMatchObject({agent: {mcpServerCount: 1}});

    const rawAudit = await harness.pool.query(`
      SELECT metadata
      FROM "runtime"."control_audit_events"
      WHERE event_type = 'control_operator_write'
        AND metadata->>'action' = 'put_mcp_server'
    `);
    const metadata = rawAudit.rows[0]?.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "action", "actorKind", "agentKey", "changedFields", "enabled", "outcome", "serverName", "transport",
    ].sort());
    const rawText = JSON.stringify(metadata);
    for (const forbidden of ["COMMAND_AUDIT_SENTINEL", "ARG_AUDIT_SENTINEL", "CWD_AUDIT_SENTINEL", "LITERAL_AUDIT_SENTINEL", "SECRET_SENTINEL", "url", "headers", "auth", "input", "result"]) {
      expect(rawText).not.toContain(forbidden);
    }

    await harness.agents.ensurePairing("panda", "identity-patrik");
    const scopedGrant = await harness.auth.createGrant({identityId: "identity-patrik", role: "scoped", agentKey: "panda"});
    const scopedLogin = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: scopedGrant.loginToken})});
    const scopedCookies = cookieHeader(scopedLogin);
    expect((await fetch(`${base}/api/control/agents/luna/mcp-servers`, {headers: {cookie: scopedCookies}})).status).toBe(404);

    const deleted = await fetch(`${base}/api/control/agents/panda/mcp-servers/fixture`, {
      method: "DELETE",
      headers: {cookie: cookies, "x-control-csrf": loginBody.csrfToken},
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({deleted: true, version: 2});
  });

  it("runs OAuth discovery, manual connect, public callback, replay protection, and disconnect without leaking secrets", async () => {
    let consumed = false;
    let deniedConsumed = false;
    let controlSessionId = "";
    const start = vi.fn(async () => ({authorizationUrl: "https://login.example.test/authorize?state=opaque-state", expiresAt: Date.now() + 60_000}));
    const oauth: McpOAuthManager = {
      status: async () => ({status: consumed ? "ready" : "authorization_required"}),
      discover: async () => ({
        resource: "https://mcp.example.test/mcp",
        resourceMetadataUrl: "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
        authorizationServer: "https://login.example.test",
        supportedScopes: ["resource:read"],
        registrationEndpointAvailable: false,
        tokenEndpointAuthMethods: ["client_secret_basic"],
        blockedOrigins: [],
      }),
      start,
      finish: async (state, code) => {
        if (state !== "opaque-state" || code !== "callback-code" || consumed) throw new Error("invalid state");
        consumed = true;
        return {completed: true, agentKey: "panda", serverName: "oauth-server", initiator: {kind: "control", identityId: "identity-patrik", sessionId: controlSessionId}, issuer: "https://login.example.test", scopes: ["resource:read"]};
      },
      fail: async (state) => {
        if (state !== "denied-state" || deniedConsumed) throw new Error("invalid state");
        deniedConsumed = true;
        return {agentKey: "panda", serverName: "oauth-server", initiator: {kind: "control", identityId: "identity-patrik", sessionId: controlSessionId}};
      },
      disconnect: async () => ({disconnected: true, remoteRevocation: "succeeded"}),
      deleteConnection: async () => true,
      invalidate: async () => {},
    };
    const harness = await createHarness({mcpOAuth: oauth});
    const base = await startHarnessServer(harness);
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role: "admin"});
    const login = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    const loginBody = await login.json() as {csrfToken: string; session: {id: string}};
    controlSessionId = loginBody.session.id;
    const cookies = cookieHeader(login);
    const headers = {cookie: cookies, "content-type": "application/json", "x-control-csrf": loginBody.csrfToken};
    const config = {
      transport: "streamable-http",
      enabled: true,
      url: "https://mcp.example.test/mcp",
      auth: {type: "oauth", registration: {mode: "manual"}, scope: {mode: "explicit", values: ["resource:read"]}},
      timeoutMs: 30_000,
    };
    expect((await fetch(`${base}/api/control/agents/panda/mcp-servers/oauth-server`, {method: "PUT", headers, body: JSON.stringify(config)})).status).toBe(200);

    expect((await fetch(`${base}/api/control/agents/panda/mcp-servers/oauth-server/oauth/discover`, {method: "POST", headers: {cookie: cookies}})).status).toBe(403);
    const discovery = await fetch(`${base}/api/control/agents/panda/mcp-servers/oauth-server/oauth/discover`, {method: "POST", headers});
    await expect(discovery.json()).resolves.toMatchObject({discovery: {supportedScopes: ["resource:read"], blockedOrigins: []}});

    const secret = "CLIENT_SECRET_SENTINEL";
    const connect = await fetch(`${base}/api/control/agents/panda/mcp-servers/oauth-server/oauth/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({manualClient: {clientId: "client-id", clientSecret: secret, tokenEndpointAuthMethod: "client_secret_basic"}}),
    });
    const connectText = await connect.text();
    expect(connect.status).toBe(200);
    expect(connectText).not.toContain(secret);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({manualClient: expect.objectContaining({clientSecret: secret})}));

    const callback = await fetch(`${base}/api/control/mcp/oauth/callback?state=opaque-state&code=callback-code`);
    expect(callback.status).toBe(200);
    expect(callback.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await callback.text()).not.toContain("callback-code");
    expect((await fetch(`${base}/api/control/mcp/oauth/callback?state=opaque-state&code=callback-code`)).status).toBe(400);
    expect((await fetch(`${base}/api/control/mcp/oauth/callback?state=denied-state&error=access_denied`)).status).toBe(400);
    expect((await fetch(`${base}/api/control/mcp/oauth/callback?state=denied-state&error=access_denied`)).status).toBe(400);

    const listText = await (await fetch(`${base}/api/control/agents/panda/mcp-servers`, {headers: {cookie: cookies}})).text();
    expect(listText).toContain('"status":"ready"');
    expect(listText).not.toContain(secret);
    const disconnected = await fetch(`${base}/api/control/agents/panda/mcp-servers/oauth-server/oauth`, {method: "DELETE", headers});
    await expect(disconnected.json()).resolves.toEqual({disconnected: true});

    const audits = await harness.pool.query(`SELECT metadata FROM "runtime"."control_audit_events" WHERE metadata->>'action' LIKE '%mcp_oauth'`);
    const auditText = JSON.stringify(audits.rows);
    expect(auditText).toContain("complete_mcp_oauth");
    expect(auditText).toContain("disconnect_mcp_oauth");
    expect(auditText).toContain("fail_mcp_oauth");
    expect(auditText).not.toContain(secret);
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

  it("lists session execution targets with scoped private health and no runner secrets", async () => {
    const healthFetch = vi.fn(async () => new Response(JSON.stringify({ok: true}), {
      status: 200,
      headers: {"content-type": "application/json"},
    }));
    const harness = await createHarness({fetchImpl: healthFetch as unknown as typeof fetch});
    await harness.executionEnvironments.createEnvironment({
      id: "env-vps-secret",
      agentKey: "panda",
      kind: "persistent_agent_runner",
      runnerUrl: "http://runner-vps.internal:8080/agent/panda",
      metadata: {privateLabel: "do-not-leak"},
    });
    await harness.executionEnvironments.bindSession({
      sessionId: "session-panda",
      environmentId: "env-vps-secret",
      alias: "VPS",
    });
    const base = await startHarnessServer(harness);
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role: "scoped", agentKey: "panda"});
    const login = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    const loginBody = await login.json() as {csrfToken: string};
    const cookies = cookieHeader(login);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/targets`, {headers: {cookie: cookies}});

    expect(response.status).toBe(200);
    const body = await response.json() as {targets: Array<Record<string, unknown>>};
    expect(body.targets).toEqual([
      {alias: "default", kind: "local", state: "ready", label: "Default", health: "not_applicable"},
      {alias: "vps", kind: "persistent_agent_runner", state: "ready", label: "vps", health: "reachable"},
    ]);
    expect(Object.keys(body.targets[1]!).sort()).toEqual(["alias", "health", "kind", "label", "state"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("env-vps-secret");
    expect(serialized).not.toContain("runner-vps");
    expect(serialized).not.toContain("do-not-leak");
    expect(healthFetch).toHaveBeenCalledTimes(1);
    expect(String(healthFetch.mock.calls[0]?.[0])).toContain("/health");
    const healthInit = healthFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(healthInit?.headers).has("authorization")).toBe(false);

    const bind = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/targets`, {
      method: "POST",
      headers: {cookie: cookies, "x-control-csrf": loginBody.csrfToken},
      body: JSON.stringify({
        alias: "do",
        runnerUrl: "http://runner-do.internal:8080",
        runnerCwd: "/workspace",
        allowTools: ["bash", "view_media"],
      }),
    });
    expect(bind.status).toBe(200);
    const bindBody = await bind.json() as {target: Record<string, unknown>; targets: Array<Record<string, unknown>>};
    expect(bindBody.target).toMatchObject({
      alias: "do",
      kind: "persistent_agent_runner",
      state: "ready",
      label: "do",
      health: "reachable",
    });
    expect(JSON.stringify(bindBody)).not.toContain("runner-do");
    await expect(harness.executionEnvironments.getBindingByAlias("session-panda", "do")).resolves.toMatchObject({
      toolPolicy: {allowedTools: ["bash", "view_media"]},
    });

    const detach = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/targets/do`, {
      method: "DELETE",
      headers: {cookie: cookies, "x-control-csrf": loginBody.csrfToken},
    });
    expect(detach.status).toBe(200);
    await expect(harness.executionEnvironments.getBindingByAlias("session-panda", "do")).resolves.toBeNull();

    const crossSession = await fetch(`${base}/api/control/agents/luna/sessions/session-luna/targets`, {headers: {cookie: cookies}});
    expect(crossSession.status).toBe(404);
  });

  it("can remember a trusted Control browser session with a longer persistent cookie", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role: "scoped", agentKey: "panda"});

    const login = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken, remember: true})});
    expect(login.status).toBe(200);
    const body = await login.json() as {session: {role: string; expiresAt: string}; csrfToken: string};
    expect(body.session.role).toBe("scoped");
    expect(Date.parse(body.session.expiresAt)).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);

    const setCookies = setCookieHeaders(login);
    expect(setCookies.find((cookie) => cookie.startsWith(`${CONTROL_SESSION_COOKIE}=`))).toContain("Max-Age=2592000");
    expect(setCookies.find((cookie) => cookie.startsWith(`${CONTROL_SESSION_COOKIE}=`))).toContain("HttpOnly");
    expect(setCookies.find((cookie) => cookie.startsWith(`${CONTROL_CSRF_COOKIE}=`))).toContain("Max-Age=2592000");
    expect(setCookies.find((cookie) => cookie.startsWith(`${CONTROL_CSRF_COOKIE}=`))).not.toContain("HttpOnly");

    const cookies = cookieHeader(login);
    const me = await fetch(`${base}/api/control/me`, {headers: {cookie: cookies}});
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toEqual({session: expect.objectContaining({role: "scoped"})});

    const stored = await harness.pool.query(`SELECT expires_at > NOW() + INTERVAL '29 days' AS long_lived FROM "runtime"."control_sessions"`);
    expect(stored.rows).toEqual([expect.objectContaining({long_lived: true})]);
  });

  it("keeps dev login unavailable unless explicitly enabled", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);

    const response = await fetch(`${base}/api/control/dev-login`, {method: "POST"});
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({error: "Control dev login is not available in this environment."});
  });

  it("logs in with the dev bootstrap identity when enabled", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness, {env: {PANDA_CONTROL_DEV_LOGIN_ENABLED: "true"}});

    const response = await fetch(`${base}/api/control/dev-login`, {method: "POST"});
    expect(response.status).toBe(200);
    const body = await response.json() as {csrfToken: string};
    expect(body.csrfToken).toMatch(/^pcc_/);
    const cookies = cookieHeader(response);
    expect(cookies).toContain(CONTROL_SESSION_COOKIE);

    const me = await fetch(`${base}/api/control/me`, {headers: {cookie: cookies}});
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({session: {identityId: "identity-patrik", role: "admin"}});
  });

  it("refuses dev login in production even when the flag is set", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness, {env: {NODE_ENV: "production", PANDA_CONTROL_DEV_LOGIN_ENABLED: "true"}});

    const response = await fetch(`${base}/api/control/dev-login`, {method: "POST", body: JSON.stringify({identity: "patrik"})});
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({error: "Control dev login is not allowed in this environment."});
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
      operator: harness.operator,
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
      scheduledTasks: harness.controlScheduledTasks,
      watches: harness.controlWatches,
      runtimeActivity: harness.controlRuntimeActivity,
      connectorAccounts: harness.controlConnectorAccounts,
      modelCallTraces: harness.controlModelCallTraces,
      identityStore: harness.identities,
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
    await writeFile(join(staticDir, "assets", "geist.woff2"), "font");
    const server = await startControlServer({host: "127.0.0.1", port: 0, auth: harness.auth, reads: harness.reads, home: harness.home, operator: harness.operator, briefings: harness.briefings, heartbeats: harness.heartbeats, scheduledTasks: harness.controlScheduledTasks, watches: harness.controlWatches, runtimeActivity: harness.controlRuntimeActivity, connectorAccounts: harness.controlConnectorAccounts, modelCallTraces: harness.controlModelCallTraces, identityStore: harness.identities, uiStaticDir: staticDir});
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

    const font = await fetch(`${base}/assets/geist.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toContain("font/woff2");

    const api = await fetch(`${base}/api/control/health`);
    expect(api.status).toBe(200);
    expect(api.headers.get("content-type")).toContain("application/json");
    await expect(api.json()).resolves.toEqual({ok: true});

    const nonControlApi = await fetch(`${base}/api/not-control`);
    expect(nonControlApi.status).toBe(404);
    expect(nonControlApi.headers.get("content-type")).toContain("application/json");
    await expect(nonControlApi.json()).resolves.toEqual({error: "not_found"});
  });

  it("does not expose the removed session todo endpoint", async () => {
    const harness = await createHarness();
    await harness.sessions.replaceSessionTodo({sessionId: "session-panda", items: [
      {status: "blocked", content: "REMOVED_CONTROL_TODO_CONTENT"},
    ]});
    const base = await startHarnessServer(harness);
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role: "admin"});
    const login = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(login.status).toBe(200);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/todos`, {headers: {cookie: cookieHeader(login)}});
    expect(response.status).toBe(404);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("REMOVED_CONTROL_TODO_CONTENT");
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

describe("Control operator HTTP", () => {
  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>) {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role: "admin"});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    const body = await response.json() as {csrfToken: string};
    return {cookies: cookieHeader(response), csrfToken: body.csrfToken};
  }

  it("returns agents and sessions with the table contract", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const agents = await fetch(`${base}/api/control/agents?page=1&per_page=10&search=pan`, {headers: {cookie: auth.cookies}});
    expect(agents.status).toBe(200);
    await expect(agents.json()).resolves.toMatchObject({
      meta: {current_page: 1, per_page: 10},
      data: [{agentKey: "panda", sessionCount: 1}],
    });

    const sessions = await fetch(`${base}/api/control/agents/panda/sessions`, {headers: {cookie: auth.cookies}});
    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toMatchObject({
      data: [{id: "session-panda", agentKey: "panda", currentThreadId: "thread-panda"}],
    });
  });

  it("manages agent identity pairings through the agent access route", async () => {
    const harness = await createHarness();
    await harness.identities.createIdentity({id: "identity-ana", handle: "ana", displayName: "Ana"});
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const initial = await fetch(`${base}/api/control/agents/panda/pairings`, {headers: {cookie: auth.cookies}});
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      data: [],
      meta: {total: 0},
    });

    const missingCsrf = await fetch(`${base}/api/control/agents/panda/pairings`, {
      method: "POST",
      headers: {cookie: auth.cookies},
      body: JSON.stringify({identityId: "identity-ana"}),
    });
    expect(missingCsrf.status).toBe(403);

    const created = await fetch(`${base}/api/control/agents/panda/pairings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({identityId: "identity-ana"}),
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      pairing: {
        agentKey: "panda",
        identityId: "identity-ana",
        identityHandle: "ana",
        identityDisplayName: "Ana",
      },
    });

    const agent = await fetch(`${base}/api/control/agents/panda`, {headers: {cookie: auth.cookies}});
    expect(agent.status).toBe(200);
    await expect(agent.json()).resolves.toMatchObject({agent: {pairingCount: 1}});

    const filtered = await fetch(`${base}/api/control/agents/panda/pairings?status=active&search=ana`, {headers: {cookie: auth.cookies}});
    expect(filtered.status).toBe(200);
    await expect(filtered.json()).resolves.toMatchObject({
      data: [expect.objectContaining({identityHandle: "ana"})],
      meta: {total: 1},
    });

    const invalidFilter = await fetch(`${base}/api/control/agents/panda/pairings?status=suspended`, {headers: {cookie: auth.cookies}});
    expect(invalidFilter.status).toBe(400);
    await expect(invalidFilter.json()).resolves.toEqual({error: "Control identity status filter must be active or deleted."});

    const audit = await fetch(`${base}/api/control/audit-events?eventType=control_operator_write&agentKey=panda`, {headers: {cookie: auth.cookies}});
    expect(audit.status).toBe(200);
    const auditText = JSON.stringify(await audit.json());
    expect(auditText).toContain("pair_agent_identity");
    expect(auditText).toContain("\"identityHandle\":\"ana\"");
    expect(auditText).not.toContain("identity-ana");

    const deleted = await fetch(`${base}/api/control/agents/panda/pairings/identity-ana`, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
    });
    expect(deleted.status).toBe(200);
    await expect(harness.agents.listAgentPairings("panda")).resolves.toEqual([]);
  });

  it("manages identities through the top-level Control route", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const missingCsrf = await fetch(`${base}/api/control/identities`, {
      method: "POST",
      headers: {cookie: auth.cookies},
      body: JSON.stringify({handle: "nina", displayName: "Nina"}),
    });
    expect(missingCsrf.status).toBe(403);

    const created = await fetch(`${base}/api/control/identities`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({handle: "NINA", displayName: "Nina Operator"}),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as {identity: {id: string; handle: string; displayName: string; status: string}};
    expect(createdBody.identity).toMatchObject({
      handle: "nina",
      displayName: "Nina Operator",
      status: "active",
    });

    const updated = await fetch(`${base}/api/control/identities/${encodeURIComponent(createdBody.identity.id)}`, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({displayName: "Nina Updated"}),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      identity: {
        handle: "nina",
        displayName: "Nina Updated",
        status: "active",
      },
    });

    const active = await fetch(`${base}/api/control/identities?status=active&search=nina`, {headers: {cookie: auth.cookies}});
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toMatchObject({
      data: [expect.objectContaining({handle: "nina"})],
      meta: {total: 1},
    });

    const disabled = await fetch(`${base}/api/control/identities/${encodeURIComponent(createdBody.identity.id)}`, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      identity: {handle: "nina", status: "deleted"},
    });

    const deleted = await fetch(`${base}/api/control/identities?status=deleted&search=nina`, {headers: {cookie: auth.cookies}});
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      data: [expect.objectContaining({handle: "nina", status: "deleted"})],
      meta: {total: 1},
    });

    await harness.agents.ensurePairing("panda", "identity-patrik");
    const scopedGrant = await harness.auth.createGrant({identityId: "identity-patrik", role: "scoped", agentKey: "panda"});
    const scopedLogin = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: scopedGrant.loginToken})});
    expect(scopedLogin.status).toBe(200);
    const scopedBody = await scopedLogin.json() as {csrfToken: string};
    const scopedCookies = cookieHeader(scopedLogin);
    const scopedCreate = await fetch(`${base}/api/control/identities`, {
      method: "POST",
      headers: {cookie: scopedCookies, "x-control-csrf": scopedBody.csrfToken},
      body: JSON.stringify({handle: "scoped"}),
    });
    expect(scopedCreate.status).toBe(403);
    await expect(scopedCreate.json()).resolves.toEqual({error: "Control identity management requires admin access."});

    const audit = await fetch(`${base}/api/control/audit-events?eventType=control_operator_write`, {headers: {cookie: auth.cookies}});
    expect(audit.status).toBe(200);
    const auditText = JSON.stringify(await audit.json());
    expect(auditText).toContain("create_identity");
    expect(auditText).toContain("disable_identity");
    expect(auditText).toContain("\"identityHandle\":\"nina\"");
    expect(auditText).not.toContain(createdBody.identity.id);
  });

  it("updates session runtime defaults through a scoped session route", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);
    const path = `${base}/api/control/agents/panda/sessions/session-panda/runtime-config`;

    const missingCsrf = await fetch(path, {
      method: "PATCH",
      headers: {cookie: auth.cookies},
      body: JSON.stringify({model: "openai/gpt-5.1", thinking: "high"}),
    });
    expect(missingCsrf.status).toBe(403);

    const saved = await fetch(path, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({model: "openai/gpt-5.1", thinking: "high"}),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      session: {
        runtime: {
          model: "openai/gpt-5.1",
          thinking: "high",
          thinkingConfigured: true,
        },
      },
    });

    const explicitOff = await fetch(path, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({thinking: "off"}),
    });
    expect(explicitOff.status).toBe(200);
    await expect(explicitOff.json()).resolves.toMatchObject({
      session: {runtime: {thinkingConfigured: true}},
    });
    const explicitOffRuntime = await harness.sessions.getSessionRuntimeConfig("session-panda");
    expect(explicitOffRuntime.model).toBe("openai/gpt-5.1");
    expect(explicitOffRuntime.thinking).toBeUndefined();
    expect(explicitOffRuntime.thinkingConfigured).toBe(true);

    const cleared = await fetch(path, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({model: null, thinking: "default"}),
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      session: {runtime: {thinkingConfigured: false}},
    });
    const clearedRuntime = await harness.sessions.getSessionRuntimeConfig("session-panda");
    expect(clearedRuntime.model).toBeUndefined();
    expect(clearedRuntime.thinking).toBeUndefined();
    expect(clearedRuntime.thinkingConfigured).toBe(false);

    const invalid = await fetch(path, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({thinking: "worker"}),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      error: "Session runtime thinking must be default, off, low, medium, high, or xhigh.",
    });
  });

  it("manages A2A session bindings through session workspace routes", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);
    const path = `${base}/api/control/agents/panda/sessions/session-panda/a2a-bindings`;

    const initial = await fetch(path, {headers: {cookie: auth.cookies}});
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      data: [],
      meta: {total: 0},
    });

    const missingCsrf = await fetch(path, {
      method: "POST",
      headers: {cookie: auth.cookies},
      body: JSON.stringify({recipientSessionId: "session-luna"}),
    });
    expect(missingCsrf.status).toBe(403);

    const created = await fetch(path, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({recipientSessionId: "session-luna"}),
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      bindings: [
        expect.objectContaining({
          senderSessionId: "session-panda",
          recipientSessionId: "session-luna",
          direction: "outbound",
        }),
        expect.objectContaining({
          senderSessionId: "session-luna",
          recipientSessionId: "session-panda",
          direction: "inbound",
        }),
      ],
    });

    const outbound = await fetch(`${path}?direction=outbound&search=luna`, {headers: {cookie: auth.cookies}});
    expect(outbound.status).toBe(200);
    await expect(outbound.json()).resolves.toMatchObject({
      data: [expect.objectContaining({recipientAgentKey: "luna", direction: "outbound"})],
      meta: {total: 1},
    });

    const deleted = await fetch(`${path}/session-luna`, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({direction: "outbound"}),
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({deleted: true, reverseDeleted: true});
    await expect(harness.a2aBindings.listBindings({senderSessionId: "session-panda"})).resolves.toEqual([]);
    await expect(harness.a2aBindings.listBindings({senderSessionId: "session-luna"})).resolves.toEqual([]);

    const audit = await fetch(`${base}/api/control/audit-events?eventType=control_operator_write&agentKey=panda&targetSessionId=session-panda`, {headers: {cookie: auth.cookies}});
    expect(audit.status).toBe(200);
    const auditText = JSON.stringify(await audit.json());
    expect(auditText).toContain("bind_a2a_session");
    expect(auditText).toContain("delete_a2a_session_binding");
    expect(auditText).toContain("\"peerSessionId\":\"session-luna\"");
  });

  it("filters agent sessions by kind and visibility", async () => {
    const harness = await createHarness();
    const createdBranch = await harness.sessions.createSessionRecord({
      id: "session-panda-branch",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-panda-branch",
      createdByIdentityId: "identity-patrik",
    });
    const createdSubagent = await harness.sessions.createSessionRecord({
      id: "session-panda-subagent",
      agentKey: "panda",
      kind: "subagent",
      currentThreadId: "thread-panda-subagent",
      createdByIdentityId: "identity-patrik",
    });
    const originalListAgentSessions = harness.sessions.listAgentSessions.bind(harness.sessions);
    // pg-mem can hide non-main rows through the agent_key index; keep this HTTP test focused on Control's filter contract.
    vi.spyOn(harness.sessions, "listAgentSessions").mockImplementation(async (agentKey) => {
      const rows = await originalListAgentSessions(agentKey);
      if (agentKey !== "panda") return rows;
      const ids = new Set(rows.map((row) => row.id));
      return [
        ...rows,
        ...(!ids.has(createdBranch.id) ? [createdBranch] : []),
        ...(!ids.has(createdSubagent.id) ? [createdSubagent] : []),
      ];
    });
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const defaults = await fetch(`${base}/api/control/agents/panda/sessions`, {headers: {cookie: auth.cookies}});
    expect(defaults.status).toBe(200);
    const defaultsBody = await defaults.json() as {data: Array<{id: string; isSubagent: boolean}>; meta: {total: number}};
    expect(defaultsBody.meta.total).toBe(2);
    expect(defaultsBody.data).not.toEqual(expect.arrayContaining([expect.objectContaining({id: "session-panda-subagent"})]));
    expect(defaultsBody.data.every((row) => row.isSubagent === false)).toBe(true);

    const branch = await fetch(`${base}/api/control/agents/panda/sessions?kind=branch`, {headers: {cookie: auth.cookies}});
    expect(branch.status).toBe(200);
    const branchBody = await branch.json() as {data: Array<{id: string; kind: string}>; meta: {total: number}};
    expect(branchBody.meta.total).toBe(1);
    expect(branchBody.data).toEqual([expect.objectContaining({id: "session-panda-branch", kind: "branch"})]);

    const subagents = await fetch(`${base}/api/control/agents/panda/sessions?visibility=subagent`, {headers: {cookie: auth.cookies}});
    expect(subagents.status).toBe(200);
    const subagentsBody = await subagents.json() as {data: Array<{id: string; kind: string; isSubagent: boolean}>; meta: {total: number}};
    expect(subagentsBody.meta.total).toBe(1);
    expect(subagentsBody.data).toEqual([expect.objectContaining({id: "session-panda-subagent", kind: "subagent", isSubagent: true})]);

    const all = await fetch(`${base}/api/control/agents/panda/sessions?visibility=all`, {headers: {cookie: auth.cookies}});
    expect(all.status).toBe(200);
    const allBody = await all.json() as {data: Array<{id: string}>; meta: {total: number}};
    expect(allBody.meta.total).toBe(3);

    const invalid = await fetch(`${base}/api/control/agents/panda/sessions?kind=worker`, {headers: {cookie: auth.cookies}});
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({error: "Control session kind filter must be main or branch."});

    const invalidVisibility = await fetch(`${base}/api/control/agents/panda/sessions?visibility=worker`, {headers: {cookie: auth.cookies}});
    expect(invalidVisibility.status).toBe(400);
    await expect(invalidVisibility.json()).resolves.toEqual({error: "Control session visibility filter must be primary, subagent, or all."});
  });

  it("filters work failures by severity/kind and sanitizes runtime summaries", async () => {
    const harness = await createHarness();
    await harness.pool.query(`
      INSERT INTO "runtime"."threads" (id, session_id)
      VALUES ('thread-panda', 'session-panda'), ('thread-luna', 'session-luna')
    `);
    const visibleRuntimeError = `Provider runtime failed: Unknown model "claude-fable-5". token=sk-1234567890abcdef detail=Bad request {"messages":[{"content":"lowercase patient diagnosis should not leak"}],"stdout":"lowercase shell output"} failureKind=provider_error PRIVATE_RUNTIME_ERROR_MUST_NOT_LEAK`;
    const shortPrefixRuntimeError = `Bad request {"id":"lowercase short prefix diagnosis should not leak","messages":[{"content":"short prefix secret"}]}`;
    await harness.pool.query(`
      INSERT INTO "runtime"."runs" (id, thread_id, status, started_at, finished_at, error) VALUES
        ('00000000-0000-0000-0000-000000000901', 'thread-panda', 'failed', '2040-01-01T00:00:00.000Z', '2040-01-01T00:00:01.000Z', $1),
        ('00000000-0000-0000-0000-000000000904', 'thread-panda', 'failed', '2040-01-01T00:00:02.000Z', '2040-01-01T00:00:03.000Z', $2),
        ('00000000-0000-0000-0000-000000000903', 'thread-luna', 'failed', '2040-01-03T00:00:00.000Z', '2040-01-03T00:00:01.000Z', 'Luna runtime failed')
    `, [visibleRuntimeError, shortPrefixRuntimeError]);
    const task = await harness.scheduledTaskStore.createTask({
      sessionId: "session-panda",
      title: "Visible scheduled failure",
      instruction: "PRIVATE_SCHEDULED_INSTRUCTION_MUST_NOT_LEAK",
      schedule: {kind: "once", runAt: "2040-01-02T10:00:00.000Z"},
    });
    await harness.pool.query(`
      INSERT INTO "runtime"."scheduled_task_runs" (id, task_id, session_id, scheduled_for, status, error, created_at, started_at, finished_at)
      VALUES ('00000000-0000-0000-0000-000000000902', $1, 'session-panda', '2040-01-02T10:00:00.000Z', 'failed', 'PRIVATE_TASK_ERROR_MUST_NOT_LEAK', '2040-01-02T10:01:00.000Z', '2040-01-02T10:01:00.000Z', '2040-01-02T10:02:00.000Z')
    `, [task.id]);
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const critical = await fetch(`${base}/api/control/work-failures?severity=critical`, {headers: {cookie: auth.cookies}});
    expect(critical.status).toBe(200);
    const criticalBody = await critical.json() as {data: Array<{kind: string; severity: string; summary: string; detail?: string; sessionId?: string}>};
    expect(criticalBody.data).toContainEqual(expect.objectContaining({
      kind: "runtime_run",
      severity: "critical",
      sessionId: "session-panda",
      summary: `Provider runtime failed: Unknown model "claude-fable-5". token=sk-1234567890abcdef detail=Bad request`,
      detail: `Sanitized runtime error: Provider runtime failed: Unknown model "claude-fable-5". token=sk-1234567890abcdef detail=Bad request`,
    }));
    expect(criticalBody.data).toContainEqual(expect.objectContaining({
      kind: "runtime_run",
      severity: "critical",
      sessionId: "session-panda",
      summary: "Bad request",
      detail: "Sanitized runtime error: Bad request",
    }));
    const shortPrefixFailure = criticalBody.data.find((failure) => failure.summary === "Bad request");
    const shortPrefixFailureText = JSON.stringify({summary: shortPrefixFailure?.summary, detail: shortPrefixFailure?.detail});
    for (const sentinel of [
      '"id"',
      '"messages"',
      '"content"',
      "lowercase short prefix diagnosis should not leak",
      "short prefix secret",
    ]) expect(shortPrefixFailureText).not.toContain(sentinel);
    const criticalText = JSON.stringify(criticalBody);
    expect(criticalText).toContain("Provider runtime failed: Unknown model");
    expect(criticalText).toContain("token=sk-1234567890abcdef");
    for (const sentinel of [
      "PRIVATE_RUNTIME_ERROR_MUST_NOT_LEAK",
      "PRIVATE_PROMPT_BODY_MUST_NOT_LEAK",
      "PRIVATE_STDOUT_MUST_NOT_LEAK",
      "lowercase patient diagnosis should not leak",
      "lowercase shell output",
      "lowercase short prefix diagnosis should not leak",
      "short prefix secret",
      "LUNA_PRIVATE_WORK_FAILURE_ERROR_MUST_NOT_LEAK",
      "response body",
      "stdout",
      "/workspace/private.ts",
    ]) expect(criticalText).not.toContain(sentinel);

    const scheduled = await fetch(`${base}/api/control/work-failures?kind=scheduled_task_run`, {headers: {cookie: auth.cookies}});
    expect(scheduled.status).toBe(200);
    const scheduledBody = await scheduled.json() as {data: Array<{kind: string; severity: string; summary: string}>};
    expect(scheduledBody.data).toEqual([expect.objectContaining({kind: "scheduled_task_run", severity: "warning", summary: "Scheduled task failed: Visible scheduled failure"})]);

    const invalid = await fetch(`${base}/api/control/work-failures?severity=urgent`, {headers: {cookie: auth.cookies}});
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({error: "Control work failure severity filter must be warning or critical."});
  });

  it("lets Control lock and unlock skills without leaking full skill bodies in audit or errors", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);
    const privateContent = "PRIVATE_LOCKED_SKILL_BODY_MUST_NOT_LEAK";

    const locked = await fetch(`${base}/api/control/agents/panda/skills`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        skillKey: "locked_runbook",
        description: "Locked runbook",
        content: privateContent,
        tags: ["ops"],
        agentEditable: false,
      }),
    });
    expect(locked.status).toBe(200);
    await expect(locked.json()).resolves.toMatchObject({
      skill: {skillKey: "locked_runbook", agentEditable: false, content: privateContent},
    });

    const list = await fetch(`${base}/api/control/agents/panda/skills`, {headers: {cookie: auth.cookies}});
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      data: [expect.objectContaining({skillKey: "locked_runbook", agentEditable: false})],
    });

    const detail = await fetch(`${base}/api/control/agents/panda/skills/locked_runbook`, {headers: {cookie: auth.cookies}});
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      skill: {skillKey: "locked_runbook", agentEditable: false, content: privateContent},
    });

    const unlocked = await fetch(`${base}/api/control/agents/panda/skills`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        skillKey: "locked_runbook",
        description: "Unlocked runbook",
        content: "Updated body",
        agentEditable: true,
      }),
    });
    expect(unlocked.status).toBe(200);
    await expect(unlocked.json()).resolves.toMatchObject({
      skill: {skillKey: "locked_runbook", agentEditable: true, content: "Updated body"},
    });

    const bad = await fetch(`${base}/api/control/agents/panda/skills`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        skillKey: "bad_lock",
        description: "Bad lock",
        content: "PRIVATE_BAD_LOCK_BODY_MUST_NOT_LEAK",
        agentEditable: "nope",
      }),
    });
    expect(bad.status).toBe(400);
    const badText = JSON.stringify(await bad.json());
    expect(badText).toContain("Skill agentEditable must be a boolean.");
    expect(badText).not.toContain("PRIVATE_BAD_LOCK_BODY_MUST_NOT_LEAK");

    const rawAudit = await harness.pool.query(`
      SELECT metadata::text AS metadata
      FROM "runtime"."control_audit_events"
      WHERE event_type = 'control_operator_write'
      ORDER BY created_at ASC
    `);
    const rawAuditText = JSON.stringify(rawAudit.rows);
    expect(rawAuditText).toContain("agentEditable");
    expect(rawAuditText).toContain("sha256");
    expect(rawAuditText).not.toContain(privateContent);

    const visibleAudit = await fetch(`${base}/api/control/audit-events?eventType=control_operator_write&limit=10`, {headers: {cookie: auth.cookies}});
    expect(visibleAudit.status).toBe(200);
    const visibleAuditText = JSON.stringify(await visibleAudit.json());
    expect(visibleAuditText).toContain("agentEditable");
    expect(visibleAuditText).not.toContain(privateContent);
  });

  it("searches visible agents, sessions, and operator resources for direct navigation", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const byAgent = await fetch(`${base}/api/control/search?search=pan&per_page=10`, {headers: {cookie: auth.cookies}});
    expect(byAgent.status).toBe(200);
    const byAgentBody = await byAgent.json() as {data: Array<{kind: string; agentKey?: string; targetRoute: string}>};
    expect(byAgentBody.data).toContainEqual(expect.objectContaining({kind: "agent", agentKey: "panda", targetRoute: "/agents/panda"}));

    const bySession = await fetch(`${base}/api/control/search?search=session-panda&per_page=10`, {headers: {cookie: auth.cookies}});
    expect(bySession.status).toBe(200);
    await expect(bySession.json()).resolves.toMatchObject({
      data: [{kind: "session", agentKey: "panda", sessionId: "session-panda", targetRoute: "/agents/panda/sessions/session-panda"}],
    });

    await harness.pool.query(`
      INSERT INTO "runtime"."threads" (id, session_id)
      VALUES ('thread-panda-search', 'session-panda')
    `);
    await harness.pool.query(`
      INSERT INTO "runtime"."runs" (id, thread_id, status, started_at, finished_at, error)
      VALUES ('00000000-0000-0000-0000-000000000903', 'thread-panda-search', 'failed', '2040-01-03T00:00:00.000Z', '2040-01-03T00:00:01.000Z', '{"private":"PRIVATE_RUNTIME_ERROR_MUST_NOT_LEAK"}')
    `);
    await expect(fetch(`${base}/api/control/agents/panda/connectors`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({accountKey: "workspace", connectorKey: "discord-main", displayName: "Discord main", botToken: "bot-secret"}),
    })).resolves.toMatchObject({status: 200});
    await expect(fetch(`${base}/api/control/agents/panda/bindings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        source: "discord",
        connectorKey: "discord-main",
        externalConversationId: "channel-123",
        sessionId: "session-panda",
        displayName: "Panda operator room",
      }),
    })).resolves.toMatchObject({status: 200});
    await expect(fetch(`${base}/api/control/agents/panda/skills`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        skillKey: "deploy_watch",
        description: "Deployment monitor",
        content: "Watch deploy status.",
        tags: [" Monitoring ", "repo:PANDA-agent", "monitoring"],
      }),
    })).resolves.toMatchObject({status: 200});
    await expect(fetch(`${base}/api/control/agents/panda/skills`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({skillKey: "finance_report", description: "Finance report", content: "Report finances.", tags: ["finance"]}),
    })).resolves.toMatchObject({status: 200});
    const taggedSkills = await fetch(`${base}/api/control/agents/panda/skills?tag=MONITORING`, {headers: {cookie: auth.cookies}});
    expect(taggedSkills.status).toBe(200);
    await expect(taggedSkills.json()).resolves.toMatchObject({
      data: [expect.objectContaining({skillKey: "deploy_watch", tags: ["monitoring", "repo:panda-agent"]})],
    });
    const skillDetail = await fetch(`${base}/api/control/agents/panda/skills/deploy_watch`, {headers: {cookie: auth.cookies}});
    expect(skillDetail.status).toBe(200);
    await expect(skillDetail.json()).resolves.toMatchObject({
      skill: expect.objectContaining({skillKey: "deploy_watch", tags: ["monitoring", "repo:panda-agent"]}),
    });
    await expect(fetch(`${base}/api/control/agents/panda/gateway/sources`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({sourceId: "build-alerts", name: "Build alerts", sessionId: "session-panda"}),
    })).resolves.toMatchObject({status: 201});

    async function searchFor(term: string) {
      const response = await fetch(`${base}/api/control/search?search=${encodeURIComponent(term)}&per_page=10`, {headers: {cookie: auth.cookies}});
      expect(response.status).toBe(200);
      return (await response.json()) as {data: Array<{kind: string; targetRoute: string; title: string}>};
    }

    expect((await searchFor("API_TOKEN")).data).toContainEqual(expect.objectContaining({kind: "credential", targetRoute: "/agents/panda?tab=credentials"}));
    expect((await searchFor("workspace")).data).toContainEqual(expect.objectContaining({kind: "connector", targetRoute: "/agents/panda?tab=connectors"}));
    expect((await searchFor("channel-123")).data).toContainEqual(expect.objectContaining({kind: "binding", targetRoute: "/agents/panda/sessions/session-panda?tab=bindings"}));
    expect((await searchFor("deploy_watch")).data).toContainEqual(expect.objectContaining({kind: "skill", targetRoute: "/agents/panda?tab=skills"}));
    expect((await searchFor("build-alerts")).data).toContainEqual(expect.objectContaining({kind: "gateway_source", targetRoute: "/agents/panda?tab=gateway"}));
    expect((await searchFor("Agent run failed")).data).toContainEqual(expect.objectContaining({kind: "work_failure", targetRoute: "/agents/panda/sessions/session-panda?tab=runtime"}));
  });

  it("writes agent credentials without returning secret material and audits only summaries", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const write = await fetch(`${base}/api/control/agents/panda/credentials`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({envKey: "DISCORD_TOKEN", value: "super-secret-token"}),
    });
    expect(write.status).toBe(200);
    const writeText = JSON.stringify(await write.json());
    expect(writeText).toContain("DISCORD_TOKEN");
    expect(writeText).not.toContain("super-secret-token");

    const list = await fetch(`${base}/api/control/agents/panda/credentials`, {headers: {cookie: auth.cookies}});
    const listText = JSON.stringify(await list.json());
    expect(listText).toContain("DISCORD_TOKEN");
    expect(listText).not.toContain("super-secret-token");

    const audit = await fetch(`${base}/api/control/audit-events`, {headers: {cookie: auth.cookies}});
    const auditText = JSON.stringify(await audit.json());
    expect(auditText).toContain("DISCORD_TOKEN");
    expect(auditText).toContain("sha256");
    expect(auditText).not.toContain("super-secret-token");
  });

  it("issues one-time Control login grants without auditing token material", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const missingCsrf = await fetch(`${base}/api/control/control-grants`, {
      method: "POST",
      headers: {cookie: auth.cookies},
      body: JSON.stringify({identityId: "identity-patrik", role: "scoped", agentKey: "panda"}),
    });
    expect(missingCsrf.status).toBe(403);

    const missingAgent = await fetch(`${base}/api/control/control-grants`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({identityId: "identity-patrik", role: "scoped"}),
    });
    expect(missingAgent.status).toBe(400);

    const issued = await fetch(`${base}/api/control/control-grants`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        identityId: "identity-patrik",
        label: "Laptop setup",
        role: "scoped",
        agentKey: "panda",
      }),
    });
    expect(issued.status).toBe(201);
    const issuedBody = await issued.json() as {grant: {role: string; agentKey: string; label: string}; loginToken: string};
    expect(issuedBody.grant).toMatchObject({role: "scoped", agentKey: "panda", label: "Laptop setup"});
    expect(issuedBody.loginToken).toMatch(/^pct_/);

    const scopedLogin = await fetch(`${base}/api/control/login`, {
      method: "POST",
      body: JSON.stringify({token: issuedBody.loginToken}),
    });
    expect(scopedLogin.status).toBe(200);
    await expect(scopedLogin.json()).resolves.toMatchObject({session: {role: "scoped", identityId: "identity-patrik"}});

    const audit = await fetch(`${base}/api/control/audit-events?eventType=control_operator_write`, {headers: {cookie: auth.cookies}});
    const auditBody = await audit.json() as {data: Array<{metadata: Record<string, unknown>}>};
    const grantAudit = auditBody.data.find((event) => event.metadata.action === "issue_control_grant");
    expect(grantAudit?.metadata).toMatchObject({
      action: "issue_control_grant",
      agentKey: "panda",
      identityHandle: "patrik",
      role: "scoped",
    });
    expect(JSON.stringify(grantAudit?.metadata)).not.toContain("identity-patrik");
    expect(JSON.stringify(auditBody)).not.toContain(issuedBody.loginToken);
  });

  it("writes agent Wiki bindings without returning API token material", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const empty = await fetch(`${base}/api/control/agents/panda/wiki-binding`, {headers: {cookie: auth.cookies}});
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({binding: null});

    const missingCsrf = await fetch(`${base}/api/control/agents/panda/wiki-binding`, {
      method: "PUT",
      headers: {cookie: auth.cookies},
      body: JSON.stringify({wikiGroupId: 7, namespacePath: "agents/panda", apiToken: "wiki-secret-token"}),
    });
    expect(missingCsrf.status).toBe(403);

    const write = await fetch(`${base}/api/control/agents/panda/wiki-binding`, {
      method: "PUT",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({wikiGroupId: 7, namespacePath: "/agents/panda/", apiToken: "wiki-secret-token"}),
    });
    expect(write.status).toBe(200);
    const writeText = JSON.stringify(await write.json());
    expect(writeText).toContain("agents/panda");
    expect(writeText).toContain("\"wikiGroupId\":7");
    expect(writeText).not.toContain("wiki-secret-token");

    const stored = await harness.wikiBindingStore.getBinding("panda");
    expect(stored).toMatchObject({agentKey: "panda", wikiGroupId: 7, namespacePath: "agents/panda"});
    expect(JSON.stringify(stored)).not.toContain("wiki-secret-token");

    const get = await fetch(`${base}/api/control/agents/panda/wiki-binding`, {headers: {cookie: auth.cookies}});
    const getText = JSON.stringify(await get.json());
    expect(get.status).toBe(200);
    expect(getText).toContain("agents/panda");
    expect(getText).not.toContain("wiki-secret-token");

    const audit = await fetch(`${base}/api/control/audit-events?eventType=control_operator_write&agentKey=panda`, {headers: {cookie: auth.cookies}});
    const auditText = JSON.stringify(await audit.json());
    expect(auditText).toContain("set_wiki_binding");
    expect(auditText).toContain("\"namespacePath\":\"agents/panda\"");
    expect(auditText).toContain("sha256");
    expect(auditText).not.toContain("wiki-secret-token");

    const deleted = await fetch(`${base}/api/control/agents/panda/wiki-binding`, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({deleted: true});
    await expect(harness.wikiBindingStore.getBinding("panda")).resolves.toBeNull();
  });

  it("redacts Telegram bot tokens from Control validation errors", async () => {
    const privateToken = "123456789:super-secret-token-fragment";
    const harness = await createHarness({
      telegramBotIdentityClient: {
        getBotIdentity: async (token) => {
          throw new Error(`Telegram rejected token ${token}`);
        },
      },
    });
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const failedCreate = await fetch(`${base}/api/control/agents/panda/connectors`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({source: "telegram", accountKey: "main", botToken: privateToken}),
    });
    expect(failedCreate.status).toBe(400);
    const failedCreateText = JSON.stringify(await failedCreate.json());
    expect(failedCreateText).toContain("[redacted]");
    expect(failedCreateText).not.toContain(privateToken);
    expect(failedCreateText).not.toContain("super-secret-token-fragment");

    const account = await harness.connectorAccountStore.upsertAccount({
      source: "telegram",
      accountKey: "main",
      connectorKey: "424242",
      ownerKind: "agent",
      ownerAgentKey: "panda",
      status: "enabled",
    });
    await harness.connectorAccountStore.setSecret(account.id, "bot_token", privateToken, harness.credentialCrypto);
    const status = await fetch(`${base}/api/control/agents/panda/telegram/setup-status?account_key=main`, {headers: {cookie: auth.cookies}});
    expect(status.status).toBe(200);
    const statusText = JSON.stringify(await status.json());
    expect(statusText).toContain("[redacted]");
    expect(statusText).not.toContain(privateToken);
    expect(statusText).not.toContain("super-secret-token-fragment");
  });

  it("creates Telegram connectors only with explicit replacement and reports setup status", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness, {env: {TELEGRAM_ENABLED: "true", PANDA_TRACE_COLLECTOR_ENABLED: "true", PANDA_TRACE_COLLECTOR_SERVICES: "core,telegram", PANDA_TRACE_SOURCE_TELEGRAM: "src_telegram"} as NodeJS.ProcessEnv});
    const auth = await login(base, harness);

    const missingCsrf = await fetch(`${base}/api/control/agents/panda/connectors`, {
      method: "POST",
      headers: {cookie: auth.cookies},
      body: JSON.stringify({source: "telegram", accountKey: "main", botToken: "telegram-secret"}),
    });
    expect(missingCsrf.status).toBe(403);

    const created = await fetch(`${base}/api/control/agents/panda/connectors`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({source: "telegram", accountKey: "main", botToken: "telegram-secret"}),
    });
    expect(created.status).toBe(200);
    const createdText = JSON.stringify(await created.json());
    expect(createdText).toContain("bot_token");
    expect(createdText).toContain("panda_bot");
    expect(createdText).not.toContain("telegram-secret");

    const accidentalReplace = await fetch(`${base}/api/control/agents/panda/connectors`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({source: "telegram", accountKey: "main", botToken: "telegram-secret-2"}),
    });
    expect(accidentalReplace.status).toBe(400);
    await expect(accidentalReplace.json()).resolves.toMatchObject({error: expect.stringContaining("already exists")});

    const replaced = await fetch(`${base}/api/control/agents/panda/connectors`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({source: "telegram", accountKey: "main", botToken: "telegram-secret-2", replace: true}),
    });
    expect(replaced.status).toBe(200);

    const actorBeforePairing = await fetch(`${base}/api/control/agents/panda/channel-actor-pairings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({source: "telegram", connectorKey: "424242", externalActorId: "987654321", identityId: "identity-patrik"}),
    });
    expect(actorBeforePairing.status).toBe(400);
    await expect(actorBeforePairing.json()).resolves.toMatchObject({error: expect.stringContaining("identity must already be paired")});

    await harness.agents.ensurePairing("panda", "identity-patrik");
    const paired = await fetch(`${base}/api/control/agents/panda/channel-actor-pairings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({source: "telegram", connectorKey: "424242", externalActorId: "987654321", identityId: "identity-patrik"}),
    });
    expect(paired.status).toBe(200);

    const bound = await fetch(`${base}/api/control/agents/panda/bindings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({source: "telegram", connectorKey: "424242", externalConversationId: "987654321", sessionId: "session-panda", displayName: "Telegram DM"}),
    });
    expect(bound.status).toBe(200);

    const status = await fetch(`${base}/api/control/agents/panda/telegram/setup-status?account_key=main`, {headers: {cookie: auth.cookies}});
    expect(status.status).toBe(200);
    const statusText = JSON.stringify(await status.json());
    expect(statusText).toContain("tokenValid");
    expect(statusText).toContain("valid");
    expect(statusText).toContain("hot-reconciles");
    expect(statusText).not.toContain("telegram-secret");
  });

  it("creates Discord connectors and manual conversation bindings", async () => {
    const harness = await createHarness();
    await harness.sessions.createSessionRecord({id: "session-panda-branch", agentKey: "panda", kind: "branch", currentThreadId: "thread-panda-branch", createdByIdentityId: "identity-patrik"});
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const connector = await fetch(`${base}/api/control/agents/panda/connectors`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({accountKey: "workspace", connectorKey: "discord-main", displayName: "Discord main", botToken: "bot-secret"}),
    });
    expect(connector.status).toBe(200);
    const connectorText = JSON.stringify(await connector.json());
    expect(connectorText).toContain("bot_token");
    expect(connectorText).not.toContain("bot-secret");

    const identities = await fetch(`${base}/api/control/identities?search=patrik`, {headers: {cookie: auth.cookies}});
    expect(identities.status).toBe(200);
    await expect(identities.json()).resolves.toMatchObject({
      data: [expect.objectContaining({id: "identity-patrik", handle: "patrik", displayName: "Patrik"})],
    });

    const pairActorBeforeAgentPairing = await fetch(`${base}/api/control/agents/panda/discord/actor-pairings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        accountKey: "workspace",
        externalActorId: "234567890123456789",
        identityId: "identity-patrik",
      }),
    });
    expect(pairActorBeforeAgentPairing.status).toBe(400);
    await expect(pairActorBeforeAgentPairing.json()).resolves.toMatchObject({
      error: expect.stringContaining("identity must already be paired"),
    });

    await harness.agents.ensurePairing("panda", "identity-patrik");
    const pairActor = await fetch(`${base}/api/control/agents/panda/discord/actor-pairings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        accountKey: "workspace",
        externalActorId: "234567890123456789",
        identityId: "identity-patrik",
      }),
    });
    expect(pairActor.status).toBe(200);
    const pairActorText = JSON.stringify(await pairActor.json());
    expect(pairActorText).toContain("234567890123456789");
    expect(pairActorText).toContain("patrik");
    expect(pairActorText).not.toContain("control-ui");

    const actorPairings = await fetch(`${base}/api/control/agents/panda/discord/actor-pairings?accountKey=workspace&search=234567`, {headers: {cookie: auth.cookies}});
    expect(actorPairings.status).toBe(200);
    await expect(actorPairings.json()).resolves.toMatchObject({
      data: [expect.objectContaining({
        accountKey: "workspace",
        connectorKey: "discord-main",
        externalActorId: "234567890123456789",
        identityHandle: "patrik",
      })],
      meta: {total: 1},
    });
    await expect(harness.identities.resolveIdentityBinding({
      source: "discord",
      connectorKey: "discord-main",
      externalActorId: "234567890123456789",
    })).resolves.toMatchObject({identityId: "identity-patrik"});

    const invalidActor = await fetch(`${base}/api/control/agents/panda/discord/actor-pairings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        accountKey: "workspace",
        externalActorId: "@patrik",
        identityId: "identity-patrik",
      }),
    });
    expect(invalidActor.status).toBe(400);

    const deleteActor = await fetch(`${base}/api/control/agents/panda/discord/actor-pairings/workspace/234567890123456789`, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
    });
    expect(deleteActor.status).toBe(200);
    await expect(harness.identities.resolveIdentityBinding({
      source: "discord",
      connectorKey: "discord-main",
      externalActorId: "234567890123456789",
    })).resolves.toBeNull();

    const pairWhatsAppActor = await fetch(`${base}/api/control/agents/panda/channel-actor-pairings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        source: "whatsapp",
        connectorKey: "main",
        externalActorId: "+421 900 123 456",
        identityId: "identity-patrik",
      }),
    });
    expect(pairWhatsAppActor.status).toBe(200);
    await expect(pairWhatsAppActor.json()).resolves.toMatchObject({
      pairing: {
        source: "whatsapp",
        connectorKey: "main",
        externalActorId: "421900123456@s.whatsapp.net",
        identityHandle: "patrik",
      },
    });
    await expect(harness.identities.resolveIdentityBinding({
      source: "whatsapp",
      connectorKey: "main",
      externalActorId: "421900123456@s.whatsapp.net",
    })).resolves.toMatchObject({identityId: "identity-patrik"});

    await harness.connectorAccountStore.upsertAccount({
      source: "telegram",
      accountKey: "telegram-main",
      connectorKey: "123456789",
      ownerKind: "agent",
      ownerAgentKey: "panda",
      status: "enabled",
    });
    const pairTelegramActor = await fetch(`${base}/api/control/agents/panda/channel-actor-pairings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        source: "telegram",
        connectorKey: "123456789",
        externalActorId: "987654321",
        identityId: "identity-patrik",
      }),
    });
    expect(pairTelegramActor.status).toBe(200);
    const pairTelegramActorText = JSON.stringify(await pairTelegramActor.json());
    expect(pairTelegramActorText).toContain("987654321");
    expect(pairTelegramActorText).toContain("patrik");
    expect(pairTelegramActorText).not.toContain("control-ui");

    const channelActorPairings = await fetch(`${base}/api/control/agents/panda/channel-actor-pairings?source=whatsapp&search=421900`, {headers: {cookie: auth.cookies}});
    expect(channelActorPairings.status).toBe(200);
    await expect(channelActorPairings.json()).resolves.toMatchObject({
      data: [expect.objectContaining({
        source: "whatsapp",
        connectorKey: "main",
        externalActorId: "421900123456@s.whatsapp.net",
        identityHandle: "patrik",
      })],
      meta: {total: 1},
    });

    const invalidTelegramActor = await fetch(`${base}/api/control/agents/panda/channel-actor-pairings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        source: "telegram",
        connectorKey: "123456789",
        externalActorId: "@patrik",
        identityId: "identity-patrik",
      }),
    });
    expect(invalidTelegramActor.status).toBe(400);

    const deleteWhatsAppActor = await fetch(`${base}/api/control/agents/panda/channel-actor-pairings/whatsapp/main/${encodeURIComponent("421900123456@s.whatsapp.net")}`, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
    });
    expect(deleteWhatsAppActor.status).toBe(200);
    await expect(harness.identities.resolveIdentityBinding({
      source: "whatsapp",
      connectorKey: "main",
      externalActorId: "421900123456@s.whatsapp.net",
    })).resolves.toBeNull();

    const bind = await fetch(`${base}/api/control/agents/panda/bindings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        source: "discord",
        connectorKey: "discord-main",
        externalConversationId: "channel-123",
        sessionId: "session-panda",
        displayName: "Panda operator room",
      }),
    });
    expect(bind.status).toBe(200);
    await expect(bind.json()).resolves.toMatchObject({binding: {externalConversationId: "channel-123", sessionId: "session-panda"}});

    const branchBind = await fetch(`${base}/api/control/agents/panda/bindings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        source: "discord",
        connectorKey: "discord-main",
        externalConversationId: "channel-branch",
        sessionId: "session-panda-branch",
        displayName: "Panda branch room",
      }),
    });
    expect(branchBind.status).toBe(200);

    const bindings = await fetch(`${base}/api/control/agents/panda/bindings`, {headers: {cookie: auth.cookies}});
    await expect(bindings.json()).resolves.toMatchObject({data: expect.arrayContaining([expect.objectContaining({externalConversationId: "channel-123", sessionLabel: "session-panda"})])});

    const discordBindings = await fetch(`${base}/api/control/agents/panda/bindings?source=discord`, {headers: {cookie: auth.cookies}});
    expect(discordBindings.status).toBe(200);
    await expect(discordBindings.json()).resolves.toMatchObject({data: expect.arrayContaining([expect.objectContaining({source: "discord", externalConversationId: "channel-123"})])});

    const sessionBindings = await fetch(`${base}/api/control/agents/panda/bindings?session_id=session-panda&per_page=1`, {headers: {cookie: auth.cookies}});
    expect(sessionBindings.status).toBe(200);
    await expect(sessionBindings.json()).resolves.toMatchObject({
      data: [{source: "discord", externalConversationId: "channel-123", sessionId: "session-panda"}],
      meta: {total: 1},
    });

    const wrongSessionFilter = await fetch(`${base}/api/control/agents/panda/bindings?session_id=session-luna`, {headers: {cookie: auth.cookies}});
    expect(wrongSessionFilter.status).toBe(404);

    const telegramBindings = await fetch(`${base}/api/control/agents/panda/bindings?source=telegram`, {headers: {cookie: auth.cookies}});
    expect(telegramBindings.status).toBe(200);
    await expect(telegramBindings.json()).resolves.toMatchObject({data: [], meta: {total: 0}});
  });

  it("creates email connectors with write-only credentials", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const create = await fetch(`${base}/api/control/agents/panda/connectors`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        source: "email",
        accountKey: "work",
        displayName: "Work email",
        fromAddress: "panda@example.com",
        fromName: "Panda",
        mailboxes: ["INBOX", "Ops"],
        imapHost: "imap.example.com",
        imapPort: "993",
        imapSecure: "secure",
        imapUsername: "imap-user",
        imapPassword: "imap-secret",
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        smtpSecure: "starttls",
        smtpUsername: "smtp-user",
        smtpPassword: "smtp-secret",
      }),
    });
    expect(create.status).toBe(200);
    const body = await create.json() as {connector: Record<string, unknown>};
    expect(body.connector).toMatchObject({
      source: "email",
      accountKey: "work",
      connectorKey: "work",
      displayName: "Work email",
      externalUsername: "panda@example.com",
      status: "enabled",
      email: {
        fromAddress: "panda@example.com",
        fromName: "Panda",
        mailboxes: ["INBOX", "Ops"],
        credentialKeys: ["EMAIL_WORK_IMAP_USERNAME", "EMAIL_WORK_IMAP_PASSWORD", "EMAIL_WORK_SMTP_USERNAME", "EMAIL_WORK_SMTP_PASSWORD"],
        imap: {
          host: "imap.example.com",
          port: 993,
          secure: true,
        },
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
        },
      },
    });
    const createText = JSON.stringify(body);
    expect(createText).not.toContain("imap-secret");
    expect(createText).not.toContain("smtp-secret");

    const emailConnectors = await fetch(`${base}/api/control/agents/panda/connectors?source=email&status=enabled`, {headers: {cookie: auth.cookies}});
    expect(emailConnectors.status).toBe(200);
    await expect(emailConnectors.json()).resolves.toMatchObject({data: [{source: "email", accountKey: "work", status: "enabled"}]});

    const bind = await fetch(`${base}/api/control/agents/panda/bindings`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        source: "email",
        connectorKey: "work",
        externalConversationId: "ops@example.com",
        sessionId: "session-panda",
        displayName: "Ops email",
      }),
    });
    expect(bind.status).toBe(200);
    await expect(bind.json()).resolves.toMatchObject({
      binding: {
        source: "email",
        connectorKey: "work",
        externalConversationId: "ops@example.com",
        sessionId: "session-panda",
      },
    });

    const emailBindings = await fetch(`${base}/api/control/agents/panda/bindings?source=email`, {headers: {cookie: auth.cookies}});
    expect(emailBindings.status).toBe(200);
    await expect(emailBindings.json()).resolves.toMatchObject({
      data: [expect.objectContaining({source: "email", connectorKey: "work", externalConversationId: "ops@example.com"})],
      meta: {total: 1},
    });

    const discordConnectors = await fetch(`${base}/api/control/agents/panda/connectors?source=discord`, {headers: {cookie: auth.cookies}});
    expect(discordConnectors.status).toBe(200);
    await expect(discordConnectors.json()).resolves.toMatchObject({data: []});

    const telegramConnectors = await fetch(`${base}/api/control/agents/panda/connectors?source=telegram`, {headers: {cookie: auth.cookies}});
    expect(telegramConnectors.status).toBe(200);
    await expect(telegramConnectors.json()).resolves.toMatchObject({data: []});

    const emailAccount = await harness.emailStore.getAccount("panda", "work");
    expect(emailAccount).toMatchObject({
      accountKey: "work",
      fromAddress: "panda@example.com",
      imap: {usernameCredentialEnvKey: "EMAIL_WORK_IMAP_USERNAME", passwordCredentialEnvKey: "EMAIL_WORK_IMAP_PASSWORD"},
      smtp: {usernameCredentialEnvKey: "EMAIL_WORK_SMTP_USERNAME", passwordCredentialEnvKey: "EMAIL_WORK_SMTP_PASSWORD"},
      enabled: true,
    });

    const route = await fetch(`${base}/api/control/agents/panda/email/routes`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        accountKey: "work",
        mailbox: "Ops",
        sessionId: "session-panda",
      }),
    });
    expect(route.status).toBe(200);
    await expect(route.json()).resolves.toMatchObject({
      route: {
        agentKey: "panda",
        accountKey: "work",
        mailbox: "Ops",
        sessionId: "session-panda",
        sessionLabel: "session-panda",
      },
    });
    await expect(harness.emailStore.resolveRoute({agentKey: "panda", accountKey: "work", mailbox: "Ops"})).resolves.toMatchObject({
      sessionId: "session-panda",
    });

    const routes = await fetch(`${base}/api/control/agents/panda/email/routes?accountKey=work&search=Ops`, {headers: {cookie: auth.cookies}});
    expect(routes.status).toBe(200);
    await expect(routes.json()).resolves.toMatchObject({
      data: [expect.objectContaining({accountKey: "work", mailbox: "Ops", sessionId: "session-panda"})],
      meta: {total: 1},
    });

    const allowRecipient = await fetch(`${base}/api/control/agents/panda/email/allowlist`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        accountKey: "work",
        address: "ops@example.com",
      }),
    });
    expect(allowRecipient.status).toBe(200);
    await expect(allowRecipient.json()).resolves.toMatchObject({
      recipient: {
        agentKey: "panda",
        accountKey: "work",
        address: "ops@example.com",
      },
    });

    const allowlist = await fetch(`${base}/api/control/agents/panda/email/allowlist?accountKey=work&search=ops`, {headers: {cookie: auth.cookies}});
    expect(allowlist.status).toBe(200);
    await expect(allowlist.json()).resolves.toMatchObject({
      data: [expect.objectContaining({accountKey: "work", address: "ops@example.com"})],
      meta: {total: 1},
    });
    await expect(harness.emailStore.listAllowedRecipients("panda", "work")).resolves.toMatchObject([
      expect.objectContaining({address: "ops@example.com"}),
    ]);

    const deleteAllowedRecipient = await fetch(`${base}/api/control/agents/panda/email/allowlist/work/${encodeURIComponent("ops@example.com")}`, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
    });
    expect(deleteAllowedRecipient.status).toBe(200);
    await expect(deleteAllowedRecipient.json()).resolves.toEqual({deleted: true});
    await expect(harness.emailStore.listAllowedRecipients("panda", "work")).resolves.toEqual([]);

    const deleteRoute = await fetch(`${base}/api/control/agents/panda/email/routes/work`, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({mailbox: "Ops"}),
    });
    expect(deleteRoute.status).toBe(200);
    await expect(deleteRoute.json()).resolves.toEqual({deleted: true});
    await expect(harness.emailStore.resolveRoute({agentKey: "panda", accountKey: "work", mailbox: "Ops"})).resolves.toBeNull();

    const credentials = await fetch(`${base}/api/control/agents/panda/credentials`, {headers: {cookie: auth.cookies}});
    const credentialsText = JSON.stringify(await credentials.json());
    expect(credentialsText).toContain("EMAIL_WORK_IMAP_USERNAME");
    expect(credentialsText).toContain("EMAIL_WORK_SMTP_PASSWORD");
    expect(credentialsText).not.toContain("imap-secret");
    expect(credentialsText).not.toContain("smtp-secret");

    const disable = await fetch(`${base}/api/control/agents/panda/connectors/email/work/status`, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({enabled: false}),
    });
    expect(disable.status).toBe(200);
    await expect(harness.emailStore.getAccount("panda", "work")).resolves.toMatchObject({enabled: false});

    const disabledConnectors = await fetch(`${base}/api/control/agents/panda/connectors?status=disabled`, {headers: {cookie: auth.cookies}});
    expect(disabledConnectors.status).toBe(200);
    await expect(disabledConnectors.json()).resolves.toMatchObject({data: [{source: "email", accountKey: "work", status: "disabled"}]});

    const enable = await fetch(`${base}/api/control/agents/panda/connectors/email/work/status`, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({enabled: true}),
    });
    expect(enable.status).toBe(200);
    await expect(harness.emailStore.getAccount("panda", "work")).resolves.toMatchObject({enabled: true});
  });

  it("creates gateway setup records, hides secrets, and leaves maintenance routes absent", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const create = await fetch(`${base}/api/control/agents/panda/gateway/sources`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({sourceId: "build-alerts", name: "Build alerts", sessionId: "session-panda"}),
    });
    expect(create.status).toBe(201);
    const createBody = await create.json() as {clientSecret: string};
    expect(createBody.clientSecret).toMatch(/^pgs_/);

    const list = await fetch(`${base}/api/control/agents/panda/gateway/sources`, {headers: {cookie: auth.cookies}});
    const listText = JSON.stringify(await list.json());
    expect(listText).toContain("build-alerts");
    expect(listText).not.toContain(createBody.clientSecret);

    const eventTypesPath = `${base}/api/control/agents/panda/gateway/sources/build-alerts/event-types`;
    const allowType = await fetch(eventTypesPath, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({type: "build.completed", delivery: "queue"}),
    });
    expect(allowType.status).toBe(200);
    await expect(allowType.json()).resolves.toMatchObject({eventType: {sourceId: "build-alerts", type: "build.completed"}});

    const deleteTypePath = `${eventTypesPath}/${encodeURIComponent("build.completed")}`;
    const withoutCsrf = await fetch(deleteTypePath, {method: "DELETE", headers: {cookie: auth.cookies}});
    expect(withoutCsrf.status).toBe(403);

    await expect(fetch(`${base}/api/control/agents/luna/gateway/sources`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({sourceId: "luna-alerts", name: "Luna alerts", sessionId: "session-luna"}),
    })).resolves.toMatchObject({status: 201});
    await expect(fetch(`${base}/api/control/agents/luna/gateway/sources/luna-alerts/event-types`, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({type: "build.completed", delivery: "queue"}),
    })).resolves.toMatchObject({status: 200});
    const wrongAgent = await fetch(`${base}/api/control/agents/panda/gateway/sources/luna-alerts/event-types/${encodeURIComponent("build.completed")}`, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
    });
    expect(wrongAgent.status).toBe(400);

    const deleteType = await fetch(deleteTypePath, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
    });
    expect(deleteType.status).toBe(200);
    await expect(deleteType.json()).resolves.toEqual({deleted: true});
    await expect((await fetch(eventTypesPath, {headers: {cookie: auth.cookies}})).json()).resolves.toMatchObject({data: []});

    const deleteAgain = await fetch(deleteTypePath, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
    });
    expect(deleteAgain.status).toBe(200);
    await expect(deleteAgain.json()).resolves.toEqual({deleted: false});
    await expect((await fetch(`${base}/api/control/agents/luna/gateway/sources/luna-alerts/event-types`, {headers: {cookie: auth.cookies}})).json())
      .resolves.toMatchObject({data: [expect.objectContaining({type: "build.completed"})]});

    const auditResponse = await fetch(`${base}/api/control/audit-events?eventType=control_operator_write&limit=20`, {headers: {cookie: auth.cookies}});
    expect(auditResponse.status).toBe(200);
    const auditBody = await auditResponse.json() as {auditEvents: Array<{metadata: Record<string, unknown>}>};
    expect(auditBody.auditEvents.map((event) => event.metadata)).toContainEqual({
      action: "disallow_type",
      agentKey: "panda",
      sourceId: "build-alerts",
      type: "build.completed",
      existed: true,
      deleted: true,
    });
    const auditText = JSON.stringify(auditBody.auditEvents.filter((event) => event.metadata.action === "disallow_type"));
    expect(auditText).not.toContain(createBody.clientSecret);
    expect(auditText).not.toContain("raw");
    expect(auditText).not.toContain("payload");

    const devicesPath = `${base}/api/control/agents/panda/gateway/sources/build-alerts/devices`;
    for (const body of [
      {deviceId: "alpha-terminal", label: "Terminal", capabilities: ["push_context", "upload_attachments"]},
      {deviceId: "beta-runner", label: "Runner", capabilities: ["claim_commands"]},
      {deviceId: "gamma-screen", label: "Screen", capabilities: ["claim_commands", "screenshot.capture"]},
    ]) {
      const deviceWrite = await fetch(devicesPath, {
        method: "POST",
        headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
        body: JSON.stringify(body),
      });
      expect(deviceWrite.status).toBe(201);
      const deviceWriteBody = await deviceWrite.json() as {token: string};
      expect(deviceWriteBody.token).toMatch(/^pgd_/);
    }

    const devicePage = await fetch(`${devicesPath}?page=2&per_page=1&sort_by=deviceId&sort_direction=asc`, {headers: {cookie: auth.cookies}});
    expect(devicePage.status).toBe(200);
    await expect(devicePage.json()).resolves.toMatchObject({
      data: [{deviceId: "beta-runner"}],
      meta: {current_page: 2, last_page: 3, per_page: 1, total: 3},
    });

    const commandCapable = await fetch(`${devicesPath}?capabilities=claim_commands&sort_by=deviceId&sort_direction=asc`, {headers: {cookie: auth.cookies}});
    expect(commandCapable.status).toBe(200);
    await expect(commandCapable.json()).resolves.toMatchObject({
      data: [{deviceId: "beta-runner"}, {deviceId: "gamma-screen"}],
      meta: {total: 2},
    });

    const search = await fetch(`${devicesPath}?search=terminal`, {headers: {cookie: auth.cookies}});
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({data: [{deviceId: "alpha-terminal"}], meta: {total: 1}});

    const disable = await fetch(`${devicesPath}/alpha-terminal`, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({enabled: false}),
    });
    expect(disable.status).toBe(200);

    const disabledDevices = await fetch(`${devicesPath}?enabled=false`, {headers: {cookie: auth.cookies}});
    expect(disabledDevices.status).toBe(200);
    const disabledBody = await disabledDevices.json();
    expect(disabledBody).toMatchObject({data: [{deviceId: "alpha-terminal", enabled: false}], meta: {total: 1}});
    expect(JSON.stringify(disabledBody)).not.toContain("pgd_");

    const invalidEnabled = await fetch(`${devicesPath}?enabled=wat`, {headers: {cookie: auth.cookies}});
    expect(invalidEnabled.status).toBe(400);

    // Gateway queue/lifecycle/scrub maintenance is intentionally CLI-only unless a focused audited Control workflow is designed.
    const maintenanceRoutes: Array<{method: "GET" | "POST"; path: string}> = [
      {method: "GET", path: `${base}/api/control/agents/panda/gateway/sources/build-alerts/commands`},
      {method: "POST", path: `${devicesPath}/alpha-terminal/commands`},
      {method: "POST", path: `${devicesPath}/alpha-terminal/commands/cmd-123/cancel`},
      {method: "POST", path: `${base}/api/control/agents/panda/gateway/device-commands/timeout-sweep`},
      {method: "POST", path: `${base}/api/control/agents/panda/gateway/attachments/scrub-expired`},
      {method: "POST", path: `${base}/api/control/agents/panda/gateway/run`},
    ];
    for (const route of maintenanceRoutes) {
      const response = await fetch(route.path, {
        method: route.method,
        headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
        ...(route.method === "GET" ? {} : {body: JSON.stringify({reason: "boundary-test"})}),
      });
      expect({method: route.method, path: route.path, status: response.status}).toMatchObject({
        method: route.method,
        path: route.path,
        status: 404,
      });
      await expect(response.json()).resolves.toEqual({error: "not_found"});
    }
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
    const promptWrite = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/prompts/memory`, {
      method: "PUT",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({content: "private memory body must not leave audit API"}),
    });
    expect(promptWrite.status).toBe(200);

    const response = await fetch(`${base}/api/control/audit-events?limit=10`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {auditEvents: Array<{eventType: string; metadata: Record<string, unknown>}>};
    expect(body.auditEvents.some((event) => event.eventType === "login")).toBe(true);
    const briefing = body.auditEvents.find((event) => event.eventType === "session_briefing_write");
    expect(briefing?.metadata).toMatchObject({action: "put", agentKey: "panda", targetSessionId: "session-panda", slug: "brief"});
    const prompt = body.auditEvents.find((event) => event.eventType === "session_prompt_write");
    expect(prompt?.metadata).toMatchObject({action: "put", agentKey: "panda", targetSessionId: "session-panda", slug: "memory"});
    expect(JSON.stringify(briefing)).toContain("sha256");
    expect(JSON.stringify(prompt)).toContain("sha256");
    expect(JSON.stringify(body)).toContain("length");
    expect(JSON.stringify(body)).not.toContain("private briefing body");
    expect(JSON.stringify(body)).not.toContain("private memory body");
  });

  it("prevents scoped users from seeing another identity or invisible-agent audit event", async () => {
    const harness = await createHarness();
    await harness.pool.query(`INSERT INTO "runtime"."identities" (id, handle, display_name) VALUES ('identity-other', 'other', 'Other')`);
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.agents.ensurePairing("luna", "identity-other");
    await harness.auth.recordAudit({identityId: "identity-other", eventType: "session_briefing_write", metadata: {action: "put", agentKey: "luna", targetSessionId: "session-luna", secret: "hidden-other"}});
    await harness.auth.recordAudit({identityId: "identity-patrik", eventType: "session_prompt_write", metadata: {action: "put", agentKey: "luna", targetSessionId: "session-luna", secret: "hidden-luna"}});
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

  it("shows sanitized agent-origin MCP events for visible agents without requiring a Control identity", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    await harness.auth.recordAudit({
      eventType: "agent_mcp_operation",
      metadata: {
        actorKind: "agent",
        action: "test_mcp_server",
        outcome: "failure",
        failureCode: "credential_policy_denied",
        agentKey: "panda",
        serverName: "fixture",
        url: "https://must-not-leak.example/mcp",
        token: "must-not-leak",
      },
    });
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");

    const response = await fetch(`${base}/api/control/audit-events?eventType=agent_mcp_operation`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("test_mcp_server");
    expect(text).toContain("credential_policy_denied");
    expect(text).not.toContain("must-not-leak");
  });

  it("filters audit events by visible agent and target session", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "admin");
    await harness.auth.recordAudit({identityId: "identity-patrik", eventType: "control_operator_write", metadata: {action: "create_session", agentKey: "panda", targetSessionId: "session-panda"}});
    await harness.auth.recordAudit({identityId: "identity-patrik", eventType: "control_operator_write", metadata: {action: "create_session", agentKey: "panda", targetSessionId: "session-other"}});
    await harness.auth.recordAudit({identityId: "identity-patrik", eventType: "control_operator_write", metadata: {action: "create_session", agentKey: "luna", targetSessionId: "session-luna"}});

    const response = await fetch(`${base}/api/control/audit-events?agentKey=panda&targetSessionId=session-panda`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("session-panda");
    expect(text).not.toContain("session-other");
    expect(text).not.toContain("session-luna");
  });

  it("does not return arbitrary or unknown audit metadata fields", async () => {
    const harness = await createHarness();
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "admin");
    await harness.auth.recordAudit({identityId: "identity-patrik", eventType: "session_briefing_write", metadata: {action: "put", agentKey: "panda", targetSessionId: "session-panda", slug: "brief", token: "secret-token", prompt: "private prompt", old: {wasSet: false, length: 0, sha256: null, raw: "old"}, next: {wasSet: true, length: 12, sha256: "abc", content: "next"}}});
    await harness.auth.recordAudit({identityId: "identity-patrik", eventType: "session_prompt_write", metadata: {action: "put", agentKey: "panda", targetSessionId: "session-panda", slug: "memory", token: "secret-token", prompt: "private memory prompt", old: {wasSet: false, length: 0, sha256: null, raw: "old"}, next: {wasSet: true, length: 12, sha256: "abc", content: "next"}}});
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
    await expect(empty.json()).resolves.toMatchObject({
      briefing: {
        agentKey: "panda",
        sessionId: "session-panda",
        slug: "brief",
        content: expect.stringContaining("Fresh Start"),
        wasSet: true,
      },
    });

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

  it("reads, writes, clears, and audits generic session prompts", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);
    const promptsPath = `${base}/api/control/agents/panda/sessions/session-panda/prompts`;

    const listed = await fetch(promptsPath, {headers: {cookie: auth.cookies}});
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      prompts: [
        {slug: "brief", wasSet: true},
        {slug: "memory", content: "", wasSet: false},
        {slug: "heartbeat", content: "", wasSet: false},
      ],
    });

    const missingCsrf = await fetch(`${promptsPath}/memory`, {method: "PUT", headers: {cookie: auth.cookies}, body: JSON.stringify({content: "do not save"})});
    expect(missingCsrf.status).toBe(403);

    const invalidSlug = await fetch(`${promptsPath}/session`, {headers: {cookie: auth.cookies}});
    expect(invalidSlug.status).toBe(400);

    const blank = await fetch(`${promptsPath}/heartbeat`, {method: "PUT", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({content: "   "})});
    expect(blank.status).toBe(400);
    await expect(blank.json()).resolves.toEqual({error: "Session prompt content must not be blank. Use clear to delete the prompt."});

    const saved = await fetch(`${promptsPath}/memory`, {method: "PUT", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({content: "  private memory text  "})});
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({prompt: {slug: "memory", content: "private memory text", wasSet: true}});

    const deleteWithoutConfirm = await fetch(`${promptsPath}/memory`, {method: "DELETE", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({confirm: "wrong"})});
    expect(deleteWithoutConfirm.status).toBe(400);

    const cleared = await fetch(`${promptsPath}/memory`, {method: "DELETE", headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken}, body: JSON.stringify({confirm: "clear-session-prompt"})});
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({prompt: {slug: "memory", content: "", wasSet: false}});

    const audit = await harness.pool.query(`SELECT event_type, metadata::text AS metadata FROM "runtime"."control_audit_events" WHERE event_type = 'session_prompt_write' ORDER BY created_at ASC`);
    expect(audit.rows).toHaveLength(2);
    const auditText = JSON.stringify(audit.rows);
    expect(auditText).toContain("memory");
    expect(auditText).toContain("sha256");
    expect(auditText).toContain("length");
    expect(auditText).not.toContain("private memory text");
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



describe("Control Watches HTTP", () => {
  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>, role: "admin" | "scoped" = "scoped", agentKey = "panda") {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role, ...(role === "scoped" ? {agentKey} : {})});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    const body = await response.json() as {csrfToken: string};
    return {cookies: cookieHeader(response), csrfToken: body.csrfToken};
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
    await expect(response.json()).resolves.toEqual({
      watches: {
        agentKey: "panda",
        sessionId: "session-panda",
        data: [],
        watches: [],
        meta: {
          current_page: 1,
          last_page: 1,
          per_page: 50,
          total: 0,
        },
      },
    });
  });

  it("updates and disables visible watches without leaking private watch configuration", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const watch = await harness.watchStore.createWatch({
      sessionId: "session-panda",
      createdByIdentityId: "identity-patrik",
      title: "Private source watch",
      intervalMinutes: 15,
      source: {
        kind: "http_json",
        url: "https://private.example.test/WATCH_WRITE_PRIVATE_URL",
        headers: [{name: "X-WATCH-PRIVATE", value: "WATCH_WRITE_PRIVATE_HEADER"}],
        body: "WATCH_WRITE_PRIVATE_BODY",
        result: {observation: "snapshot", path: "WATCH_WRITE_PRIVATE_PATH"},
      },
      detector: {kind: "snapshot_changed"},
    });
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");
    const path = `${base}/api/control/agents/panda/sessions/session-panda/watches/${watch.id}`;

    const missingCsrf = await fetch(path, {
      method: "PATCH",
      headers: {cookie: auth.cookies},
      body: JSON.stringify({title: "Should not save"}),
    });
    expect(missingCsrf.status).toBe(403);

    const updated = await fetch(path, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({title: "Public source watch", intervalMinutes: 30, enabled: true}),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      watch: {
        id: watch.id,
        title: "Public source watch",
        intervalMinutes: 30,
        enabled: true,
      },
    });

    const disabled = await fetch(path, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({reason: "WATCH_WRITE_PRIVATE_DISABLE_REASON"}),
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      watch: {
        id: watch.id,
        enabled: false,
        lifecycleStatus: "disabled",
      },
    });

    const list = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches`, {headers: {cookie: auth.cookies}});
    expect(list.status).toBe(200);
    const listText = JSON.stringify(await list.json());
    expect(listText).toContain("Public source watch");
    expect(listText).not.toContain("WATCH_WRITE_PRIVATE_URL");
    expect(listText).not.toContain("WATCH_WRITE_PRIVATE_HEADER");
    expect(listText).not.toContain("WATCH_WRITE_PRIVATE_BODY");
    expect(listText).not.toContain("WATCH_WRITE_PRIVATE_PATH");
    expect(listText).not.toContain("WATCH_WRITE_PRIVATE_DISABLE_REASON");

    const audit = await harness.pool.query(`SELECT event_type, metadata::text AS metadata FROM "runtime"."control_audit_events" WHERE event_type = 'session_watch_config_write' ORDER BY created_at ASC`);
    expect(audit.rows).toHaveLength(2);
    const auditText = JSON.stringify(audit.rows);
    expect(auditText).toContain("update_watch");
    expect(auditText).toContain("disable_watch");
    expect(auditText).toContain("intervalMinutes");
    expect(auditText).not.toContain("WATCH_WRITE_PRIVATE_URL");
    expect(auditText).not.toContain("WATCH_WRITE_PRIVATE_HEADER");
    expect(auditText).not.toContain("WATCH_WRITE_PRIVATE_BODY");
    expect(auditText).not.toContain("WATCH_WRITE_PRIVATE_DISABLE_REASON");

    const visibleAudit = await fetch(`${base}/api/control/audit-events?eventType=session_watch_config_write&limit=10`, {headers: {cookie: auth.cookies}});
    expect(visibleAudit.status).toBe(200);
    const visibleAuditText = JSON.stringify(await visibleAudit.json());
    expect(visibleAuditText).toContain("session_watch_config_write");
    expect(visibleAuditText).toContain(watch.id);
    expect(visibleAuditText).not.toContain("WATCH_WRITE_PRIVATE_URL");
    expect(visibleAuditText).not.toContain("WATCH_WRITE_PRIVATE_DISABLE_REASON");
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
    const body = await response.json() as {watches: {data: Array<Record<string, unknown>>; meta: {current_page: number; last_page: number; per_page: number; total: number}; watches: Array<Record<string, unknown>>}};
    expect(Object.keys(body.watches).sort()).toEqual(["agentKey", "data", "meta", "sessionId", "watches"]);
    expect(body.watches.meta).toEqual({
      current_page: 1,
      last_page: 1,
      per_page: 10,
      total: 1,
    });
    expect(body.watches.watches).toHaveLength(1);
    expect(body.watches.data).toHaveLength(1);
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

  it("paginates, searches, sorts, and filters watches with the table contract", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const alpha = await harness.watchStore.createWatch({
      sessionId: "session-panda",
      title: "Alpha HTTP watch",
      intervalMinutes: 5,
      source: {kind: "http_json", url: "https://example.test/alpha", result: {observation: "snapshot"}},
      detector: {kind: "snapshot_changed"},
      nextPollAt: Date.parse("2040-01-01T00:00:00.000Z"),
    });
    const beta = await harness.watchStore.createWatch({
      sessionId: "session-panda",
      title: "Beta SQL watch",
      intervalMinutes: 10,
      enabled: false,
      source: {kind: "sql_query", credentialEnvKey: "SQL_TOKEN", dialect: "postgres", query: "SELECT 1", result: {observation: "scalar", valueField: "count"}},
      detector: {kind: "percent_change", percent: 10},
    });
    const gamma = await harness.watchStore.createWatch({
      sessionId: "session-panda",
      title: "Gamma HTML watch",
      intervalMinutes: 15,
      source: {kind: "http_html", url: "https://example.test/gamma", result: {observation: "snapshot", mode: "readable_text"}},
      detector: {kind: "snapshot_changed"},
      nextPollAt: Date.parse("2040-01-03T00:00:00.000Z"),
    });
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");

    const secondPage = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches?page=2&per_page=1&sort_by=title&sort_direction=asc`, {headers: {cookie: auth.cookies}});
    expect(secondPage.status).toBe(200);
    await expect(secondPage.json()).resolves.toMatchObject({
      watches: {
        data: [{id: beta.id}],
        watches: [{id: beta.id}],
        meta: {current_page: 2, last_page: 3, per_page: 1, total: 3},
      },
    });

    const search = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches?search=gamma`, {headers: {cookie: auth.cookies}});
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      watches: {
        data: [{id: gamma.id}],
        meta: {current_page: 1, last_page: 1, per_page: 50, total: 1},
      },
    });

    const sourceFilter = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches?sourceKind=sql_query`, {headers: {cookie: auth.cookies}});
    expect(sourceFilter.status).toBe(200);
    await expect(sourceFilter.json()).resolves.toMatchObject({
      watches: {
        data: [{id: beta.id}],
        meta: {total: 1},
      },
    });

    const statusFilter = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches?lifecycleStatus=disabled`, {headers: {cookie: auth.cookies}});
    expect(statusFilter.status).toBe(200);
    await expect(statusFilter.json()).resolves.toMatchObject({
      watches: {
        data: [{id: beta.id}],
        meta: {total: 1},
      },
    });

    const limited = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches?limit=250`, {headers: {cookie: auth.cookies}});
    expect(limited.status).toBe(200);
    const limitedBody = await limited.json() as {watches: {meta: {per_page: number; total: number}; data: Array<{id: string}>}};
    expect(limitedBody.watches.meta).toMatchObject({per_page: 100, total: 3});
    expect(limitedBody.watches.data.map((watch) => watch.id).sort()).toEqual([alpha.id, beta.id, gamma.id].sort());

    const invalid = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/watches?sourceKind=telegram`, {headers: {cookie: auth.cookies}});
    expect(invalid.status).toBe(400);
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
    const body = await response.json() as {csrfToken: string};
    return {cookies: cookieHeader(response), csrfToken: body.csrfToken};
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
    await expect(response.json()).resolves.toEqual({
      scheduledTasks: {
        agentKey: "panda",
        sessionId: "session-panda",
        data: [],
        tasks: [],
        meta: {
          current_page: 1,
          last_page: 1,
          per_page: 25,
          total: 0,
        },
      },
    });
  });

  it("creates, updates, cancels, and audits scheduled tasks without leaking instructions", async () => {
    const harness = await createHarness();
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness, "scoped", "panda");
    const path = `${base}/api/control/agents/panda/sessions/session-panda/scheduled-tasks`;

    const missingCsrf = await fetch(path, {
      method: "POST",
      headers: {cookie: auth.cookies},
      body: JSON.stringify({
        title: "No CSRF",
        instruction: "MISSING_CSRF_INSTRUCTION_MUST_NOT_SAVE",
        schedule: {kind: "once", runAt: "2040-03-01T10:00:00.000Z"},
      }),
    });
    expect(missingCsrf.status).toBe(403);

    const created = await fetch(path, {
      method: "POST",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        title: "Check build queue",
        instruction: "PRIVATE_CREATE_AUTOMATION_INSTRUCTION",
        enabled: false,
        schedule: {kind: "once", runAt: "2040-03-01T10:00:00.000Z"},
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as {scheduledTask: {id: string; title: string; enabled: boolean; lifecycleStatus: string; schedule: Record<string, unknown>}};
    expect(createdBody.scheduledTask).toMatchObject({
      title: "Check build queue",
      enabled: false,
      lifecycleStatus: "disabled",
      schedule: {kind: "once", runAt: "2040-03-01T10:00:00.000Z"},
    });
    expect(JSON.stringify(createdBody)).not.toContain("PRIVATE_CREATE_AUTOMATION_INSTRUCTION");

    const updated = await fetch(`${path}/${createdBody.scheduledTask.id}`, {
      method: "PATCH",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({
        title: "Daily build queue check",
        instruction: "PRIVATE_UPDATE_AUTOMATION_INSTRUCTION",
        enabled: true,
        schedule: {kind: "recurring", cron: "0 9 * * *", timezone: "Europe/Bratislava"},
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      scheduledTask: {
        id: createdBody.scheduledTask.id,
        title: "Daily build queue check",
        enabled: true,
        schedule: {kind: "recurring", cron: "0 9 * * *", timezone: "Europe/Bratislava"},
      },
    });

    const cancelled = await fetch(`${path}/${createdBody.scheduledTask.id}`, {
      method: "DELETE",
      headers: {cookie: auth.cookies, "x-control-csrf": auth.csrfToken},
      body: JSON.stringify({reason: "PRIVATE_CANCEL_AUTOMATION_REASON"}),
    });
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({
      scheduledTask: {
        id: createdBody.scheduledTask.id,
        lifecycleStatus: "cancelled",
      },
    });

    const list = await fetch(`${path}?limit=10`, {headers: {cookie: auth.cookies}});
    expect(list.status).toBe(200);
    const listText = JSON.stringify(await list.json());
    expect(listText).toContain("Daily build queue check");
    expect(listText).not.toContain("PRIVATE_CREATE_AUTOMATION_INSTRUCTION");
    expect(listText).not.toContain("PRIVATE_UPDATE_AUTOMATION_INSTRUCTION");
    expect(listText).not.toContain("PRIVATE_CANCEL_AUTOMATION_REASON");

    const audit = await harness.pool.query(`SELECT event_type, metadata::text AS metadata FROM "runtime"."control_audit_events" WHERE event_type = 'session_scheduled_task_write' ORDER BY created_at ASC`);
    expect(audit.rows).toHaveLength(3);
    const auditText = JSON.stringify(audit.rows);
    expect(auditText).toContain("sha256");
    expect(auditText).toContain("length");
    expect(auditText).toContain("create_scheduled_task");
    expect(auditText).toContain("update_scheduled_task");
    expect(auditText).toContain("cancel_scheduled_task");
    expect(auditText).not.toContain("PRIVATE_CREATE_AUTOMATION_INSTRUCTION");
    expect(auditText).not.toContain("PRIVATE_UPDATE_AUTOMATION_INSTRUCTION");
    expect(auditText).not.toContain("PRIVATE_CANCEL_AUTOMATION_REASON");

    const visibleAudit = await fetch(`${base}/api/control/audit-events?eventType=session_scheduled_task_write&limit=10`, {headers: {cookie: auth.cookies}});
    expect(visibleAudit.status).toBe(200);
    const visibleAuditText = JSON.stringify(await visibleAudit.json());
    expect(visibleAuditText).toContain("session_scheduled_task_write");
    expect(visibleAuditText).toContain(createdBody.scheduledTask.id);
    expect(visibleAuditText).not.toContain("PRIVATE_CREATE_AUTOMATION_INSTRUCTION");
    expect(visibleAuditText).not.toContain("PRIVATE_UPDATE_AUTOMATION_INSTRUCTION");
    expect(visibleAuditText).not.toContain("PRIVATE_CANCEL_AUTOMATION_REASON");
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
    const body = await response.json() as {scheduledTasks: {data: Array<Record<string, unknown>>; meta: {current_page: number; last_page: number; per_page: number; total: number}; tasks: Array<Record<string, unknown>>}};
    expect(Object.keys(body.scheduledTasks).sort()).toEqual(["agentKey", "data", "meta", "sessionId", "tasks"]);
    expect(body.scheduledTasks.tasks.map((task) => task.id).sort()).toEqual([once.id, recurring.id].sort());
    expect(body.scheduledTasks.data.map((task) => task.id).sort()).toEqual([once.id, recurring.id].sort());
    expect(body.scheduledTasks.meta).toEqual({
      current_page: 1,
      last_page: 1,
      per_page: 10,
      total: 2,
    });
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
    await expect(limited.json()).resolves.toMatchObject({
      scheduledTasks: {
        data: [{id: first.id}],
        tasks: [{id: first.id}],
        meta: {current_page: 1, last_page: 2, per_page: 1, total: 2},
      },
    });

    const secondPage = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/scheduled-tasks?page=2&per_page=1&sort_by=nextFireAt&sort_direction=asc`, {headers: {cookie: auth.cookies}});
    expect(secondPage.status).toBe(200);
    await expect(secondPage.json()).resolves.toMatchObject({
      scheduledTasks: {
        data: [{id: second.id}],
        meta: {current_page: 2, last_page: 2, per_page: 1, total: 2},
      },
    });

    const all = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/scheduled-tasks?limit=250`, {headers: {cookie: auth.cookies}});
    expect(all.status).toBe(200);
    const body = await all.json() as {scheduledTasks: {data: Array<{id: string}>; meta: {per_page: number; total: number}; tasks: Array<{id: string}>}};
    expect(body.scheduledTasks.tasks.map((task) => task.id)).toEqual([first.id, second.id]);
    expect(body.scheduledTasks.data.map((task) => task.id)).toEqual([first.id, second.id]);
    expect(body.scheduledTasks.meta).toMatchObject({per_page: 100, total: 2});

    const wrongAgent = await fetch(`${base}/api/control/agents/luna/sessions/session-panda/scheduled-tasks`, {headers: {cookie: auth.cookies}});
    expect(wrongAgent.status).toBe(404);
    const text = JSON.stringify(await wrongAgent.json());
    expect(text).not.toContain("First by next fire");
    expect(text).not.toContain("FIRST_INSTRUCTION");
  });
});


describe("Control Model Call Traces HTTP", () => {
  const CONTROL_PROMPT_CACHE_KEY_SECRET = "controlPromptCacheKeySecret";
  const CONTROL_CONTEXT_CACHE_PART_SECRET = "controlContextCachePartSecret";
  const CONTROL_RESPONSE_CACHE_PART_SECRET = "controlResponseCachePartSecret";
  const CONTROL_RESPONSE_FINGERPRINT_SECRET = "controlResponseFingerprintSecret";
  const CONTROL_ERROR_CACHE_SECRET = "controlErrorCacheSecret";
  const CONTROL_USAGE_CACHE_SECRET = "controlUsageCacheSecret";
  const PROMPT_CACHE_KEY_REDACTION_PATTERN = /^\[redacted:prompt-cache-key:sha256:[a-f0-9]{16}\]$/;

  async function login(base: string, harness: Awaited<ReturnType<typeof createHarness>>, role: "admin" | "scoped" = "admin", agentKey = "panda") {
    const grant = await harness.auth.createGrant({identityId: "identity-patrik", role, ...(role === "scoped" ? {agentKey} : {})});
    const response = await fetch(`${base}/api/control/login`, {method: "POST", body: JSON.stringify({token: grant.loginToken})});
    expect(response.status).toBe(200);
    return {cookies: cookieHeader(response)};
  }

  async function seedTrace(harness: Awaited<ReturnType<typeof createHarness>>) {
    const base64Blob = Buffer.from("private blob".repeat(30)).toString("base64");
    await harness.modelCallTraces.recordModelCallTrace({
      mode: "complete",
      tools: [],
      startedAt: Date.parse("2040-02-01T10:00:00.000Z"),
      finishedAt: Date.parse("2040-02-01T10:00:01.250Z"),
      request: {
        providerName: "openai",
        modelId: "gpt-test",
        promptCacheKey: `trace-cache:${CONTROL_PROMPT_CACHE_KEY_SECRET}`,
        metadata: {
          runId: "00000000-0000-0000-0000-000000000701",
          threadId: "thread-panda",
          sessionId: "session-panda",
          agentKey: "panda",
          turn: 3,
        },
        trace: {
          llmContextDump: "<context>PRIVATE_TOKEN_CONTEXT token=sk-controlTraceSecret https://panda.patrikmojzis.com/apps/open?token=pal_launch-token</context>",
          llmContextSections: [{
            name: "ControlTraceContext",
            source: "control-test-source",
            label: "Control trace context",
            content: "context content",
            contentPreview: "context content",
            contentChars: 15,
            estimatedTokens: 4,
            dump: "dump content",
            dumpChars: 12,
            promptCacheKeyPart: `context-cache:${CONTROL_CONTEXT_CACHE_PART_SECRET}`,
          }],
        },
        context: {
          systemPrompt: "system prompt with Bearer controlBearerSecret",
          messages: [
            {role: "user", content: "hello api_key=controlApiKeySecret"},
            {role: "assistant", content: [{type: "toolCall", id: "call-1", name: "unknown_tool", arguments: {token: "tool-token-secret", imageData: base64Blob}}]},
          ],
          tools: [{name: "unknown_tool", description: "test tool", parameters: {type: "object"}}],
        },
      },
      response: {
        role: "assistant",
        content: [{type: "text", text: "ok"}],
        api: "openai-responses",
        model: "openai/gpt-test",
        usage: {input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: {input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033}},
        stopReason: "stop",
        timestamp: Date.parse("2040-02-01T10:00:01.250Z"),
      },
    });
    const result = await harness.pool.query(`SELECT id, prompt_cache_key, request_json, response_json, usage_json FROM "runtime"."model_call_traces" LIMIT 1`);
    return result.rows[0] as {id: string; prompt_cache_key: string | null; request_json: unknown; response_json: unknown; usage_json: unknown};
  }

  async function seedFailedTrace(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      category: string;
      finishedAt: string;
      message: string;
      runId: string;
      startedAt: string;
      turn: number;
    },
  ) {
    const error = new Error(input.message);
    error.name = input.category;
    await harness.modelCallTraces.recordModelCallTrace({
      mode: "complete",
      tools: [],
      startedAt: Date.parse(input.startedAt),
      finishedAt: Date.parse(input.finishedAt),
      error,
      request: {
        providerName: "openai",
        modelId: "gpt-test",
        metadata: {
          runId: input.runId,
          threadId: "thread-panda",
          sessionId: "session-panda",
          agentKey: "panda",
          turn: input.turn,
        },
        context: {
          messages: [],
          tools: [],
        },
      },
    });
  }

  it("requires admin for list/detail and returns sanitized allowlisted DTOs", async () => {
    const harness = await createHarness();
    await harness.sessions.updateSessionLabel({
      sessionId: "session-panda",
      alias: "discord-main",
      displayName: "Patrik Discord main",
    });
    const row = await seedTrace(harness);
    expect(row.prompt_cache_key).toEqual(expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN));
    expect(row.prompt_cache_key).not.toContain(CONTROL_PROMPT_CACHE_KEY_SECRET);
    expect(JSON.stringify(row.request_json)).not.toContain(CONTROL_PROMPT_CACHE_KEY_SECRET);
    const rawPromptCacheKey = `trace-cache:${CONTROL_PROMPT_CACHE_KEY_SECRET}`;
    const persisted = JSON.stringify(row);
    for (const sentinel of [
      CONTROL_PROMPT_CACHE_KEY_SECRET,
      rawPromptCacheKey,
      "tool-token-secret",
      CONTROL_CONTEXT_CACHE_PART_SECRET,
    ]) expect(persisted).not.toContain(sentinel);
    for (const sentinel of [
      "controlBearerSecret",
      "controlApiKeySecret",
      "sk-controlTraceSecret",
      "https://panda.patrikmojzis.com/apps/open?token=pal_launch-token",
    ]) expect(persisted).toContain(sentinel);
    expect(persisted).toContain("unknown_tool_arguments");

    const rawContextCachePart = `context-cache:${CONTROL_CONTEXT_CACHE_PART_SECRET}`;
    const rawResponseCachePart = `response-cache:${CONTROL_RESPONSE_CACHE_PART_SECRET}`;
    const rawResponseFingerprint = `response-fingerprint:${CONTROL_RESPONSE_FINGERPRINT_SECRET}`;
    const rawErrorCacheKey = `error-cache:${CONTROL_ERROR_CACHE_SECRET}`;
    const rawUsageFingerprint = `usage-fingerprint:${CONTROL_USAGE_CACHE_SECRET}`;
    await harness.pool.query(
      `UPDATE "runtime"."model_call_traces"
       SET prompt_cache_key = $1,
           request_json = $2::jsonb,
           response_json = $3::jsonb,
           error_json = $4::jsonb,
           usage_json = $5::jsonb
       WHERE id = $6`,
      [
        rawPromptCacheKey,
        JSON.stringify({
          ...(row.request_json as Record<string, unknown>),
          promptCacheKey: rawPromptCacheKey,
          llmContextSections: [{
            name: "ControlTraceContext",
            source: "control-test-source",
            label: "Control trace context",
            content: "context content",
            contentPreview: "context content",
            contentChars: 15,
            estimatedTokens: 4,
            dump: "dump content",
            dumpChars: 12,
            promptCacheKeyPart: {raw: rawContextCachePart},
          }],
        }),
        JSON.stringify({
          role: "assistant",
          content: [{type: "text", text: "ok"}],
          metadata: {
            promptCacheKeyPart: rawResponseCachePart,
            nested: {promptCacheKeyFingerprint: rawResponseFingerprint},
          },
        }),
        JSON.stringify({
          category: "legacy_provider_error",
          message: "legacy failed",
          promptCacheKey: rawErrorCacheKey,
        }),
        JSON.stringify({
          input: 10,
          output: 4,
          totalTokens: 17,
          promptCacheKeyFingerprint: rawUsageFingerprint,
        }),
        row.id,
      ],
    );

    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");
    const scoped = await login(base, harness, "scoped");

    expect((await fetch(`${base}/api/control/model-call-traces`)).status).toBe(401);
    expect((await fetch(`${base}/api/control/model-call-traces`, {headers: {cookie: scoped.cookies}})).status).toBe(403);
    expect((await fetch(`${base}/api/control/model-call-traces/${row.id}`, {headers: {cookie: scoped.cookies}})).status).toBe(403);

    const list = await fetch(`${base}/api/control/model-call-traces`, {headers: {cookie: admin.cookies}});
    expect(list.status).toBe(200);
    const listBody = await list.json() as {modelCallTraces: {data: Array<Record<string, unknown>>; meta: Record<string, unknown>}};
    expect(listBody.modelCallTraces.meta).toMatchObject({total: 1, per_page: 25});
    expect(listBody.modelCallTraces.data[0]).toMatchObject({
      id: row.id,
      runId: "00000000-0000-0000-0000-000000000701",
      threadId: "thread-panda",
      sessionId: "session-panda",
      agentKey: "panda",
      sessionLabel: "Patrik Discord main",
      sessionDisplayName: "Patrik Discord main",
      sessionAlias: "discord-main",
      sessionKind: "main",
      turn: 3,
      callIndex: 3,
      provider: "openai",
      model: "gpt-test",
      mode: "complete",
      status: "completed",
      durationMs: 1250,
      promptCacheKey: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
      usage: expect.objectContaining({
        input: 10,
        output: 4,
        totalTokens: 17,
        promptCacheKeyFingerprint: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
      }),
      error: expect.objectContaining({
        category: "legacy_provider_error",
        promptCacheKey: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
      }),
    });
    expect(Object.keys(listBody.modelCallTraces.data[0]!).sort()).toEqual(["agentKey", "callIndex", "durationMs", "error", "expiresAt", "finishedAt", "id", "mode", "model", "promptCacheKey", "provider", "runId", "sessionAlias", "sessionDisplayName", "sessionId", "sessionKind", "sessionLabel", "startedAt", "status", "threadId", "turn", "usage"]);
    expect(JSON.stringify(listBody)).not.toContain(CONTROL_PROMPT_CACHE_KEY_SECRET);
    expect(JSON.stringify(listBody)).not.toContain(rawPromptCacheKey);

    const detail = await fetch(`${base}/api/control/model-call-traces/${row.id}`, {headers: {cookie: admin.cookies}});
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {modelCallTrace: Record<string, unknown>};
    expect(detailBody.modelCallTrace).toMatchObject({
      id: row.id,
      sessionLabel: "Patrik Discord main",
      sessionDisplayName: "Patrik Discord main",
      sessionAlias: "discord-main",
      sessionKind: "main",
      promptCacheKey: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
      request: expect.objectContaining({
        promptCacheKey: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
        systemPrompt: expect.stringContaining("system prompt"),
        messages: expect.any(Array),
        tools: expect.any(Array),
        llmContextSections: [expect.objectContaining({
          name: "ControlTraceContext",
          source: "control-test-source",
          label: "Control trace context",
          contentPreview: "context content",
          contentChars: 15,
          estimatedTokens: 4,
          promptCacheKeyPart: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
        })],
      }),
      response: expect.objectContaining({
        role: "assistant",
        metadata: expect.objectContaining({
          promptCacheKeyPart: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
          nested: expect.objectContaining({
            promptCacheKeyFingerprint: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
          }),
        }),
      }),
      usage: expect.objectContaining({
        totalTokens: 17,
        promptCacheKeyFingerprint: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
      }),
      error: expect.objectContaining({
        promptCacheKey: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
      }),
    });
    const apiText = JSON.stringify(detailBody);
    for (const sentinel of [
      CONTROL_PROMPT_CACHE_KEY_SECRET,
      rawPromptCacheKey,
      "tool-token-secret",
      CONTROL_CONTEXT_CACHE_PART_SECRET,
      rawContextCachePart,
      CONTROL_RESPONSE_CACHE_PART_SECRET,
      CONTROL_RESPONSE_FINGERPRINT_SECRET,
      CONTROL_ERROR_CACHE_SECRET,
      CONTROL_USAGE_CACHE_SECRET,
      rawResponseCachePart,
      rawResponseFingerprint,
      rawErrorCacheKey,
      rawUsageFingerprint,
    ]) expect(apiText).not.toContain(sentinel);
    for (const sentinel of [
      "controlBearerSecret",
      "controlApiKeySecret",
      "sk-controlTraceSecret",
      "https://panda.patrikmojzis.com/apps/open?token=pal_launch-token",
    ]) expect(apiText).toContain(sentinel);
  });

  it("serves gap-free model usage analytics only to admins", async () => {
    const harness = await createHarness();
    const now = Date.now();
    await harness.pool.query(`
      INSERT INTO "runtime"."model_call_traces" (
        id, provider, model, mode, status, started_at, finished_at,
        duration_ms, request_json, usage_json, expires_at
      ) VALUES
        ($1, 'openai', 'gpt-test', 'complete', 'completed', $2, $3, 100, '{}'::jsonb, $4::jsonb, $5),
        ($6, 'openai', 'gpt-test', 'complete', 'completed', $7, $8, 100, '{}'::jsonb, $9::jsonb, $10)
    `, [
      "00000000-0000-0000-0000-000000000721",
      new Date(now - 45 * 60_000),
      new Date(now - 45 * 60_000 + 100),
      JSON.stringify({input: 10, output: 4, cacheRead: 30, cacheWrite: 5, totalTokens: 49, cost: {input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037}}),
      new Date(now + 7 * 24 * 60 * 60_000),
      "00000000-0000-0000-0000-000000000722",
      new Date(now - 15 * 60_000),
      new Date(now - 15 * 60_000 + 100),
      JSON.stringify({input: 20, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 26, cost: {input: 0.02, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.05}}),
      new Date(now + 7 * 24 * 60 * 60_000),
    ]);

    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");
    const scoped = await login(base, harness, "scoped");

    expect((await fetch(`${base}/api/control/model-call-usage?range_hours=24&bucket_minutes=60`)).status).toBe(401);
    expect((await fetch(`${base}/api/control/model-call-usage?range_hours=24&bucket_minutes=60`, {headers: {cookie: scoped.cookies}})).status).toBe(403);

    const response = await fetch(`${base}/api/control/model-call-usage?range_hours=24&bucket_minutes=60`, {headers: {cookie: admin.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {
      modelCallUsage: {
        buckets: Array<{calls: number}>;
        range: {bucketMinutes: number};
        summary: Record<string, number>;
      };
    };
    expect(body.modelCallUsage.range.bucketMinutes).toBe(60);
    expect(body.modelCallUsage.buckets.length).toBeGreaterThanOrEqual(24);
    expect(body.modelCallUsage.buckets.length).toBeLessThanOrEqual(25);
    expect(body.modelCallUsage.buckets.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(2);
    expect(body.modelCallUsage.summary).toMatchObject({
      calls: 2,
      cacheHits: 1,
      usageCalls: 2,
      cacheReadTokens: 30,
      totalTokens: 75,
      totalCost: 0.087,
      cacheHitRate: 0.5,
      cacheReadRate: 30 / 65,
    });
  });

  it("returns failure groups across all matching model calls, not just the current page", async () => {
    const harness = await createHarness();
    await seedFailedTrace(harness, {
      category: "provider_timeout",
      message: "timeout on request a",
      runId: "00000000-0000-0000-0000-000000000710",
      startedAt: "2040-02-01T10:00:00.000Z",
      finishedAt: "2040-02-01T10:00:01.000Z",
      turn: 10,
    });
    await seedFailedTrace(harness, {
      category: "provider_timeout",
      message: "timeout on request b",
      runId: "00000000-0000-0000-0000-000000000710",
      startedAt: "2040-02-01T10:01:00.000Z",
      finishedAt: "2040-02-01T10:01:01.000Z",
      turn: 11,
    });
    await seedFailedTrace(harness, {
      category: "tool_schema",
      message: `tool schema rejected trace-cache:${CONTROL_ERROR_CACHE_SECRET}`,
      runId: "00000000-0000-0000-0000-000000000710",
      startedAt: "2040-02-01T10:02:00.000Z",
      finishedAt: "2040-02-01T10:02:01.000Z",
      turn: 12,
    });

    await expect(harness.modelCallTraces.listFailureGroups({runId: "00000000-0000-0000-0000-000000000710"}, 3))
      .resolves.toMatchObject([
        {count: 2, label: "provider_timeout", summary: "timeout on request b"},
        {count: 1, label: "tool_schema"},
      ]);

    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");
    const list = await fetch(`${base}/api/control/model-call-traces?run_id=00000000-0000-0000-0000-000000000710&per_page=1`, {headers: {cookie: admin.cookies}});

    const listText = await list.text();
    expect(list.status, listText).toBe(200);
    const listBody = JSON.parse(listText) as {
      modelCallTraces: {
        data: Array<Record<string, unknown>>;
        failureGroups: Array<Record<string, unknown>>;
        meta: Record<string, unknown>;
      };
    };
    expect(listBody.modelCallTraces.data).toHaveLength(1);
    expect(listBody.modelCallTraces.meta).toMatchObject({total: 3, per_page: 1});
    expect(listBody.modelCallTraces.failureGroups).toHaveLength(2);
    expect(listBody.modelCallTraces.failureGroups[0]).toMatchObject({
      count: 2,
      label: "provider_timeout",
      summary: "timeout on request b",
      representative: expect.objectContaining({
        provider: "openai",
        model: "gpt-test",
        status: "failed",
      }),
    });
    expect(listBody.modelCallTraces.failureGroups[1]).toMatchObject({
      count: 1,
      label: "tool_schema",
      summary: expect.stringContaining(`trace-cache:${CONTROL_ERROR_CACHE_SECRET}`),
    });
    expect(JSON.stringify(listBody)).toContain(CONTROL_ERROR_CACHE_SECRET);
  });

  it("omits session label metadata when legacy trace agent and session owner mismatch", async () => {
    const harness = await createHarness();
    await harness.sessions.updateSessionLabel({
      sessionId: "session-luna",
      alias: "luna-private",
      displayName: "Luna private model-call session",
    });
    const traceId = "00000000-0000-0000-0000-000000000709";
    await harness.pool.query(`
      INSERT INTO "runtime"."model_call_traces" (
        id,
        run_id,
        thread_id,
        session_id,
        agent_key,
        turn,
        call_index,
        provider,
        model,
        mode,
        status,
        started_at,
        finished_at,
        duration_ms,
        request_json,
        usage_json,
        expires_at
      ) VALUES (
        $1,
        '00000000-0000-0000-0000-000000000709',
        'thread-mismatched',
        'session-luna',
        'panda',
        1,
        1,
        'openai',
        'gpt-test',
        'complete',
        'completed',
        '2040-02-01T10:00:00.000Z',
        '2040-02-01T10:00:00.100Z',
        100,
        $2::jsonb,
        $3::jsonb,
        '2040-02-08T10:00:00.100Z'
      )
    `, [traceId, JSON.stringify({messages: []}), JSON.stringify({totalTokens: 1})]);

    const base = await startHarnessServer(harness);
    const admin = await login(base, harness, "admin");

    const detail = await fetch(`${base}/api/control/model-call-traces/${traceId}`, {headers: {cookie: admin.cookies}});
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {modelCallTrace: Record<string, unknown>};
    expect(detailBody.modelCallTrace).toMatchObject({
      id: traceId,
      agentKey: "panda",
      sessionId: "session-luna",
    });
    expect(detailBody.modelCallTrace).not.toHaveProperty("sessionLabel");
    expect(detailBody.modelCallTrace).not.toHaveProperty("sessionDisplayName");
    expect(detailBody.modelCallTrace).not.toHaveProperty("sessionAlias");
    expect(detailBody.modelCallTrace).not.toHaveProperty("sessionKind");

    const list = await fetch(`${base}/api/control/model-call-traces`, {headers: {cookie: admin.cookies}});
    expect(list.status).toBe(200);
    const listBody = await list.json() as {modelCallTraces: {data: Array<Record<string, unknown>>}};
    expect(listBody.modelCallTraces.data[0]).toMatchObject({id: traceId, agentKey: "panda", sessionId: "session-luna"});
    expect(listBody.modelCallTraces.data[0]).not.toHaveProperty("sessionLabel");

    const text = JSON.stringify({detailBody, listBody});
    expect(text).not.toContain("Luna private model-call session");
    expect(text).not.toContain("luna-private");
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
    await expect(response.json()).resolves.toEqual({
      runtimeActivity: {
        agentKey: "panda",
        sessionId: "session-panda",
        summary: {
          total: 0,
          running: 0,
          completed: 0,
          failed: 0,
          abortRequests: 0,
          averageDurationMs: null,
          latestStartedAt: null,
          latestFinishedAt: null,
          latestRun: null,
        },
        data: [],
        meta: {current_page: 1, last_page: 1, total: 0, per_page: 25},
      },
    });
  });

  it("cuts short-prefix inline JSON payloads from runtime error summaries", async () => {
    const harness = await createHarness();
    await seedThreads(harness);
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const shortPrefixRuntimeError = `Bad request {"id":"lowercase runtime short prefix diagnosis should not leak","messages":[{"content":"runtime short prefix secret"}]}`;
    await harness.pool.query(`
      INSERT INTO "runtime"."runs" (id, thread_id, status, started_at, finished_at, error)
      VALUES ('00000000-0000-0000-0000-000000000406', 'thread-panda', 'failed', '2040-01-05T10:00:00.000Z', '2040-01-05T10:00:01.000Z', $1)
    `, [shortPrefixRuntimeError]);
    const base = await startHarnessServer(harness);
    const auth = await login(base, harness);

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {runtimeActivity: {data: Array<Record<string, unknown>>}};
    const run = body.runtimeActivity.data[0]!;
    expect(run).toMatchObject({status: "failed", errorSummary: "Bad request"});
    const summary = String(run.errorSummary);
    for (const sentinel of [
      '"id"',
      '"messages"',
      '"content"',
      "lowercase runtime short prefix diagnosis should not leak",
      "runtime short prefix secret",
      "secret",
    ]) expect(summary).not.toContain(sentinel);
    const text = JSON.stringify(body);
    expect(text).not.toContain("lowercase runtime short prefix diagnosis should not leak");
    expect(text).not.toContain("runtime short prefix secret");
  });

  it("returns authorized same-session runs with whitelisted fields and hides raw runtime data", async () => {
    const harness = await createHarness();
    await seedThreads(harness);
    await harness.agents.ensurePairing("panda", "identity-patrik");
    const failedRuntimeError = `Command web.fetch is not allowed by the current session command lease. token=sk-abcdefghijklmnopqrstuvwxyz detail=Bad request {"messages":[{"content":"lowercase patient diagnosis should not leak"}],"stdout":"lowercase shell output"} failureKind=provider_timeout PRIVATE_RAW_RUN_ERROR_MUST_NOT_LEAK`;
    await harness.pool.query(`
      INSERT INTO "runtime"."runs" (id, thread_id, status, started_at, finished_at, abort_requested_at, abort_reason, error) VALUES
        ('00000000-0000-0000-0000-000000000401', 'thread-panda', 'failed', '2040-01-02T10:00:00.000Z', '2040-01-02T10:00:05.000Z', '2040-01-02T10:00:02.000Z', 'PRIVATE_ABORT_REASON_MUST_NOT_LEAK', $1),
        ('00000000-0000-0000-0000-000000000402', 'thread-panda', 'completed', '2040-01-01T10:00:00.000Z', '2040-01-01T10:00:01.500Z', NULL, NULL, NULL),
        ('00000000-0000-0000-0000-000000000403', 'thread-panda', 'running', '2040-01-03T10:00:00.000Z', NULL, NULL, NULL, 'PRIVATE_RUNNING_ERROR_MUST_NOT_LEAK'),
        ('00000000-0000-0000-0000-000000000404', 'thread-luna', 'failed', '2040-01-04T10:00:00.000Z', '2040-01-04T10:00:01.000Z', NULL, NULL, 'LUNA_PRIVATE_RAW_RUN_ERROR')
    `, [failedRuntimeError]);
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

    const response = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity?per_page=10`, {headers: {cookie: auth.cookies}});
    expect(response.status).toBe(200);
    const body = await response.json() as {runtimeActivity: {summary: Record<string, unknown>; data: Array<Record<string, unknown>>; meta: Record<string, unknown>}};
    expect(Object.keys(body.runtimeActivity).sort()).toEqual(["agentKey", "data", "meta", "sessionId", "summary"]);
    expect(body.runtimeActivity.summary).toMatchObject({
      total: 3,
      running: 1,
      completed: 1,
      failed: 1,
      abortRequests: 1,
      averageDurationMs: 3250,
      latestStartedAt: "2040-01-03T10:00:00.000Z",
      latestFinishedAt: "2040-01-02T10:00:05.000Z",
      latestRun: {id: "00000000-0000-0000-0000-000000000403", status: "running"},
    });
    expect(body.runtimeActivity.meta).toEqual({current_page: 1, last_page: 1, total: 3, per_page: 10});
    expect(body.runtimeActivity.data).toHaveLength(3);
    expect(body.runtimeActivity.data[0]).toMatchObject({id: "00000000-0000-0000-0000-000000000403", status: "running", startedAt: "2040-01-03T10:00:00.000Z", finishedAt: null, durationMs: null, abortRequestedAt: null, failureCategory: null, errorSummary: null});
    expect(body.runtimeActivity.data[1]).toMatchObject({
      id: "00000000-0000-0000-0000-000000000401",
      status: "failed",
      startedAt: "2040-01-02T10:00:00.000Z",
      finishedAt: "2040-01-02T10:00:05.000Z",
      durationMs: 5000,
      abortRequestedAt: "2040-01-02T10:00:02.000Z",
      failureCategory: "provider_timeout",
      errorSummary: expect.stringContaining("Command web.fetch is not allowed by the current session command lease"),
    });
    expect(body.runtimeActivity.data[1]!.errorSummary).toContain("token=sk-abcdefghijklmnopqrstuvwxyz detail=Bad request");
    expect(String(body.runtimeActivity.data[1]!.errorSummary).length).toBeLessThanOrEqual(260);
    expect(Object.keys(body.runtimeActivity.data[1]!).sort()).toEqual(["abortRequestedAt", "durationMs", "errorSummary", "failureCategory", "finishedAt", "id", "startedAt", "status"]);
    const text = JSON.stringify(body);
    for (const sentinel of [
      "PRIVATE_ABORT_REASON_MUST_NOT_LEAK",
      "PRIVATE_RAW_RUN_ERROR_MUST_NOT_LEAK",
      "PRIVATE_PROMPT_BODY_MUST_NOT_LEAK",
      "PRIVATE_ERROR_STDOUT_MUST_NOT_LEAK",
      "lowercase patient diagnosis should not leak",
      "lowercase shell output",
      "PRIVATE_RUNNING_ERROR_MUST_NOT_LEAK",
      "LUNA_PRIVATE_RAW_RUN_ERROR",
      "/workspace/private-runtime.ts",
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
      "\"error\":",
      "abortReason",
      "message",
      "metadata",
      "stdout",
      "stderr",
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

    const limited = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity?per_page=1`, {headers: {cookie: auth.cookies}});
    expect(limited.status).toBe(200);
    await expect(limited.json()).resolves.toMatchObject({
      runtimeActivity: {
        summary: {total: 2, completed: 2},
        data: [{id: "00000000-0000-0000-0000-000000000602"}],
        meta: {total: 2, per_page: 1, last_page: 2},
      },
    });

    const completed = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity?status=completed&per_page=1`, {headers: {cookie: auth.cookies}});
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({runtimeActivity: {data: [{status: "completed"}], meta: {total: 2}}});

    const clamped = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity?per_page=250`, {headers: {cookie: auth.cookies}});
    expect(clamped.status).toBe(200);
    const clampedBody = await clamped.json() as {runtimeActivity: {data: unknown[]; meta: {per_page: number}}};
    expect(clampedBody.runtimeActivity.data).toHaveLength(2);
    expect(clampedBody.runtimeActivity.meta.per_page).toBe(100);

    const invalid = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity?per_page=0`, {headers: {cookie: auth.cookies}});
    expect(invalid.status).toBe(400);

    const invalidFailure = await fetch(`${base}/api/control/agents/panda/sessions/session-panda/runtime-activity?failure_category=made_up`, {headers: {cookie: auth.cookies}});
    expect(invalidFailure.status).toBe(400);

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
        ('10000000-0000-0000-0000-000000000002', 'telegram', 'system-default', '424242', 'system', NULL, NULL, 'System Telegram', 'system-ext', 'system-user', 'enabled', '{"botToken":"PRIVATE_SYSTEM_CONFIG_TOKEN_MUST_NOT_LEAK"}'::jsonb, '{"webhook":"PRIVATE_SYSTEM_METADATA_WEBHOOK_MUST_NOT_LEAK"}'::jsonb, '2040-01-02T00:00:00.000Z', '2040-01-02T00:00:01.000Z'),
        ('10000000-0000-0000-0000-000000000003', 'discord', 'luna-main', 'discord:luna-main', 'agent', NULL, 'luna', 'Luna Discord PRIVATE_LUNA_DISPLAY_SAFE_TO_EXCLUDE', 'luna-ext', 'luna-user', 'enabled', '{"token":"PRIVATE_LUNA_CONFIG_TOKEN_MUST_NOT_LEAK"}'::jsonb, '{"channel":"PRIVATE_LUNA_METADATA_MUST_NOT_LEAK"}'::jsonb, '2040-01-03T00:00:00.000Z', '2040-01-03T00:00:01.000Z'),
        ('10000000-0000-0000-0000-000000000004', 'discord', 'identity-main', 'discord:identity-main', 'identity', 'identity-patrik', NULL, 'Identity Discord PRIVATE_IDENTITY_DISPLAY_SAFE_TO_EXCLUDE', 'identity-ext', 'identity-user', 'enabled', '{"token":"PRIVATE_IDENTITY_CONFIG_TOKEN_MUST_NOT_LEAK"}'::jsonb, '{"channel":"PRIVATE_IDENTITY_METADATA_MUST_NOT_LEAK"}'::jsonb, '2040-01-04T00:00:00.000Z', '2040-01-04T00:00:01.000Z')
    `);
    await harness.pool.query(`
      INSERT INTO "runtime"."connector_account_secrets" (account_id, secret_key, value_ciphertext, value_iv, value_tag, key_version, created_at, updated_at) VALUES
        ('10000000-0000-0000-0000-000000000001', 'bot_token', '\\x505249564154455f434950484552544558545f4d5553545f4e4f545f4c45414b', '\\x505249564154455f49565f4d5553545f4e4f545f4c45414b', '\\x505249564154455f5441475f4d5553545f4e4f545f4c45414b', 7, '2040-01-01T00:00:02.000Z', '2040-01-01T00:00:03.000Z'),
        ('10000000-0000-0000-0000-000000000002', 'bot_token', '\\x53595354454d5f434950484552544558545f4d5553545f4e4f545f4c45414b', '\\x53595354454d5f49565f4d5553545f4e4f545f4c45414b', '\\x53595354454d5f5441475f4d5553545f4e4f545f4c45414b', 3, '2040-01-02T00:00:02.000Z', '2040-01-02T00:00:03.000Z')
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
    expect(body.connectors.accounts.find((account) => account.accountKey === "system-default")).toMatchObject({
      source: "telegram",
      connectorKey: "424242",
      secretKeys: [{secretKey: "bot_token", createdAt: "2040-01-02T00:00:02.000Z", updatedAt: "2040-01-02T00:00:03.000Z"}],
    });
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

  it("returns failure-focused home attention without disabled heartbeat or todo noise", async () => {
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
    expect(body.home.status.reasonCodes).toEqual(["failed_task"]);
    const attentionTypes = body.home.attentionItems.map((item: {type: string}) => item.type);
    expect(attentionTypes).toEqual(["failed_task"]);
    expect(attentionTypes).not.toContain("blocked_todos");
    expect(attentionTypes).not.toContain("in_progress_todos");
    expect(attentionTypes).not.toContain("disabled_heartbeat");
    expect(body.home.sessions[0]).toMatchObject({
      agentKey: "panda",
      sessionId: "session-panda",
      label: "Panda mission control",
      heartbeat: {enabled: false, everyMinutes: 60, nextFireAt: "2040-01-01T00:00:00.000Z"},
      lastTaskStatus: "failed",
    });
    expect(body.home.sessions[0].links).toMatchObject({
      briefing: "/agents/panda/sessions/session-panda?tab=briefing",
    });
    expect(body.home.upcomingAutomations[0]).toMatchObject({taskId: task.id, agentKey: "panda", sessionId: "session-panda", title: "Visible safe wakeup title", scheduleKind: "once"});
    const homeText = JSON.stringify(body.home);
    expect(homeText).not.toContain("todoCounts");
    expect(homeText).not.toContain("BLOCKED_TODO_PRIVATE_CONTENT");
    expect(homeText).not.toContain("IN_PROGRESS_TODO_PRIVATE_CONTENT");
    expect(homeText).not.toContain("DONE_TODO_PRIVATE_CONTENT");
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
