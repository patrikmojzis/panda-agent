import {randomUUID} from "node:crypto";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresConnectorAccountStore} from "../../src/domain/connectors/postgres.js";
import {PostgresControlAuthService} from "../../src/domain/control/auth.js";
import {ControlOperatorService} from "../../src/domain/control/operator-service.js";
import {ControlReadService} from "../../src/domain/control/read-service.js";
import type {ControlSessionRecord} from "../../src/domain/control/types.js";
import {PostgresIdentityStore} from "../../src/domain/identity/postgres.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import type {PgPoolLike} from "../../src/lib/postgres-query.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;
const epoch = Date.parse("2040-01-01T00:00:00.000Z");
const whatsappKey = "11111111-1111-4111-8111-111111111111";
const identityIds = ["reader", "z-first", "a-second", "soft-deleted", "bad-group", "unpaired"];

describe("Control actor pairing lists with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let agents: PostgresAgentStore;
  let identities: PostgresIdentityStore;
  let operator: ControlOperatorService;
  let admin: ControlSessionRecord;
  let scoped: ControlSessionRecord;
  const queries: string[] = [];
  let afterQuery: ((sql: string) => Promise<void>) | undefined;

  async function binding(identityId: string, source: string, connectorKey: string, actor: string, order = 1): Promise<void> {
    await pool.query(`INSERT INTO runtime.identity_bindings
      (id, identity_id, source, connector_key, external_actor_id, metadata, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, '{"private":"ACTOR_METADATA_SENTINEL"}', $6, $7)`,
    [randomUUID(), identityId, source, connectorKey, actor, new Date(epoch + order * 1000), new Date(epoch)]);
  }

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({connectionString: target.connectionString, applicationName: "panda/control-actor-pairings-test", max: 4});
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    const measured: PgPoolLike = {
      async query(sql, values) {
        queries.push(sql);
        const result = await pool.query(sql, values);
        await afterQuery?.(sql);
        return result;
      },
      connect: () => pool.connect(),
    };
    agents = new PostgresAgentStore({pool: measured});
    identities = new PostgresIdentityStore({pool: measured});
    const connectors = new PostgresConnectorAccountStore({pool: measured});
    const auth = new PostgresControlAuthService({pool: measured});
    for (const agentKey of ["panda", "foreign", "empty"]) await agents.bootstrapAgent({agentKey, displayName: agentKey});
    for (const [index, id] of identityIds.entries()) {
      await identities.createIdentity({id, handle: id, displayName: id, status: id === "soft-deleted" ? "deleted" : "active"});
      await pool.query("UPDATE runtime.identities SET created_at = $2 WHERE id = $1", [id, new Date(epoch + index * 1000)]);
    }
    for (const [index, id] of ["reader", "a-second", "z-first", "soft-deleted", "bad-group"].entries()) {
      await agents.ensurePairing("panda", id);
      await pool.query("UPDATE runtime.agent_pairings SET created_at = $2 WHERE agent_key = 'panda' AND identity_id = $1", [id, new Date(epoch + index * 1000)]);
    }
    admin = (await auth.loginWithToken((await auth.createGrant({identityId: "reader", role: "admin"})).loginToken)).session;
    scoped = (await auth.loginWithToken((await auth.createGrant({identityId: "reader", role: "scoped", agentKey: "panda"})).loginToken)).session;
    for (const [source, connectorKey] of [["discord", "discord-owned"], ["telegram", "telegram-owned"], ["whatsapp", whatsappKey]]) {
      await connectors.upsertAccount({source: source!, accountKey: `${source}-owned`, connectorKey: connectorKey!, ownerKind: "agent", ownerAgentKey: "panda", status: "disabled"});
      await connectors.upsertAccount({source: source!, accountKey: `${source}-foreign`, connectorKey: `${connectorKey}-foreign`, ownerKind: "agent", ownerAgentKey: "foreign"});
    }
    for (const [id, suffix] of [["z-first", "1"], ["a-second", "3"], ["soft-deleted", "4"], ["unpaired", "5"], ["bad-group", "bad"]]) {
      await binding(id!, " discord ", " discord-owned ", ` D${suffix} `);
      await binding(id!, " telegram ", " telegram-owned ", ` T${suffix} `);
      await binding(id!, " whatsapp ", ` ${whatsappKey} `, ` W${suffix} `, 3);
    }
    await binding("z-first", "discord", "discord-owned", "D2", 2);
    await binding("z-first", "telegram", "telegram-owned", "T2", 2);
    await binding("z-first", "discord", "discord-owned-foreign", "FOREIGN_DISCORD");
    await binding("z-first", "telegram", "telegram-owned-foreign", "FOREIGN_TELEGRAM");
    await binding("bad-group", "email", "unrelated", "   ");
    const unused = undefined as never;
    operator = new ControlOperatorService({
      pool: measured, reads: new ControlReadService({pool: measured}), agents, identities, connectorAccounts: connectors,
      liveVoice: {provider: "openai-live", model: "fixture", sourceVersion: "test", defaultVoice: "cove", voices: ["cove"]},
      a2aBindings: unused, sessions: unused, executionEnvironments: unused, credentials: null, email: unused,
      connectorCrypto: null, conversations: unused, gateway: unused, subagents: unused, wikiBindings: unused,
      env: {}, fetchImpl: async () => { throw new Error("Actor fixture must not access the network."); },
    });
  });

  beforeEach(() => { queries.length = 0; afterQuery = undefined; });
  afterAll(async () => { await pool?.end(); });

  liveIt.each(["admin", "scoped"] as const)("preserves %s Discord identity and binding order with normalized keys and opaque actors", async (role) => {
    const result = await operator.listDiscordActorPairings(role === "admin" ? admin : scoped, "panda");
    expect(result.data.map((row) => row.externalActorId)).toEqual([" D1 ", "D2", " D3 ", " D4 ", " D5 "]);
    expect(result.data.map((row) => row.identityId)).toEqual(["z-first", "z-first", "a-second", "soft-deleted", "unpaired"]);
    expect(result.data[3]!.identityStatus).toBe("deleted");
    expect(result.data.every((row) => row.connectorKey === "discord-owned" && row.accountKey === "discord-owned")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("ACTOR_METADATA_SENTINEL");
    expect(queries).toHaveLength(5);
  });

  liveIt.each(["telegram", "whatsapp"] as const)("uses agent-pairing order and excludes unpaired/foreign/malformed %s groups", async (source) => {
    const result = await operator.listChannelActorPairings(scoped, "panda", {source});
    expect(result.data.map((row) => row.externalActorId)).toEqual(source === "telegram" ? [" T3 ", " T1 ", "T2", " T4 "] : [" W3 ", " W1 ", " W4 "]);
    expect(result.data.at(-1)!.identityStatus).toBe("deleted");
    expect(JSON.stringify(result)).not.toContain("ACTOR_METADATA_SENTINEL");
    expect(queries).toHaveLength(5);
  });

  liveIt("filters before paging and keeps high pages empty with full totals", async () => {
    const discord = await operator.listDiscordActorPairings(admin, "panda", {accountKey: "discord-owned", page: 2, perPage: 1});
    expect(discord.data.map((row) => row.externalActorId)).toEqual(["D2"]);
    expect(discord.meta).toEqual({current_page: 2, last_page: 5, total: 5, per_page: 1});
    const channel = await operator.listChannelActorPairings(scoped, "panda", {source: "telegram", connectorKey: " telegram-owned ", search: " z-FIRST ", page: 2, perPage: 1});
    expect(channel.data.map((row) => row.externalActorId)).toEqual(["T2"]);
    expect(channel.meta).toEqual({current_page: 2, last_page: 2, total: 2, per_page: 1});
    await expect(operator.listChannelActorPairings(scoped, "panda", {source: "telegram", page: 99, perPage: 1})).resolves.toMatchObject({data: [], meta: {current_page: 99, total: 4}});
    await expect(operator.listDiscordActorPairings(admin, "panda", {accountKey: "discord-foreign"})).resolves.toMatchObject({data: [], meta: {total: 0}});
  });

  liveIt("keeps reads constant as the identity inventory grows", async () => {
    const extraIds = Array.from({length: 12}, (_, index) => `extra-${index}`);
    try {
      for (const id of extraIds) {
        await identities.createIdentity({id, handle: id, displayName: id});
        await agents.ensurePairing("panda", id);
        await binding(id, "discord", "discord-owned", id);
        await binding(id, "telegram", "telegram-owned", id);
      }
      queries.length = 0;
      expect((await operator.listDiscordActorPairings(admin, "panda")).meta.total).toBe(17);
      expect(queries).toHaveLength(5);
      queries.length = 0;
      expect((await operator.listChannelActorPairings(scoped, "panda", {source: "telegram"})).meta.total).toBe(16);
      expect(queries).toHaveLength(5);
    } finally {
      await pool.query("DELETE FROM runtime.identities WHERE id = ANY($1::text[])", [extraIds]);
    }
  });

  liveIt("omits a missing identity after pairing selection without losing valid groups", async () => {
    await identities.createIdentity({id: "vanishing", handle: "vanishing", displayName: "Vanishing"});
    await agents.ensurePairing("panda", "vanishing");
    await binding("vanishing", "telegram", "telegram-owned", "VANISHING");
    let removed = false;
    afterQuery = async (sql) => {
      if (!removed && /FROM\s+"runtime"\."agent_pairings"/.test(sql)) {
        removed = true;
        await pool.query("DELETE FROM runtime.identities WHERE id = 'vanishing'");
      }
    };
    try {
      const result = await operator.listChannelActorPairings(scoped, "panda", {source: "telegram"});
      expect(removed).toBe(true);
      expect(result.data.map((row) => row.externalActorId)).toEqual([" T3 ", " T1 ", "T2", " T4 "]);
    } finally {
      afterQuery = undefined;
      await pool.query("DELETE FROM runtime.identities WHERE id = 'vanishing'");
    }
  });

  liveIt("omits malformed identities per channel group and preserves authorization before reads", async () => {
    try {
      await pool.query("UPDATE runtime.identities SET status = 'invalid' WHERE id = 'a-second'");
      expect((await operator.listChannelActorPairings(scoped, "panda", {source: "telegram"})).data.map((row) => row.externalActorId)).toEqual([" T1 ", "T2", " T4 "]);
    } finally {
      await pool.query("UPDATE runtime.identities SET status = 'active' WHERE id = 'a-second'");
    }
    try {
      await agents.deletePairing("panda", "reader");
      queries.length = 0;
      await expect(operator.listDiscordActorPairings(scoped, "panda")).rejects.toThrow("Control target agent was not found or is not visible.");
      expect(queries).toHaveLength(1);
      queries.length = 0;
      await expect(operator.listChannelActorPairings(scoped, "panda")).rejects.toThrow("Control target agent was not found or is not visible.");
      expect(queries).toHaveLength(1);
    } finally {
      await agents.ensurePairing("panda", "reader");
    }
    queries.length = 0;
    await expect(operator.listDiscordActorPairings(admin, "empty")).resolves.toMatchObject({data: [], meta: {total: 0}});
    expect(queries).toHaveLength(2);
    queries.length = 0;
    await expect(operator.listChannelActorPairings(admin, "empty")).resolves.toMatchObject({data: [], meta: {total: 0}});
    expect(queries).toHaveLength(3);
  });
});
