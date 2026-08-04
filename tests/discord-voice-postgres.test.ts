import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DiscordVoiceStore} from "../src/integrations/channels/discord/voice-postgres.js";

describe("DiscordVoiceStore", () => {
  const pools: Array<{end(): Promise<void>}> = [];
  afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

  it("persists control ownership, observable sessions, and delegated turn mailboxes", async () => {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const store = new DiscordVoiceStore({pool});
    await store.ensureSchema();

    const control = await store.enqueueControl({connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345"});
    expect(await store.claimNextControl("bot-1")).toMatchObject({id: control.id, status: "running"});
    expect(await store.completeControl(control.id, {ok: true, state: "connected"})).toMatchObject({status: "completed", result: {ok: true, state: "connected"}});

    const send = await store.enqueueControl({connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Still checking.", mode: "progress", voiceTurnId: "11111111-1111-4111-8111-111111111111"});
    expect(await store.claimNextControl("bot-1")).toMatchObject({id: send.id, operation: "send", text: "Still checking.", mode: "progress", voiceTurnId: "11111111-1111-4111-8111-111111111111"});
    await store.completeControl(send.id, {ok: true, state: "sent"});

    await store.upsertSession({connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", voiceSessionId: "22222222-2222-2222-2222-222222222222", state: "connected", model: "gpt-live-1-codex"});
    await expect(store.listSessions({sessionId: "session-1", activeOnly: true})).resolves.toHaveLength(1);

    const {turn} = await store.createOrGetTurn({id: "11111111-1111-1111-1111-111111111111", voiceSessionId: "22222222-2222-2222-2222-222222222222", delegationId: "delegation-1", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", sourceUtteranceId: "55555555-5555-4555-8555-555555555555", prompt: "check status"});
    expect(await store.markTurnQueued(turn.id, "33333333-3333-3333-3333-333333333333")).toMatchObject({status: "queued"});
    await store.assignTurnsToRun([turn.id], "44444444-4444-4444-4444-444444444444");
    expect(await store.getTurn(turn.id)).toMatchObject({status: "running", runId: "44444444-4444-4444-4444-444444444444"});
    expect(await store.listRunningTurns("44444444-4444-4444-4444-444444444444")).toHaveLength(1);
    expect(await store.reserveFinalDelivery(turn.id, "66666666-6666-4666-8666-666666666666", "All healthy.")).toMatchObject({reserved: true, turn: {status: "final_sending"}});
    expect(await store.completeReservedFinal(turn.id, "66666666-6666-4666-8666-666666666666")).toMatchObject({status: "completed", resultText: "All healthy."});
  });

  it("does not overwrite a terminal control during timeout/completion races", async () => {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const store = new DiscordVoiceStore({pool});
    await store.ensureSchema();

    const timedOut = await store.enqueueControl({connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345"});
    await store.claimNextControl("bot-1");
    expect(await store.failControl(timedOut.id, "timeout")).toMatchObject({status: "failed"});
    expect(await store.completeControl(timedOut.id, {ok: true})).toMatchObject({status: "failed", result: undefined});

    const completed = await store.enqueueControl({connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345"});
    await store.claimNextControl("bot-1");
    expect(await store.completeControl(completed.id, {ok: true})).toMatchObject({status: "completed"});
    expect(await store.failControl(completed.id, "late failure")).toMatchObject({status: "completed"});
  });

  it("deduplicates controls and utterance turns and reserves final speech at most once", async () => {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const store = new DiscordVoiceStore({pool});
    await store.ensureSchema();

    const firstControl = await store.enqueueControl({connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Working.", mode: "progress", idempotencyKey: "stable-tool-call"});
    const duplicateControl = await store.enqueueControl({connectorKey: "bot-1", operation: "send", sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Working.", mode: "progress", idempotencyKey: "stable-tool-call"});
    expect(duplicateControl.id).toBe(firstControl.id);

    const base = {voiceSessionId: "22222222-2222-4222-8222-222222222222", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", externalActorId: "user-1", sourceUtteranceId: "33333333-3333-4333-8333-333333333333", prompt: "check status"};
    const created = await store.createOrGetTurn({id: "44444444-4444-4444-8444-444444444444", delegationId: "delegation-1", ...base});
    const duplicate = await store.createOrGetTurn({id: "55555555-5555-4555-8555-555555555555", delegationId: "delegation-2", ...base});
    expect(created.created).toBe(true);
    expect(duplicate).toMatchObject({created: false, turn: {id: created.turn.id, externalActorId: "user-1"}});

    expect(await store.reserveFinalDelivery(created.turn.id, "66666666-6666-4666-8666-666666666666", "Healthy.")).toMatchObject({reserved: true});
    expect(await store.reserveFinalDelivery(created.turn.id, "77777777-7777-4777-8777-777777777777", "Duplicate.")).toMatchObject({reserved: false, turn: {status: "final_sending"}});
    expect(await store.completeReservedFinal(created.turn.id, "66666666-6666-4666-8666-666666666666")).toMatchObject({status: "completed", resultText: "Healthy."});
    expect(await store.failTurn(created.turn.id, "late failure")).toMatchObject({status: "completed", error: undefined});
  });

  it("observes terminal controls by polling without pinning a LISTEN client", async () => {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const store = new DiscordVoiceStore({pool});
    await store.ensureSchema();
    const control = await store.enqueueControl({connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345"});
    const waiter = store.waitForControl(control.id, {timeoutMs: 2_000});
    await store.claimNextControl("bot-1");
    await store.completeControl(control.id, {ok: true});
    await expect(waiter).resolves.toMatchObject({status: "completed", result: {ok: true}});
  });

  it("fails only active turns when a connector worker restarts", async () => {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const store = new DiscordVoiceStore({pool});
    await store.ensureSchema();

    const turns = await Promise.all(Array.from({length: 7}, async (_, index) => (await store.createOrGetTurn({
      id: `0000000${String(index + 1)}-0000-4000-8000-00000000000${String(index + 1)}`,
      voiceSessionId: "22222222-2222-4222-8222-222222222222",
      delegationId: `delegation-${String(index + 1)}`,
      connectorKey: "bot-1",
      guildId: "guild-1",
      channelId: "12345",
      sessionId: "session-1",
      agentKey: "panda",
      sourceUtteranceId: `1000000${String(index + 1)}-0000-4000-8000-00000000000${String(index + 1)}`,
      prompt: `turn ${String(index + 1)}`,
    })).turn));
    await store.markTurnQueued(turns[1]!.id, "21000001-0000-4000-8000-000000000001");
    await store.markTurnQueued(turns[2]!.id, "21000002-0000-4000-8000-000000000002");
    await store.assignTurnsToRun([turns[2]!.id], "22000002-0000-4000-8000-000000000002");
    await store.markTurnQueued(turns[3]!.id, "21000003-0000-4000-8000-000000000003");
    await store.assignTurnsToRun([turns[3]!.id], "22000003-0000-4000-8000-000000000003");
    await store.markTurnsAwaitingFinal("22000003-0000-4000-8000-000000000003");
    await store.reserveFinalDelivery(turns[4]!.id, "33333333-3333-4333-8333-333333333333", "final");
    await store.completeTurn(turns[5]!.id, "done");
    await store.failTurn(turns[6]!.id, "already failed");

    expect(await store.failConnectorActiveTurns("bot-1", "worker restarted")).toBe(5);
    for (const turn of turns.slice(0, 5)) await expect(store.getTurn(turn.id)).resolves.toMatchObject({status: "failed", error: "worker restarted"});
    await expect(store.getTurn(turns[5]!.id)).resolves.toMatchObject({status: "completed", resultText: "done"});
    await expect(store.getTurn(turns[6]!.id)).resolves.toMatchObject({status: "failed", error: "already failed"});
  });

  it("upgrades historical duplicate delegations without blocking startup", async () => {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
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
    const legacyValues = [
      "00000001-0000-4000-8000-000000000001",
      "00000002-0000-4000-8000-000000000002",
    ];
    for (const id of legacyValues) {
      await pool.query(`INSERT INTO runtime.discord_voice_turns (id,voice_session_id,delegation_id,connector_key,guild_id,channel_id,session_id,agent_key,prompt,status) VALUES ($1,$2,'duplicate','bot-1','guild-1','12345','session-1','panda','legacy','completed')`, [id, "22222222-2222-4222-8222-222222222222"]);
    }

    const store = new DiscordVoiceStore({pool});
    await expect(store.ensureSchema()).resolves.toBeUndefined();
    const legacy = await pool.query("SELECT source_utterance_id FROM runtime.discord_voice_turns WHERE delegation_id='duplicate'");
    expect(legacy.rows).toHaveLength(2);
    expect(legacy.rows.every((row) => row.source_utterance_id === null)).toBe(true);
  });
});
