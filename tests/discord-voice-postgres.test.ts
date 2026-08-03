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

    await store.upsertSession({connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", voiceSessionId: "22222222-2222-2222-2222-222222222222", state: "connected", model: "gpt-live-1-codex"});
    await expect(store.listSessions({sessionId: "session-1", activeOnly: true})).resolves.toHaveLength(1);

    const turn = await store.createTurn({id: "11111111-1111-1111-1111-111111111111", voiceSessionId: "22222222-2222-2222-2222-222222222222", delegationId: "delegation-1", connectorKey: "bot-1", guildId: "guild-1", channelId: "12345", sessionId: "session-1", agentKey: "panda", prompt: "check status"});
    expect(await store.markTurnQueued(turn.id, "33333333-3333-3333-3333-333333333333")).toMatchObject({status: "queued"});
    await store.assignTurnsToRun([turn.id], "44444444-4444-4444-4444-444444444444");
    expect(await store.getTurn(turn.id)).toMatchObject({status: "running", runId: "44444444-4444-4444-4444-444444444444"});
    expect(await store.listRunningTurns("44444444-4444-4444-4444-444444444444")).toHaveLength(1);
    expect(await store.completeTurn(turn.id, "All healthy.")).toMatchObject({status: "completed", resultText: "All healthy."});
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
});
