import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/postgres.js";
import {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {McpOAuthService} from "../src/domain/mcp/oauth-service.js";
import {PostgresMcpOAuthStore} from "../src/domain/mcp/oauth-postgres.js";
import {MCP_OAUTH_STATE_VERSION} from "../src/domain/mcp/oauth-types.js";
import {McpOAuthProviderSession} from "../src/integrations/mcp/oauth.js";

const authConfig = {
  type: "oauth" as const,
  registration: {mode: "dynamic" as const},
  scope: {mode: "explicit" as const, values: ["resource:read"]},
};

describe("MCP OAuth persistence", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) await pools.pop()?.end();
  });

  async function harness() {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const agents = new PostgresAgentStore({pool});
    const store = new PostgresMcpOAuthStore(pool);
    await agents.ensureAgentTableSchema();
    await store.ensureSchema();
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    return {pool, store, service: new McpOAuthService({store, crypto: new CredentialCrypto("test-master-key")})};
  }

  it("round-trips encrypted connection state and never stores token plaintext", async () => {
    const {pool, service} = await harness();
    const connection = await service.saveConnection({
      agentKey: "panda",
      serverName: "reports",
      expectedVersion: null,
      resourceUrl: "https://mcp.example.test/mcp",
      authorizationServerUrl: "https://auth.example.test",
      state: {version: MCP_OAUTH_STATE_VERSION, tokens: {access_token: "secret-access-token", token_type: "Bearer"}},
      authorizedAt: Date.now(),
    });
    expect(connection?.state.tokens).toMatchObject({access_token: "secret-access-token"});
    const row = (await pool.query("SELECT * FROM runtime.agent_mcp_oauth_connections")).rows[0];
    expect(JSON.stringify(row)).not.toContain("secret-access-token");
  });

  it("uses compare-and-set versions for token rotation", async () => {
    const {service} = await harness();
    const initial = await service.saveConnection({agentKey: "panda", serverName: "reports", expectedVersion: null, state: {version: MCP_OAUTH_STATE_VERSION}});
    expect(initial?.version).toBe(1);
    const winner = await service.saveConnection({agentKey: "panda", serverName: "reports", expectedVersion: 1, state: {version: MCP_OAUTH_STATE_VERSION, tokens: {access_token: "winner", token_type: "Bearer"}}});
    expect(winner?.version).toBe(2);
    await expect(service.saveConnection({agentKey: "panda", serverName: "reports", expectedVersion: 1, state: {version: MCP_OAUTH_STATE_VERSION, tokens: {access_token: "loser", token_type: "Bearer"}}})).resolves.toBeNull();
  });

  it("keeps a concurrently refreshed winner instead of overwriting or deleting it", async () => {
    const {service} = await harness();
    await service.saveConnection({
      agentKey: "panda",
      serverName: "reports",
      expectedVersion: null,
      state: {
        version: MCP_OAUTH_STATE_VERSION,
        clientInformation: {client_id: "client-id"},
        tokens: {access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer"},
      },
    });
    const options = {service, agentKey: "panda", serverName: "reports", serverUrl: "https://mcp.example.test/mcp", authConfig, redirectUrl: "https://panda.example.test/api/control/mcp/oauth/callback"};
    const winner = await McpOAuthProviderSession.create(options);
    const loser = await McpOAuthProviderSession.create(options);
    const staleFailure = await McpOAuthProviderSession.create(options);

    await winner.provider.saveTokens({access_token: "winner-access", refresh_token: "winner-refresh", token_type: "Bearer"});
    await loser.provider.saveTokens({access_token: "loser-access", refresh_token: "loser-refresh", token_type: "Bearer"});
    await staleFailure.markReauthorizationRequired(true);

    await expect(service.getConnection("panda", "reports")).resolves.toMatchObject({
      state: {tokens: {access_token: "winner-access", refresh_token: "winner-refresh"}, reauthorizationRequired: false},
    });
  });

  it("consumes PKCE state once and rejects expiry and replay", async () => {
    const {service} = await harness();
    await service.saveConnection({agentKey: "panda", serverName: "reports", expectedVersion: null, state: {version: MCP_OAUTH_STATE_VERSION}});
    await service.createAttempt({rawState: "state-one", codeVerifier: "verifier-one", agentKey: "panda", serverName: "reports", initiator: {kind: "control", identityId: "identity-1", sessionId: "session-1"}, expiresAt: 2_000});
    await expect(service.consumeAttempt("state-one", 1_000)).resolves.toMatchObject({codeVerifier: "verifier-one"});
    await expect(service.consumeAttempt("state-one", 1_000)).resolves.toBeNull();
    await service.createAttempt({rawState: "state-two", codeVerifier: "verifier-two", agentKey: "panda", serverName: "reports", initiator: {kind: "control", identityId: "identity-1", sessionId: "session-1"}, expiresAt: 2_000});
    await expect(service.consumeAttempt("state-two", 2_001)).resolves.toBeNull();
  });

  it("persists an agent OAuth initiator without requiring a Control identity", async () => {
    const {service} = await harness();
    await service.saveConnection({agentKey: "panda", serverName: "reports", expectedVersion: null, state: {version: MCP_OAUTH_STATE_VERSION}});
    await service.createAttempt({
      rawState: "agent-state",
      codeVerifier: "agent-verifier",
      agentKey: "panda",
      serverName: "reports",
      initiator: {kind: "agent", agentKey: "panda", sessionId: "session-agent", threadId: "thread-agent"},
      expiresAt: 2_000,
    });
    await expect(service.consumeAttempt("agent-state", 1_000)).resolves.toMatchObject({
      codeVerifier: "agent-verifier",
      initiator: {kind: "agent", agentKey: "panda", sessionId: "session-agent", threadId: "thread-agent"},
    });
  });

  it("cascades OAuth state when the agent is deleted", async () => {
    const {pool, service} = await harness();
    await service.saveConnection({agentKey: "panda", serverName: "reports", expectedVersion: null, state: {version: MCP_OAUTH_STATE_VERSION}});
    await pool.query("DELETE FROM runtime.agents WHERE agent_key='panda'");
    expect((await pool.query("SELECT * FROM runtime.agent_mcp_oauth_connections")).rows).toEqual([]);
  });
});
