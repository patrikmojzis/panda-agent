import {afterEach, describe, expect, it} from "vitest";
import {newDb} from "pg-mem";

import {
  installPreLedgerLiveVoiceSchema,
  migratePreLedgerDiscordVoiceSchema,
} from "../src/app/database/migrations/pre-ledger/live-voice.js";
import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {ensurePostgresAgentTableSchema} from "../src/domain/agents/postgres-schema.js";
import {ensurePostgresIdentitySchema} from "../src/domain/identity/postgres-schema.js";
import {LiveVoiceRepo} from "../src/domain/live-voice/repo.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";
import {ensurePostgresSessionSchema} from "../src/domain/sessions/postgres-schema.js";

const liveVoiceSessionId = "22222222-2222-4222-8222-222222222222";

describe("LiveVoiceRepo", () => {
  const pools: Array<{end(): Promise<void>}> = [];
  afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

  function createRepo() {
    const db = newDb({noAstCoverageCheck: true});
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    return {pool, repo: new LiveVoiceRepo({pool})};
  }

  async function installSessionOwner(pool: ReturnType<typeof createRepo>["pool"]) {
    await ensurePostgresIdentitySchema(pool);
    await ensurePostgresAgentTableSchema(pool);
    await ensurePostgresSessionSchema(pool);
    await new PostgresAgentStore({pool}).bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await new PostgresSessionStore({pool}).createSessionRecord({
      id: "session-1",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-1",
    });
  }

  async function createSession(repo: LiveVoiceRepo) {
    return repo.upsertSession({id: liveVoiceSessionId, source: "discord", connectorKey: "bot-1", scopeKey: "guild-1", roomKey: "12345", sessionId: "session-1", agentKey: "panda", provider: "openai-live", model: "gpt-live-1-codex", state: "connected", transportContext: {guildId: "guild-1", channelId: "12345"}});
  }

  it("owns channel-neutral session health and exact-once delegated turns", async () => {
    const {pool, repo} = createRepo();
    await installSessionOwner(pool);
    await installPreLedgerLiveVoiceSchema(pool);
    await createSession(repo);
    await repo.updateSessionHealth({id: liveVoiceSessionId, health: "ready", reasons: [], observedAt: 1, diagnostics: {version: 1, transport: {voice: {state: "ready"}}}});
    await expect(repo.listSessions({source: "discord", sessionId: "session-1", activeOnly: true})).resolves.toEqual([
      expect.objectContaining({id: liveVoiceSessionId, scopeKey: "guild-1", roomKey: "12345", health: "ready", diagnostics: expect.objectContaining({transport: expect.any(Object)})}),
    ]);

    const base = {liveVoiceSessionId, sourceUtteranceId: "33333333-3333-4333-8333-333333333333", sessionId: "session-1", agentKey: "panda", externalActorId: "user-1", prompt: "check status"};
    const created = await repo.createOrGetTurn({id: "44444444-4444-4444-8444-444444444444", providerDelegationId: "delegation-1", ...base});
    const duplicate = await repo.createOrGetTurn({id: "55555555-5555-4555-8555-555555555555", providerDelegationId: "delegation-2", ...base});
    expect(duplicate).toMatchObject({created: false, turn: {id: created.turn.id}});
    await repo.markTurnQueued(created.turn.id, "66666666-6666-4666-8666-666666666666");
    await repo.assignTurnsToRun([created.turn.id], "77777777-7777-4777-8777-777777777777");
    expect(await repo.listRunningTurns("77777777-7777-4777-8777-777777777777")).toHaveLength(1);
    expect(await repo.reserveFinalDelivery(created.turn.id, "88888888-8888-4888-8888-888888888888", "Healthy.")).toMatchObject({reserved: true});
    expect(await repo.reserveFinalDelivery(created.turn.id, "99999999-9999-4999-8999-999999999999", "Duplicate.")).toMatchObject({reserved: false});
    expect(await repo.completeReservedFinal(created.turn.id, "88888888-8888-4888-8888-888888888888")).toMatchObject({status: "completed", resultText: "Healthy."});
  });

  it("fails only active turns owned by one source and connector", async () => {
    const {pool, repo} = createRepo();
    await installSessionOwner(pool);
    await installPreLedgerLiveVoiceSchema(pool);
    await createSession(repo);
    const first = (await repo.createOrGetTurn({id: "11111111-1111-4111-8111-111111111111", liveVoiceSessionId, providerDelegationId: "one", sourceUtteranceId: "31111111-1111-4111-8111-111111111111", sessionId: "session-1", agentKey: "panda", prompt: "one"})).turn;
    const second = (await repo.createOrGetTurn({id: "21111111-1111-4111-8111-111111111111", liveVoiceSessionId, providerDelegationId: "two", sourceUtteranceId: "41111111-1111-4111-8111-111111111111", sessionId: "session-1", agentKey: "panda", prompt: "two"})).turn;
    await repo.completeTurn(second.id, "done");
    expect(await repo.failConnectorActiveTurns("discord", "bot-1", "worker restarted")).toBe(1);
    await expect(repo.getTurn(first.id)).resolves.toMatchObject({status: "failed", error: "worker restarted"});
    await expect(repo.getTurn(second.id)).resolves.toMatchObject({status: "completed", resultText: "done"});
  });

  it("rejects new live voice work after the durable session is archived", async () => {
    const {pool, repo} = createRepo();
    await installSessionOwner(pool);
    await installPreLedgerLiveVoiceSchema(pool);
    await createSession(repo);
    await pool.query(`UPDATE "runtime"."agent_sessions" SET archived_at = NOW() WHERE id = 'session-1'`);

    await expect(createSession(repo)).rejects.toThrow("Session session-1 is archived.");
    await expect(repo.createOrGetTurn({
      id: "11111111-1111-4111-8111-111111111111",
      liveVoiceSessionId,
      providerDelegationId: "archived",
      sourceUtteranceId: "31111111-1111-4111-8111-111111111111",
      sessionId: "session-1",
      agentKey: "panda",
      prompt: "must not run",
    })).rejects.toThrow("Session session-1 is archived.");
  });

  it("hard-cuts legacy Discord rows into generic sessions and turns", async () => {
    const {pool, repo} = createRepo();
    await pool.query("CREATE SCHEMA runtime");
    await pool.query(`
      CREATE TABLE runtime.discord_voice_turns (
        id UUID PRIMARY KEY, voice_session_id UUID NOT NULL, delegation_id TEXT NOT NULL,
        connector_key TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        session_id TEXT NOT NULL, agent_key TEXT NOT NULL, external_actor_id TEXT, identity_id TEXT,
        prompt TEXT NOT NULL, status TEXT NOT NULL, thread_id UUID, run_id UUID,
        result_text TEXT, error TEXT, completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query("CREATE TABLE runtime.runtime_requests (id UUID PRIMARY KEY, kind TEXT NOT NULL)");
    await pool.query("INSERT INTO runtime.runtime_requests (id,kind) VALUES ('99999999-9999-4999-8999-999999999999','discord_voice_delegation')");
    await pool.query(`INSERT INTO runtime.discord_voice_turns (id,voice_session_id,delegation_id,connector_key,guild_id,channel_id,session_id,agent_key,prompt,status) VALUES ('11111111-1111-4111-8111-111111111111',$1,'legacy-delegation','bot-1','guild-1','12345','session-1','panda','legacy task','running')`, [liveVoiceSessionId]);
    await installPreLedgerLiveVoiceSchema(pool);
    await migratePreLedgerDiscordVoiceSchema(pool);
    await expect(repo.getSession(liveVoiceSessionId)).resolves.toMatchObject({source: "discord", scopeKey: "guild-1", roomKey: "12345", state: "disconnected"});
    await expect(repo.getTurn("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({providerDelegationId: "legacy-delegation:11111111-1111-4111-8111-111111111111", status: "failed", error: "Live voice turn interrupted by schema migration."});
    const legacy = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='runtime' AND table_name='discord_voice_turns'");
    expect(legacy.rows).toEqual([]);
    const oldRequests = await pool.query("SELECT * FROM runtime.runtime_requests WHERE kind='discord_voice_delegation'");
    expect(oldRequests.rows).toEqual([]);
  });
});
