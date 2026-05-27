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
      // pg-mem corrupts queries after partial unique indexes on nullable columns and does not
      // parse partial-index ON CONFLICT targets. Production Postgres uses both paths.
      if (
        text.includes("subagent_profiles_global_slug_idx")
        || text.includes("subagent_profiles_agent_slug_idx")
      ) {
        return {rows: []};
      }
      const emulated = await emulatePartialUpsert(originalQuery, text, values);
      if (emulated) {
        return emulated;
      }

      return originalQuery(text, values);
    };
    const originalConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await originalConnect();
      const originalClientQuery = client.query.bind(client);
      client.query = async (text: string, values?: readonly unknown[]) => {
        const emulated = await emulatePartialUpsert(originalClientQuery, text, values);
        if (emulated) {
          return emulated;
        }
        return originalClientQuery(text, values);
      };
      return client;
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
    await Promise.all([
      profileStore.seedBuiltinProfiles(),
      profileStore.seedBuiltinProfiles(),
    ]);

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
        toolGroups: ["core", "workspace_read", "memory", "skill_maintenance"],
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


  it("reserves global slugs and keeps lookup deterministic when legacy collisions exist", async () => {
    const {agentStore, pool, profileStore} = await createStores();
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });

    await profileStore.upsertProfile({
      slug: "future_builtin",
      agentKey: "panda",
      description: "Custom profile before a future built-in.",
      prompt: "Do custom work.",
      toolGroups: ["core"],
      source: "custom",
    });
    await expect(profileStore.upsertProfile({
      slug: "future_builtin",
      description: "Future built-in.",
      prompt: "Do built-in work.",
      toolGroups: ["core"],
      source: "builtin",
    })).rejects.toThrow(
      "Global subagent profile future_builtin conflicts with existing custom profiles; an operator migration is required",
    );

    const tables = buildSubagentTableNames();
    await pool.query(`
      INSERT INTO ${tables.subagentProfiles} (
        slug,
        agent_key,
        description,
        prompt,
        tool_groups,
        transcript_mode,
        source,
        enabled
      ) VALUES
        ('legacy_collision', 'panda', 'Custom collision.', 'Custom prompt.', '["core"]'::jsonb, 'none', 'custom', TRUE),
        ('legacy_collision', NULL, 'Global collision.', 'Global prompt.', '["core"]'::jsonb, 'none', 'builtin', TRUE)
    `);

    await expect(profileStore.getProfile({
      slug: "legacy_collision",
      agentKey: "panda",
    })).resolves.toMatchObject({
      slug: "legacy_collision",
      source: "builtin",
      prompt: "Global prompt.",
    });
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
    })).rejects.toThrow("Custom subagent profile memory conflicts with a reserved global profile slug.");
  });
});
