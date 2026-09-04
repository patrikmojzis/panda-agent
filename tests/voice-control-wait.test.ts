import {describe, expect, it, vi} from "vitest";

import {LiveVoiceRepo} from "../src/domain/live-voice/repo.js";
import {LiveVoiceTurnNotFoundError} from "../src/domain/live-voice/types.js";
import {DiscordVoiceControlRepo} from "../src/integrations/channels/discord/voice-postgres.js";
import {WhatsAppCallControlRepo} from "../src/integrations/channels/whatsapp/calls/postgres.js";
import {VoiceControlWaitTimeoutError} from "../src/integrations/voice/control-errors.js";
import type {PgListenClient, PgPoolLike} from "../src/lib/postgres-query.js";

function controlPool(status = "pending") {
  const query = vi.fn(async () => ({rows: [{
    id: "control-1", connector_key: "connector-1", operation: "send", session_id: "session-1", agent_key: "panda",
    channel_id: "12345", call_id: "call-1", text: "Done.", mode: "final", status,
    result: status === "completed" ? {ok: true} : null,
    created_at: new Date(1), updated_at: new Date(1),
  }]}));
  const pool: PgPoolLike<PgListenClient> = {
    query,
    async connect() { throw new Error("A control waiter must not reserve a connection."); },
  };
  return {pool, query};
}

describe.each([
  {source: "Discord", create: (pool: PgPoolLike<PgListenClient>) => new DiscordVoiceControlRepo({pool})},
  {source: "WhatsApp", create: (pool: PgPoolLike<PgListenClient>) => new WhatsAppCallControlRepo(pool)},
])("$source durable control waiter", ({create}) => {
  it("reports a local deadline while leaving the durable control pending", async () => {
    const {pool} = controlPool();
    const repo = create(pool);
    await expect(repo.waitForControl("control-1", {timeoutMs: 0})).rejects.toBeInstanceOf(VoiceControlWaitTimeoutError);
    await expect(repo.getControl("control-1")).resolves.toMatchObject({status: "pending"});
  });

  it("returns an already completed control even at the local deadline", async () => {
    const {pool} = controlPool("completed");
    await expect(create(pool).waitForControl("control-1", {timeoutMs: 0})).resolves.toMatchObject({status: "completed", result: {ok: true}});
  });

  it("preserves a database failure rather than turning it into a deadline", async () => {
    const {pool, query} = controlPool();
    const cause = new Error("database connection unavailable");
    query.mockRejectedValueOnce(cause);
    await expect(create(pool).waitForControl("control-1", {timeoutMs: 0})).rejects.toBe(cause);
  });

  it("preserves the exact caller cancellation reason", async () => {
    const {pool} = controlPool();
    const controller = new AbortController();
    controller.abort("caller cancelled");
    await expect(create(pool).waitForControl("control-1", {signal: controller.signal})).rejects.toBe(controller.signal.reason);
  });

  it("preserves cancellation that arrives during a pending wait", async () => {
    vi.useFakeTimers();
    try {
      const {pool} = controlPool();
      const controller = new AbortController();
      const result = create(pool).waitForControl("control-1", {signal: controller.signal})
        .then(() => "unexpected completion", (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort("cancel while waiting");
      await vi.advanceTimersByTimeAsync(250);
      expect(await result).toBe(controller.signal.reason);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LiveVoiceRepo turn reads", () => {
  it("distinguishes a missing row from an unavailable database", async () => {
    const {pool, query} = controlPool();
    query.mockResolvedValueOnce({rows: []});
    const repo = new LiveVoiceRepo({pool});
    await expect(repo.getTurn("missing-turn")).rejects.toBeInstanceOf(LiveVoiceTurnNotFoundError);
    const cause = new Error("database connection unavailable");
    query.mockRejectedValueOnce(cause);
    await expect(repo.getTurn("missing-turn")).rejects.toBe(cause);
  });
});
