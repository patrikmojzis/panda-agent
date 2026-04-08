import { afterEach, describe, expect, it } from "vitest";
import { DataType, newDb } from "pg-mem";

import { PostgresThreadRuntimeStore, stringToUserMessage } from "../src/index.js";

describe("PostgresThreadRuntimeStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("persists threads, pending inputs, transcript messages, and runs", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const store = new PostgresThreadRuntimeStore({ pool });
    await store.ensureSchema();

    const created = await store.createThread({
      id: "pg-thread",
      agentKey: "panda",
      systemPrompt: ["You are Panda."],
      context: {
        source: "telegram",
      },
      maxTurns: 5,
      provider: "openai",
      model: "gpt-5.1",
      thinking: "medium",
    });

    expect(created.agentKey).toBe("panda");
    expect(created.systemPrompt).toEqual(["You are Panda."]);
    expect(created.thinking).toBe("medium");

    const updated = await store.updateThread("pg-thread", {
      agentKey: "panda-debug",
      promptCacheKey: "thread:pg-thread",
    });

    expect(updated.agentKey).toBe("panda-debug");
    expect(updated.promptCacheKey).toBe("thread:pg-thread");

    const clearedThinking = await store.updateThread("pg-thread", {
      thinking: null,
    });
    expect(clearedThinking.thinking).toBeUndefined();

    const telegramInput = await store.enqueueInput("pg-thread", {
      message: stringToUserMessage("hello from telegram"),
      source: "telegram",
      channelId: "chat-1",
      externalMessageId: "telegram-1",
    });
    expect(telegramInput.inserted).toBe(true);

    const duplicateTelegramInput = await store.enqueueInput("pg-thread", {
      message: stringToUserMessage("hello from telegram"),
      source: "telegram",
      channelId: "chat-1",
      externalMessageId: "telegram-1",
    });
    expect(duplicateTelegramInput.inserted).toBe(false);

    const secondChannelInput = await store.enqueueInput("pg-thread", {
      message: stringToUserMessage("hello from another telegram chat"),
      source: "telegram",
      channelId: "chat-2",
      externalMessageId: "telegram-1",
    });
    expect(secondChannelInput.inserted).toBe(true);

    await store.enqueueInput("pg-thread", {
      message: stringToUserMessage("hello from tui"),
      source: "tui",
    }, "queue");

    expect(await store.hasPendingInputs("pg-thread")).toBe(true);
    expect(await store.hasRunnableInputs("pg-thread")).toBe(true);
    expect((await store.listPendingInputs("pg-thread")).map((input) => input.source)).toEqual([
      "telegram",
      "telegram",
      "tui",
    ]);
    expect((await store.listPendingInputs("pg-thread")).map((input) => input.deliveryMode)).toEqual([
      "wake",
      "wake",
      "queue",
    ]);

    expect(await store.promoteQueuedInputs("pg-thread")).toEqual(["pg-thread"]);
    expect((await store.listPendingInputs("pg-thread")).map((input) => input.deliveryMode)).toEqual([
      "wake",
      "wake",
      "wake",
    ]);

    const applied = await store.applyPendingInputs("pg-thread");
    expect(applied.map((message) => message.source)).toEqual([
      "telegram",
      "telegram",
      "tui",
    ]);
    expect(await store.hasPendingInputs("pg-thread")).toBe(false);
    expect(await store.listPendingInputs("pg-thread")).toHaveLength(0);

    const run = await store.createRun("pg-thread");
    await store.appendRuntimeMessage("pg-thread", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.1",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
      metadata: {
        kind: "assistant-debug",
      },
      source: "assistant",
      runId: run.id,
    });
    const completedRun = await store.completeRun(run.id);

    expect(completedRun.status).toBe("completed");
    expect((await store.loadTranscript("pg-thread")).map((entry) => entry.source)).toEqual([
      "telegram",
      "telegram",
      "tui",
      "assistant",
    ]);
    expect((await store.loadTranscript("pg-thread"))[3]?.metadata).toEqual({
      kind: "assistant-debug",
    });
    expect((await store.listRuns("pg-thread")).map((entry) => entry.status)).toEqual([
      "completed",
    ]);

    const summaries = await store.listThreadSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      thread: {
        id: "pg-thread",
      },
      messageCount: 4,
      pendingInputCount: 0,
      lastMessage: {
        source: "assistant",
      },
    });

    const failedRun = await store.createRun("pg-thread");
    const abortRequested = await store.requestRunAbort("pg-thread", "recover me");
    expect(abortRequested?.id).toBe(failedRun.id);
    const completedAfterAbort = await store.completeRun(failedRun.id);
    expect(completedAfterAbort.status).toBe("failed");
    expect(completedAfterAbort.error).toBe("recover me");
  });
});
