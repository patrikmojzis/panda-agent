import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresSubagentProfileStore} from "../../src/domain/subagents/postgres.js";
import type {UpsertSubagentProfileInput} from "../../src/domain/subagents/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;
const profile = {
  description: "Profile persistence fixture",
  prompt: "Use only the fixture tools.",
  toolGroups: ["core"],
};

describe("subagent profile scopes on PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let profiles: PostgresSubagentProfileStore;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/subagent-profiles-live-test",
      max: 4,
    });
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    const agents = new PostgresAgentStore({pool});
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await agents.bootstrapAgent({agentKey: "panda-other", displayName: "Other Panda"});
    profiles = new PostgresSubagentProfileStore({pool});
  });

  afterAll(async () => {
    await pool?.end();
  });

  liveIt.each([
    {source: "builtin" as const, slug: "global_refresh", agentKey: undefined},
    {source: "custom" as const, slug: "custom_refresh", agentKey: "panda"},
  ])("updates one $source profile through its partial unique index", async (scope) => {
    const first = await profiles.upsertProfile({
      ...profile, ...scope, model: "fixture/model", thinking: "high",
      createdByAgentKey: scope.agentKey,
    });
    const replacement = {
      ...profile, ...scope, description: "Updated description", prompt: "Updated prompt",
      toolGroups: ["core", "memory"], enabled: false,
    };
    const updated = await profiles.upsertProfile(replacement);
    expect(updated).toMatchObject({
      ...replacement, model: undefined, thinking: undefined, createdByAgentKey: undefined,
      transcriptMode: "none", createdAt: first.createdAt,
    });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(await profiles.getProfile(scope)).toBeNull();
    expect(await profiles.getProfile({...scope, includeDisabled: true})).toEqual(updated);
    const listed = await profiles.listProfiles({agentKey: scope.agentKey, includeDisabled: true});
    expect(listed.filter(({slug}) => slug === scope.slug)).toEqual([updated]);
  });

  liveIt("keeps the same custom slug independent across two agents", async () => {
    const input = {...profile, slug: "shared_custom", source: "custom" as const};
    const [first, second] = await Promise.all([
      profiles.upsertProfile({...input, agentKey: "panda", prompt: "First agent"}),
      profiles.upsertProfile({...input, agentKey: "panda-other", prompt: "Second agent"}),
    ]);
    expect(await profiles.getProfile({slug: input.slug, agentKey: "panda"})).toEqual(first);
    expect(await profiles.getProfile({slug: input.slug, agentKey: "panda-other"})).toEqual(second);
    expect(await profiles.getProfile({slug: input.slug})).toBeNull();
  });

  liveIt.each(["builtin", "custom"] as const)("preserves a reserved slug first created as %s", async (source) => {
    const slug = `reserved_${source}`;
    const first = await profiles.upsertProfile({
      ...profile, slug, source, agentKey: source === "custom" ? "panda" : undefined,
    });
    await expect(profiles.upsertProfile({
      ...profile, slug, source: source === "builtin" ? "custom" : "builtin",
      agentKey: source === "builtin" ? "panda" : undefined,
    })).rejects.toThrow(source === "builtin"
      ? `Custom subagent profile ${slug} conflicts with a reserved global profile slug.`
      : `Global subagent profile ${slug} conflicts with existing custom profiles; an operator migration is required before this built-in can be seeded.`);
    expect(await profiles.getProfile({slug, agentKey: "panda"})).toEqual(first);
    expect(await profiles.getProfile({slug, agentKey: "panda-other"})).toEqual(source === "builtin" ? first : null);
  });

  liveIt("accepts only one scope when global and custom creation race", async () => {
    const slug = "scope_race";
    const inputs: UpsertSubagentProfileInput[] = [
      {...profile, slug, source: "builtin"},
      {...profile, slug, source: "custom", agentKey: "panda"},
    ];
    const results = await Promise.allSettled(inputs.map((input) => profiles.upsertProfile(input)));
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(Error);
    expect(rejected[0]!.reason.message).toContain("conflicts with");
    const visible = await profiles.listProfiles({agentKey: "panda"});
    expect(visible.filter((row) => row.slug === slug)).toEqual([accepted[0]!.value]);
  });

  liveIt("rolls back a failed insert and permits a later valid upsert", async () => {
    const input = {...profile, slug: "retry_after_failure", source: "custom" as const, agentKey: "panda"};
    await expect(profiles.upsertProfile({...input, createdByAgentKey: "missing-agent"}))
      .rejects.toMatchObject({code: "23503"});
    expect(await profiles.getProfile(input)).toBeNull();
    const saved = await profiles.upsertProfile(input);
    expect(await profiles.getProfile(input)).toEqual(saved);
  });
});
