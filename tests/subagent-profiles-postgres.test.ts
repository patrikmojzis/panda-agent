import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {
  BUILTIN_SUBAGENT_PROFILES,
  PostgresSubagentProfileStore,
} from "../src/domain/subagents/index.js";
import {buildSubagentTableNames} from "../src/domain/subagents/postgres-shared.js";

describe("PostgresSubagentProfileStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createStores() {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    db.public.registerFunction({
      name: "length",
      args: [DataType.text],
      returns: DataType.integer,
      implementation: (value: string) => value.length,
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const originalQuery = pool.query.bind(pool);
    pool.query = async (text: string, values?: readonly unknown[]) => {
      // pg-mem corrupts queries after partial unique indexes on nullable columns.
      // Production Postgres uses the indexes; this test keeps pg-mem focused on store behavior.
      if (
        text.includes("subagent_profiles_global_slug_idx")
        || text.includes("subagent_profiles_agent_slug_idx")
      ) {
        return {rows: []};
      }

      return originalQuery(text, values);
    };
    pools.push(pool);

    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const profileStore = new PostgresSubagentProfileStore({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await profileStore.ensureSchema();

    return {
      pool,
      agentStore,
      profileStore,
    };
  }

  it("seeds built-in profiles through the DB store idempotently", async () => {
    const {pool, profileStore} = await createStores();

    await profileStore.seedBuiltinProfiles();
    await profileStore.seedBuiltinProfiles();

    const profiles = await profileStore.listProfiles();
    expect(profiles.map((profile) => profile.slug)).toEqual([
      "browser",
      "memory",
      "skill_maintainer",
      "workspace",
    ]);
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slug: "workspace",
        source: "builtin",
        transcriptMode: "none",
        enabled: true,
        toolGroups: ["core", "workspace_read"],
        thinking: "low",
      }),
      expect.objectContaining({
        slug: "memory",
        toolGroups: ["core", "memory"],
        thinking: "medium",
      }),
      expect.objectContaining({
        slug: "browser",
        toolGroups: ["core", "workspace_read", "internet"],
      }),
      expect.objectContaining({
        slug: "skill_maintainer",
        toolGroups: ["core", "workspace_read", "memory"],
      }),
    ]));

    const tables = buildSubagentTableNames();
    const raw = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${tables.subagentProfiles}`);
    expect(raw.rows[0]).toMatchObject({count: BUILTIN_SUBAGENT_PROFILES.length});
  });

  it("supports agent-scoped custom profiles and filters disabled rows by default", async () => {
    const {agentStore, profileStore} = await createStores();
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });

    await profileStore.seedBuiltinProfiles();
    const custom = await profileStore.upsertProfile({
      slug: "reviewer",
      agentKey: "panda",
      description: "Review code changes and report concrete risks.",
      prompt: "Review the assigned patch.",
      toolGroups: ["core", "workspace_read"],
      model: "openai/gpt-5.1",
      thinking: "high",
      source: "custom",
      enabled: false,
    });

    expect(custom).toMatchObject({
      slug: "reviewer",
      agentKey: "panda",
      source: "custom",
      transcriptMode: "none",
      enabled: false,
      model: "openai/gpt-5.1",
      thinking: "high",
    });
    await expect(profileStore.getProfile({slug: "reviewer", agentKey: "panda"})).resolves.toBeNull();
    await expect(profileStore.getProfile({
      slug: "reviewer",
      agentKey: "panda",
      includeDisabled: true,
    })).resolves.toMatchObject({slug: "reviewer"});
    await expect(profileStore.listProfiles({agentKey: "panda"})).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({slug: "reviewer"})]),
    );
    await expect(profileStore.listProfiles({
      agentKey: "panda",
      includeDisabled: true,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({slug: "browser", source: "builtin"}),
      expect.objectContaining({slug: "reviewer", source: "custom"}),
    ]));
  });

  it("rejects profile shapes that smuggle raw tools, credentials, env ids, or future transcript behavior", async () => {
    const {agentStore, profileStore} = await createStores();
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await profileStore.seedBuiltinProfiles();

    const base = {
      slug: "bad",
      agentKey: "panda",
      description: "Bad profile.",
      prompt: "Do a thing.",
      toolGroups: ["core"],
      source: "custom" as const,
    };

    await expect(profileStore.upsertProfile({
      ...base,
      description: "x".repeat(256),
    })).rejects.toThrow("Subagent profile description must be at most 255 characters.");
    await expect(profileStore.upsertProfile({
      ...base,
      toolGroups: ["bash"],
    })).rejects.toThrow('Unknown subagent tool group "bash".');
    await expect(profileStore.upsertProfile({
      ...base,
      source: "legacy" as never,
    })).rejects.toThrow("Unsupported subagent profile source legacy.");
    await expect(profileStore.upsertProfile({
      ...base,
      thinking: "giant" as never,
    })).rejects.toThrow("Unsupported subagent profile thinking level giant.");
    await expect(profileStore.upsertProfile({
      ...base,
      transcriptMode: "summary" as never,
    })).rejects.toThrow("Unsupported subagent profile transcript mode summary.");
    await expect(profileStore.upsertProfile({
      ...base,
      credentialAllowlist: ["GH_TOKEN"],
    } as never)).rejects.toThrow("Subagent profiles must not store credentialAllowlist.");
    await expect(profileStore.upsertProfile({
      ...base,
      environmentId: "env-1",
    } as never)).rejects.toThrow("Subagent profiles must not store environmentId.");
    await expect(profileStore.upsertProfile({
      ...base,
      slug: "memory",
    })).rejects.toThrow("Custom subagent profile memory conflicts with a built-in profile slug.");
  });
});
