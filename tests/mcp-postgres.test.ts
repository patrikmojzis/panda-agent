import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/postgres.js";
import {normalizeMcpConfig} from "../src/domain/mcp/config.js";
import {PostgresMcpConfigStore} from "../src/domain/mcp/postgres.js";
import {McpRegistryVersionConflictError} from "../src/domain/mcp/store.js";

const stdio = (command = "node") => ({
  transport: "stdio",
  enabled: true,
  command,
  args: [],
  timeoutMs: 30_000,
});

describe("MCP config persistence", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) await pools.pop()?.end();
  });

  async function harness() {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const agents = new PostgresAgentStore({pool});
    const configs = new PostgresMcpConfigStore(pool);
    await agents.ensureAgentTableSchema();
    await configs.ensureSchema();
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await agents.bootstrapAgent({agentKey: "luna", displayName: "Luna"});
    return {agents, configs, pool};
  }

  it("treats an absent row as empty and isolates agent registries", async () => {
    const {configs} = await harness();
    await expect(configs.getAgentConfig("panda")).resolves.toEqual({
      agentKey: "panda",
      config: {servers: {}},
      version: 0,
    });

    await configs.putServer("panda", "fixture", stdio());
    await expect(configs.getAgentConfig("panda")).resolves.toMatchObject({
      agentKey: "panda",
      config: {servers: {fixture: stdio()}},
    });
    await expect(configs.getAgentConfig("luna")).resolves.toEqual({
      agentKey: "luna",
      config: {servers: {}},
      version: 0,
    });
  });

  it("keeps an empty row after deleting the final server and cascades with the agent", async () => {
    const {configs, pool} = await harness();
    await configs.putServer("panda", "fixture", stdio());
    await expect(configs.deleteServer("panda", "fixture")).resolves.toMatchObject({
      deleted: true,
      record: {config: {servers: {}}},
    });
    expect((await pool.query("SELECT config FROM runtime.agent_mcp_configs WHERE agent_key = 'panda'")).rows[0]?.config).toEqual({servers: {}});

    await pool.query("DELETE FROM runtime.agents WHERE agent_key = 'panda'");
    expect((await pool.query("SELECT * FROM runtime.agent_mcp_configs WHERE agent_key = 'panda'")).rows).toEqual([]);
  });

  it("fails closed on malformed persisted JSON", async () => {
    const {configs, pool} = await harness();
    await pool.query("INSERT INTO runtime.agent_mcp_configs (agent_key, config) VALUES ('panda', $1::jsonb)", [JSON.stringify({servers: {fixture: {...stdio(), surprise: true}}})]);
    await expect(configs.getAgentConfig("panda")).rejects.toThrow("unsupported field surprise");
  });

  it("locks the owning agent and current config inside every mutation", async () => {
    const {pool} = await harness();
    const queries: string[] = [];
    const tracedStore = new PostgresMcpConfigStore({
      query: (sql, params) => pool.query(sql, params),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql: string, params?: readonly unknown[]) => {
            queries.push(sql.replace(/\s+/g, " ").trim());
            return client.query(sql, params);
          },
          release: () => client.release(),
        };
      },
    });
    await tracedStore.putServer("panda", "fixture", stdio());
    expect(queries.some((sql) => /FROM "runtime"\."agents".*FOR UPDATE/.test(sql))).toBe(true);
    expect(queries.some((sql) => /FROM "runtime"\."agent_mcp_configs".*FOR UPDATE/.test(sql))).toBe(true);
  });

  it("increments versions only for real changes and rejects stale writes", async () => {
    const {configs} = await harness();
    await expect(configs.putServer("panda", "fixture", stdio(), {mode: "create", expectedVersion: 0})).resolves.toMatchObject({
      changed: true,
      record: {version: 1},
    });
    await expect(configs.setServerEnabled("panda", "fixture", true, {expectedVersion: 1})).resolves.toMatchObject({
      changed: false,
      record: {version: 1},
    });
    await expect(configs.putServer("panda", "fixture", stdio("bun"), {mode: "update", expectedVersion: 0})).rejects.toEqual(
      expect.objectContaining<McpRegistryVersionConflictError>({currentVersion: 1}),
    );
    await expect(configs.putServer("panda", "fixture", stdio("bun"), {mode: "update", expectedVersion: 1})).resolves.toMatchObject({
      previous: stdio(),
      server: stdio("bun"),
      record: {version: 2},
    });
    await expect(configs.deleteServer("panda", "missing", {expectedVersion: 2})).resolves.toMatchObject({deleted: false, record: {version: 2}});
  });
});

describe("MCP config parser", () => {
  it("accepts all explicit transports and credentialEnvKey sources", () => {
    expect(normalizeMcpConfig({
      servers: {
        local: {
          ...stdio(),
          env: {FIXTURE_SECRET: {credentialEnvKey: "FIXTURE_SECRET"}, TENANT: {value: "demo"}},
        },
        modern: {
          transport: "streamable-http",
          enabled: true,
          url: "http://fixture:3000/mcp?tenant=demo",
          auth: {type: "bearer", credentialEnvKey: "MCP_TOKEN"},
          headers: [{name: "X-API-Key", credentialEnvKey: "MCP_API_KEY"}, {name: "X-Tenant", value: "demo"}],
        },
        legacy: {transport: "sse", enabled: false, url: "https://example.test/sse"},
      },
    })).toMatchObject({
      servers: {
        local: {transport: "stdio", timeoutMs: 30_000},
        modern: {transport: "streamable-http", timeoutMs: 30_000},
        legacy: {transport: "sse", timeoutMs: 30_000},
      },
    });
  });

  it("accepts provider-neutral OAuth config without interpreting scopes", () => {
    expect(normalizeMcpConfig({servers: {remote: {
      transport: "streamable-http",
      enabled: true,
      url: "https://mcp.example.test/mcp",
      auth: {
        type: "oauth",
        registration: {mode: "dynamic"},
        scope: {mode: "explicit", values: ["documents:read", "search"]},
        trustedOrigins: ["https://login.example.test"],
      },
    }}})).toMatchObject({servers: {remote: {auth: {
      type: "oauth",
      scope: {mode: "explicit", values: ["documents:read", "search"]},
    }}}});
  });

  it.each([
    [{servers: {bad: {...stdio(), unknown: true}}}, "unsupported field unknown"],
    [{servers: {bad: {...stdio(), enabled: undefined}}}, "enabled must be a boolean"],
    [{servers: {bad: {...stdio(), timeoutMs: 120_001}}}, "between 1000 and 120000"],
    [{servers: {bad: {transport: "streamable-http", enabled: true, url: "file:///etc/passwd"}}}, "http: or https:"],
    [{servers: {bad: {transport: "sse", enabled: true, url: "https://user:pass@example.test/sse"}}}, "must not include userinfo"],
    [{servers: {bad: {transport: "sse", enabled: true, url: "https://example.test/sse#secret"}}}, "must not include a fragment"],
    [{servers: {bad: {transport: "sse", enabled: true, url: "https://example.test/sse", headers: [{name: "Mcp-Session-Id", value: "x"}]}}}, "owned by HTTP or the MCP SDK"],
    [{servers: {bad: {transport: "sse", enabled: true, url: "https://example.test/sse", headers: [{name: "X-Test", value: "x", credentialEnvKey: "TOKEN"}]}}}, "exactly one"],
    [{servers: {bad: {transport: "sse", enabled: true, url: "https://example.test/sse", auth: {type: "oauth", registration: {mode: "dynamic"}, scope: {mode: "server-default"}}}}}, "requires streamable-http"],
    [{servers: {bad: {transport: "streamable-http", enabled: true, url: "http://example.test/mcp", auth: {type: "oauth", registration: {mode: "dynamic"}, scope: {mode: "server-default"}}}}}, "must use HTTPS"],
    [{servers: {bad: {transport: "streamable-http", enabled: true, url: "https://example.test/mcp", auth: {type: "oauth", registration: {mode: "dynamic"}, scope: {mode: "explicit", values: []}}}}}, "explicit scope values"],
    [{servers: {bad: {transport: "streamable-http", enabled: true, url: "https://example.test/mcp", auth: {type: "oauth", registration: {mode: "dynamic"}, scope: {mode: "explicit", values: ["read", "read"]}}}}}, "must be unique"],
    [{servers: {bad: {transport: "streamable-http", enabled: true, url: "https://example.test/mcp", auth: {type: "oauth", registration: {mode: "dynamic"}, scope: {mode: "server-default"}, trustedOrigins: ["https://auth.example.test/path"]}}}}, "only an origin"],
  ])("rejects invalid config %#", (value, message) => {
    expect(() => normalizeMcpConfig(value)).toThrow(message as string);
  });

  it("caps an agent registry at 100 servers", () => {
    const servers = Object.fromEntries(Array.from({length: 101}, (_, index) => [`server-${index}`, stdio()]));
    expect(() => normalizeMcpConfig({servers})).toThrow("more than 100 servers");
  });
});
