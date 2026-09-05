import {randomUUID} from "node:crypto";
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresControlAuthService} from "../../src/domain/control/auth.js";
import {ControlMcpService} from "../../src/domain/control/mcp-service.js";
import {ControlReadService} from "../../src/domain/control/read-service.js";
import type {ControlLoginResult, ControlSessionRecord} from "../../src/domain/control/types.js";
import {PostgresIdentityStore} from "../../src/domain/identity/postgres.js";
import {McpManagementService} from "../../src/domain/mcp/management-service.js";
import {PostgresMcpConfigStore} from "../../src/domain/mcp/postgres.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import type {PgQueryable} from "../../src/lib/postgres-query.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;
const denied = "Control target agent was not found or is not visible.";
const keys = ["visible", "other-visible", "no-grant", "no-pairing", "revoked-grant", "deleted-agent", "outsider-only", "grant-other-pairing", "pairing-other-grant"];

describe("Control agent visibility with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let agents: PostgresAgentStore;
  let auth: PostgresControlAuthService;
  let reads: ControlReadService;
  let scopedLogin: ControlLoginResult;
  let adminSession: ControlSessionRecord;
  let identityId: string;
  const visibleGrants: string[] = [];
  const authorizationQueries: {sql: string; rowCount: number}[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({connectionString: target.connectionString, applicationName: "panda/control-agent-visibility-test", max: 4});
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    agents = new PostgresAgentStore({pool});
    auth = new PostgresControlAuthService({pool});
    const identities = new PostgresIdentityStore({pool});
    identityId = (await identities.createIdentity({id: randomUUID(), handle: "visibility-reader", displayName: "Visibility fixture"})).id;
    const outsiderId = (await identities.createIdentity({id: randomUUID(), handle: "visibility-outsider", displayName: "Other fixture"})).id;
    for (const agentKey of keys) {
      await agents.bootstrapAgent({agentKey, displayName: agentKey, status: agentKey === "deleted-agent" ? "deleted" : "active"});
      if (!["no-pairing", "outsider-only", "grant-other-pairing"].includes(agentKey)) await agents.ensurePairing(agentKey, identityId);
      if (["outsider-only", "grant-other-pairing"].includes(agentKey)) await agents.ensurePairing(agentKey, outsiderId);
      if (agentKey !== "no-grant") {
        const owner = ["outsider-only", "pairing-other-grant"].includes(agentKey) ? outsiderId : identityId;
        const grant = await auth.createGrant({identityId: owner, role: "scoped", agentKey});
        if (agentKey === "visible") {
          visibleGrants.push(grant.grant.id);
          scopedLogin = await auth.loginWithToken(grant.loginToken);
        }
        if (agentKey === "revoked-grant") await pool.query("UPDATE runtime.control_grants SET active = FALSE WHERE id = $1", [grant.grant.id]);
      }
    }
    visibleGrants.push((await auth.createGrant({identityId, role: "scoped", agentKey: "visible"})).grant.id);
    const adminGrant = await auth.createGrant({identityId, role: "admin"});
    adminSession = (await auth.loginWithToken(adminGrant.loginToken)).session;
    const sessions = new PostgresSessionStore({pool});
    for (let index = 0; index < 3; index++) {
      await sessions.createSession({id: `visibility-session-${index}`, agentKey: "visible", kind: "branch", currentThreadId: `visibility-thread-${index}`});
    }
    await pool.query(`INSERT INTO runtime.agent_mcp_configs (agent_key, config)
      VALUES ('visible', '{"servers":{}}'), ('other-visible', '{"servers":{}}')`);
    const measured: PgQueryable = {async query(sql, values) {
      const result = await pool.query(sql, values);
      authorizationQueries.push({sql, rowCount: result.rows.length});
      return result;
    }};
    reads = new ControlReadService({pool: measured});
  });

  beforeEach(() => { authorizationQueries.length = 0; });
  afterAll(async () => { await pool?.end(); });

  liveIt.each(["scoped", "admin"] as const)("preserves %s visibility with one bounded query", async (role) => {
    const session = role === "admin" ? adminSession : scopedLogin.session;
    for (const agentKey of [...keys, "missing"]) {
      authorizationQueries.length = 0;
      const visible = role === "admin" ? keys.includes(agentKey) && agentKey !== "deleted-agent"
        : ["visible", "other-visible"].includes(agentKey);
      if (visible) await expect(reads.assertAgentVisible(session, agentKey)).resolves.toBe(agentKey);
      else await expect(reads.assertAgentVisible(session, agentKey)).rejects.toThrow(denied);
      expect(authorizationQueries).toHaveLength(1);
      expect(authorizationQueries[0]!.rowCount).toBeLessThanOrEqual(1);
      expect(authorizationQueries[0]!.sql).not.toMatch(/agent_mcp_configs|agent_sessions|COUNT\s*\(/i);
    }
  });

  liveIt("keeps listing enrichment and duplicate-grant aggregates separate from authorization", async () => {
    const listed = await reads.listAgents(scopedLogin.session);
    expect(listed.map((agent) => agent.agentKey)).toEqual(["other-visible", "visible"]);
    expect(listed.find((agent) => agent.agentKey === "visible")).toMatchObject({sessionCount: 6, paired: true, mcpServerCount: 0});
    authorizationQueries.length = 0;
    await expect(reads.assertAgentVisible(scopedLogin.session, "visible")).resolves.toBe("visible");
    expect(authorizationQueries.map((query) => query.rowCount)).toEqual([1]);
  });

  liveIt("rechecks grant and pairing revocation without elevating an existing scoped session", async () => {
    expect((await auth.getSessionByToken(scopedLogin.sessionToken))?.role).toBe("scoped");
    await expect(reads.assertAgentVisible(scopedLogin.session, "no-grant")).rejects.toThrow(denied);
    await expect(reads.assertAgentVisible(adminSession, "no-grant")).resolves.toBe("no-grant");
    try {
      await pool.query("UPDATE runtime.control_grants SET active = FALSE WHERE id = ANY($1::uuid[])", [visibleGrants]);
      await expect(reads.assertAgentVisible(scopedLogin.session, "visible")).rejects.toThrow(denied);
    } finally {
      await pool.query("UPDATE runtime.control_grants SET active = TRUE WHERE id = ANY($1::uuid[])", [visibleGrants]);
    }
    try {
      await agents.deletePairing("visible", identityId);
      await expect(reads.assertAgentVisible(scopedLogin.session, "visible")).rejects.toThrow(denied);
    } finally {
      await agents.ensurePairing("visible", identityId);
    }
    await expect(reads.assertAgentVisible(scopedLogin.session, "visible")).resolves.toBe("visible");
  });

  liveIt("normalizes the target and rejects blank input before querying", async () => {
    await expect(reads.assertAgentVisible(scopedLogin.session, " \t ")).rejects.toThrow("Agent key is required.");
    expect(authorizationQueries).toHaveLength(0);
    await expect(reads.assertAgentVisible(scopedLogin.session, " visible ")).resolves.toBe("visible");
    await expect(reads.assertAgentVisible(scopedLogin.session, "Visible")).rejects.toThrow(denied);
  });

  liveIt("authorizes MCP operations without parsing unrelated agent configuration", async () => {
    const configs = new PostgresMcpConfigStore(pool);
    const configReads = vi.spyOn(configs, "getAgentConfig");
    const unexpected = vi.fn(async () => { throw new Error("No credentials or external MCP work belong in this fixture."); });
    const management = new McpManagementService({configs, credentials: {resolveCredential: unexpected}, runner: {listTools: unexpected, callTool: unexpected}});
    const mcp = new ControlMcpService({reads, management});
    try {
      await pool.query(`UPDATE runtime.agent_mcp_configs SET config = '{"servers":[]}' WHERE agent_key = 'other-visible'`);
      await expect(mcp.listServers(scopedLogin.session, " visible ")).resolves.toEqual({servers: [], count: 0, version: 1});
      expect(authorizationQueries).toHaveLength(1);
      expect(authorizationQueries[0]!.sql).not.toMatch(/agent_mcp_configs|agent_sessions|COUNT\s*\(/i);
      expect(configReads.mock.calls).toEqual([["visible"]]);
      await expect(mcp.listServers(scopedLogin.session, "no-pairing")).rejects.toThrow(denied);
      expect(configReads.mock.calls).toEqual([["visible"]]);
      expect(unexpected).not.toHaveBeenCalled();
    } finally {
      await pool.query(`UPDATE runtime.agent_mcp_configs SET config = '{"servers":{}}' WHERE agent_key = 'other-visible'`);
      configReads.mockRestore();
    }
  });
});
