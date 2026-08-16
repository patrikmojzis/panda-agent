import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DiscordVoiceControlRepo} from "../src/integrations/channels/discord/voice-postgres.js";

describe("DiscordVoiceControlRepo", () => {
  const pools: Array<{end(): Promise<void>}> = [];
  afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

  function createRepo() {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({name: "pg_notify", args: [DataType.text, DataType.text], returns: DataType.text, implementation: () => ""});
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    return {pool, repo: new DiscordVoiceControlRepo({pool})};
  }

  it("coordinates, deduplicates, and preserves terminal controls", async () => {
    const {repo} = createRepo();
    await repo.ensureSchema();
    const input = {connectorKey: "bot-1", operation: "send" as const, sessionId: "session-1", agentKey: "panda", channelId: "12345", text: "Working.", mode: "progress" as const, idempotencyKey: "tool-call-1"};
    const control = await repo.enqueueControl(input);
    expect((await repo.enqueueControl(input)).id).toBe(control.id);
    expect(await repo.claimNextControl("bot-1")).toMatchObject({id: control.id, status: "running"});
    expect(await repo.completeControl(control.id, {ok: true})).toMatchObject({status: "completed", result: {ok: true}});
    expect(await repo.failControl(control.id, "late failure")).toMatchObject({status: "completed", error: undefined});
  });

  it("observes a terminal control without pinning a LISTEN client", async () => {
    const {repo} = createRepo();
    await repo.ensureSchema();
    const control = await repo.enqueueControl({connectorKey: "bot-1", operation: "join", sessionId: "session-1", agentKey: "panda", channelId: "12345"});
    const waiter = repo.waitForControl(control.id, {timeoutMs: 2_000});
    await repo.claimNextControl("bot-1");
    await repo.completeControl(control.id, {ok: true});
    await expect(waiter).resolves.toMatchObject({status: "completed"});
  });
});
