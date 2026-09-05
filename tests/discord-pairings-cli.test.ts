import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";

import {registerDiscordCommands} from "../src/integrations/channels/discord/cli.js";

const mocks = vi.hoisted(() => ({pool: {query: vi.fn(), end: vi.fn(async () => {})}}));

vi.mock("../src/lib/postgres-database.js", () => ({
  withPostgresPool: async (_dbUrl: string | undefined, read: (pool: typeof mocks.pool) => Promise<unknown>) => {
    try { return await read(mocks.pool); } finally { await mocks.pool.end(); }
  },
}));

vi.mock("../src/domain/connectors/postgres.js", () => ({
  PostgresConnectorAccountStore: class {
    async getAccountByKey() {
      return {id: "account", accountKey: "ops", source: "discord", connectorKey: "connector-bot", status: "disabled"};
    }
  },
}));

describe("Discord pairings CLI with identity row parsing", () => {
  const output: string[] = [];
  let initialIdentities: Record<string, unknown>[];
  let currentIdentities: Record<string, unknown>[];
  let bindings: Record<string, unknown>[];

  function seed(count: number): void {
    initialIdentities = Array.from({length: count}, (_, index) => ({
      id: `identity-${index}`, handle: `original-${index}`, display_name: `Identity ${index}`,
      status: index === 0 ? "deleted" : "active", metadata: {private: "PRIVATE_IDENTITY_METADATA"},
      created_at: new Date(index + 1), updated_at: new Date(index + 1),
    }));
    currentIdentities = [...initialIdentities].reverse().map((identity) => ({...identity, handle: `updated-${identity.id}`}));
    bindings = initialIdentities.map((identity, index) => ({
      id: `binding-${index}`, identity_id: identity.id, source: " discord ", connector_key: " connector-bot ",
      external_actor_id: ` opaque actor ${index} `, metadata: {private: "PRIVATE_BINDING_METADATA"},
      created_at: new Date(index + 1), updated_at: new Date(index + 1),
    }));
    if (count > 0) bindings.push(
      {...bindings[0], id: "later-binding", external_actor_id: "second-actor", created_at: new Date(count + 1)},
      {...bindings[0], id: "other-source", source: "telegram", external_actor_id: "other-source-actor", created_at: new Date(count + 2)},
      {...bindings[0], id: "other-connector", connector_key: "other-bot", external_actor_id: "other-connector-actor", created_at: new Date(count + 3)},
    );
  }

  async function runPairings(): Promise<void> {
    const program = new Command().exitOverride();
    registerDiscordCommands(program);
    await program.parseAsync(["discord", "pairings", "--account", "ops"], {from: "user"});
  }

  beforeEach(() => {
    seed(2);
    output.length = 0;
    mocks.pool.query.mockReset();
    mocks.pool.end.mockClear();
    mocks.pool.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('"identity_bindings"')) {
        const ids = Array.isArray(values?.[0]) ? values[0] : [values?.[0]];
        return {rows: bindings.filter((binding) => ids.includes(binding.identity_id))};
      }
      if (sql.includes('"identities"')) {
        if (!values?.length) return {rows: initialIdentities};
        const ids = Array.isArray(values[0]) ? values[0] : [values[0]];
        return {rows: currentIdentities.filter((identity) => ids.includes(identity.id))};
      }
      throw new Error("Unexpected query in Discord pairing fixture.");
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it.each([2, 12])("renders the initial identity order and normalized bindings with three reads for %s identities", async (count) => {
    seed(count);
    await runPairings();

    const text = output.join("");
    const expectedActors = initialIdentities.flatMap((_identity, index) => index === 0 ? [" opaque actor 0 ", "second-actor"] : [` opaque actor ${index} `]);
    expect(text.trimEnd().split("\n\n").map((entry) => entry.split("\n")[0])).toEqual(expectedActors.map((actor) => `discord/ops/${actor}`));
    expect(text).toContain("  identity original-0\n");
    expect(text).toContain("  identity original-1\n");
    expect(text).toContain("  connectorKey connector-bot\n  actorId  opaque actor 0 \n");
    expect(text).not.toContain("updated-");
    expect(text).not.toContain("other-source-actor");
    expect(text).not.toContain("other-connector-actor");
    expect(text).not.toContain("PRIVATE_");
    expect(mocks.pool.query).toHaveBeenCalledTimes(3);
    expect(output).toHaveLength(1);
    expect(mocks.pool.end).toHaveBeenCalledOnce();
  });

  it("prints the empty listing without issuing batch queries", async () => {
    seed(0);
    await runPairings();
    expect(output).toEqual(["No Discord actor pairings for account ops.\n"]);
    expect(mocks.pool.query).toHaveBeenCalledOnce();
  });

  it("rejects an identity removed after the initial listing without partial output", async () => {
    currentIdentities = currentIdentities.filter((identity) => identity.id !== "identity-1");
    await expect(runPairings()).rejects.toThrow("Unknown identity identity-1");
    expect(output).toEqual([]);
    expect(mocks.pool.end).toHaveBeenCalledOnce();
  });

  it("rejects a malformed current identity even when its initial display record was valid", async () => {
    currentIdentities[0]!.status = "invalid";
    await expect(runPairings()).rejects.toThrow("Unsupported identity status invalid.");
    expect(output).toEqual([]);
  });

  it("rejects malformed unrelated bindings before filtering by source or connector", async () => {
    bindings.push({...bindings[0], id: "malformed", identity_id: "identity-1", source: "telegram", connector_key: "other-bot", external_actor_id: "  "});
    await expect(runPairings()).rejects.toThrow("Identity binding external actor id must not be empty.");
    expect(output).toEqual([]);
    expect(mocks.pool.end).toHaveBeenCalledOnce();
  });

  it.each([2, 3])("propagates query %s failures without partial stdout", async (failedQuery) => {
    const read = mocks.pool.query.getMockImplementation()!;
    const failure = new Error("Synthetic batch query failure.");
    let calls = 0;
    mocks.pool.query.mockImplementation(async (...args) => {
      calls++;
      if (calls === failedQuery) throw failure;
      return read(...args);
    });
    await expect(runPairings()).rejects.toBe(failure);
    expect(output).toEqual([]);
    expect(mocks.pool.end).toHaveBeenCalledOnce();
  });
});
