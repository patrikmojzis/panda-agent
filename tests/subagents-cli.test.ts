import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {buildSubagentTableNames} from "../src/domain/subagents/postgres-shared.js";
import {registerSubagentCommands} from "../src/app/subagents/cli.js";

const subagentCliMocks = vi.hoisted(() => {
  const state: {
    pool?: {
      connect(): Promise<any>;
      query(text: string, values?: readonly unknown[]): Promise<any>;
    };
  } = {};

  return {
    state,
    withPostgresPool: vi.fn(async (
      _dbUrl: string | undefined,
      fn: (pool: NonNullable<typeof state.pool>) => Promise<unknown>,
    ) => {
      if (!state.pool) {
        throw new Error("Expected test pool to be configured.");
      }
      return fn(state.pool);
    }),
  };
});

vi.mock("../src/app/runtime/postgres-bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/runtime/postgres-bootstrap.js")>();
  return {
    ...actual,
    withPostgresPool: subagentCliMocks.withPostgresPool,
  };
});

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => undefined,
  });
  registerSubagentCommands(program);
  return program;
}

function collectWrites(write: {mock: {calls: unknown[][]}}): string {
  return write.mock.calls.map((call) => String(call[0])).join("");
}

function parseLastJson(write: {mock: {calls: unknown[][]}}): unknown {
  const output = collectWrites(write).trim();
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.startsWith("{") || line.startsWith("["));
  if (start < 0) {
    throw new Error(`No JSON object in output: ${output}`);
  }
  return JSON.parse(lines.slice(start).join("\n"));
}

describe("subagents profiles CLI", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    subagentCliMocks.state.pool = undefined;
    subagentCliMocks.withPostgresPool.mockClear();
    vi.restoreAllMocks();
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createHarness() {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    db.public.registerFunction({
      name: "hashtextextended",
      args: [DataType.text, DataType.integer],
      returns: DataType.bigint,
      implementation: (value: string) => value.length,
    });
    db.public.registerFunction({
      name: "pg_advisory_xact_lock",
      args: [DataType.bigint],
      returns: DataType.void,
      implementation: () => undefined,
    });
    db.public.registerFunction({
      name: "length",
      args: [DataType.text],
      returns: DataType.integer,
      implementation: (value: string) => value.length,
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const tables = buildSubagentTableNames();
    async function emulatePartialUpsert(
      runQuery: (text: string, values?: readonly unknown[]) => Promise<{rows: readonly unknown[]; rowCount?: number | null}>,
      text: string,
      values?: readonly unknown[],
    ): Promise<{rows: readonly unknown[]; rowCount?: number | null} | null> {
      if (!text.includes("ON CONFLICT (slug) WHERE agent_key IS NULL")
        && !text.includes("ON CONFLICT (agent_key, slug) WHERE agent_key IS NOT NULL")) {
        return null;
      }

      const isGlobal = text.includes("ON CONFLICT (slug) WHERE agent_key IS NULL");
      const update = isGlobal
        ? await runQuery(`
          UPDATE ${tables.subagentProfiles}
          SET description = $3,
              prompt = $4,
              tool_groups = $5::jsonb,
              model = $6,
              thinking = $7,
              transcript_mode = $8,
              source = $9,
              created_by_agent_key = $10,
              enabled = $11,
              updated_at = NOW()
          WHERE slug = $1
            AND agent_key IS NULL
          RETURNING *
        `, values)
        : await runQuery(`
          UPDATE ${tables.subagentProfiles}
          SET description = $3,
              prompt = $4,
              tool_groups = $5::jsonb,
              model = $6,
              thinking = $7,
              transcript_mode = $8,
              source = $9,
              created_by_agent_key = $10,
              enabled = $11,
              updated_at = NOW()
          WHERE slug = $1
            AND agent_key = $2
          RETURNING *
        `, values);
      if (update.rows.length > 0) {
        return update;
      }

      return runQuery(`
        INSERT INTO ${tables.subagentProfiles} (
          slug,
          agent_key,
          description,
          prompt,
          tool_groups,
          model,
          thinking,
          transcript_mode,
          source,
          created_by_agent_key,
          enabled
        ) VALUES (
          $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11
        )
        RETURNING *
      `, values);
    }
    const originalQuery = pool.query.bind(pool);
    pool.query = async (text: string, values?: readonly unknown[]) => {
      if (
        text.includes("subagent_profiles_global_slug_idx")
        || text.includes("subagent_profiles_agent_slug_idx")
      ) {
        return {rows: []};
      }
      const emulated = await emulatePartialUpsert(originalQuery, text, values);
      return emulated ?? originalQuery(text, values);
    };
    const originalConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await originalConnect();
      const originalClientQuery = client.query.bind(client);
      client.query = async (text: string, values?: readonly unknown[]) => {
        const emulated = await emulatePartialUpsert(originalClientQuery, text, values);
        return emulated ?? originalClientQuery(text, values);
      };
      return client;
    };
    pools.push(pool);
    subagentCliMocks.state.pool = pool;

    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });

    return {pool};
  }

  it("lists, gets, upserts, and disables custom DB-backed profiles", async () => {
    await createHarness();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "subagents",
      "profiles",
      "upsert",
      "reviewer",
      "--agent",
      "panda",
      "--description",
      "Review code changes.",
      "--tool-groups",
      "core,workspace_read",
      "--prompt",
      "Review the assigned patch.",
      "--thinking",
      "high",
      "--db-url",
      "postgres://subagents-cli-test",
      "--json",
    ], {from: "user"});

    expect(parseLastJson(write)).toMatchObject({
      slug: "reviewer",
      source: "custom",
      agentKey: "panda",
      description: "Review code changes.",
      toolGroups: ["core", "workspace_read"],
      thinking: "high",
      enabled: true,
    });
    expect(collectWrites(write)).not.toContain("Review the assigned patch.");

    write.mockClear();
    await createProgram().parseAsync([
      "subagents",
      "profiles",
      "list",
      "--agent",
      "panda",
      "--db-url",
      "postgres://subagents-cli-test",
      "--json",
    ], {from: "user"});
    expect(parseLastJson(write)).toEqual([
      expect.objectContaining({slug: "reviewer", enabled: true}),
    ]);

    write.mockClear();
    await createProgram().parseAsync([
      "subagents",
      "profiles",
      "get",
      "reviewer",
      "--agent",
      "panda",
      "--show-prompt",
      "--db-url",
      "postgres://subagents-cli-test",
      "--json",
    ], {from: "user"});
    expect(parseLastJson(write)).toMatchObject({
      slug: "reviewer",
      prompt: "Review the assigned patch.",
    });

    write.mockClear();
    await createProgram().parseAsync([
      "subagents",
      "profiles",
      "disable",
      "reviewer",
      "--agent",
      "panda",
      "--db-url",
      "postgres://subagents-cli-test",
      "--json",
    ], {from: "user"});
    expect(parseLastJson(write)).toMatchObject({
      slug: "reviewer",
      enabled: false,
    });

    write.mockClear();
    await createProgram().parseAsync([
      "subagents",
      "profiles",
      "get",
      "reviewer",
      "--agent",
      "panda",
      "--include-disabled",
      "--db-url",
      "postgres://subagents-cli-test",
      "--json",
    ], {from: "user"});
    expect(parseLastJson(write)).toMatchObject({
      slug: "reviewer",
      enabled: false,
    });
    expect(subagentCliMocks.withPostgresPool).toHaveBeenCalledWith(
      "postgres://subagents-cli-test",
      expect.any(Function),
    );
  });
});
