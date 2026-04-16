import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {stringToUserMessage} from "../src/index.js";
import {DEFAULT_IDENTITY_ID,} from "../src/domain/identity/index.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

describe("PostgresThreadRuntimeStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  const SESSION_TABLE = "\"thread_runtime_agent_sessions\"";

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  async function seedSession(
    pool: {query: (text: string, values?: readonly unknown[]) => Promise<unknown>},
    input: {
      sessionId: string;
      threadId: string;
      agentKey?: string;
      createdByIdentityId?: string;
    },
  ): Promise<void> {
    await pool.query(
      `
        INSERT INTO ${SESSION_TABLE} (
          id,
          agent_key,
          kind,
          current_thread_id,
          created_by_identity_id,
          metadata
        ) VALUES ($1, $2, 'main', $3, $4, NULL::jsonb)
      `,
      [
        input.sessionId,
        input.agentKey ?? "panda",
        input.threadId,
        input.createdByIdentityId ?? null,
      ],
    );
  }

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

    const {identityStore, threadStore: store} = await createRuntimeStores(pool);

    await expect(identityStore.getIdentity(DEFAULT_IDENTITY_ID)).resolves.toMatchObject({
      handle: "local",
      displayName: "Local",
      status: "active",
    });

    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await expect(identityStore.getIdentityByHandle("alice")).resolves.toMatchObject({
      id: "alice-id",
      handle: "alice",
    });
    expect(alice.id).toBe("alice-id");

    await seedSession(pool, {
      sessionId: "session-alice",
      threadId: "pg-thread",
      createdByIdentityId: alice.id,
    });
    await seedSession(pool, {
      sessionId: "session-local",
      threadId: "pg-thread-local",
      agentKey: "panda-local",
    });

    const created = await store.createThread({
      id: "pg-thread",
      sessionId: "session-alice",
      systemPrompt: ["You are Panda."],
      context: {
        source: "telegram",
        agentKey: "panda",
        sessionId: "session-alice",
        identityId: alice.id,
        identityHandle: alice.handle,
      },
      maxTurns: 5,
      model: "openai/gpt-5.1",
      thinking: "medium",
      inferenceProjection: {
        dropThinking: {
          preserveRecentUserTurns: 2,
        },
      },
    });

    expect(created.sessionId).toBe("session-alice");
    expect(created.context).toMatchObject({
      agentKey: "panda",
      identityId: alice.id,
    });
    expect(created.systemPrompt).toEqual(["You are Panda."]);
    expect(created.thinking).toBe("medium");
    expect(created.inferenceProjection).toEqual({
      dropThinking: {
        preserveRecentUserTurns: 2,
      },
    });

    await store.createThread({
      id: "pg-thread-local",
      sessionId: "session-local",
      context: {
        agentKey: "panda-local",
        sessionId: "session-local",
      },
    });

    const aliceSummaries = await store.listThreadSummaries(undefined, "session-alice");
    expect(aliceSummaries).toHaveLength(1);
    expect(aliceSummaries[0]?.thread.id).toBe("pg-thread");

    const localSummaries = await store.listThreadSummaries(undefined, "session-local");
    expect(localSummaries).toHaveLength(1);
    expect(localSummaries[0]?.thread.id).toBe("pg-thread-local");

    const updated = await store.updateThread("pg-thread", {
      promptCacheKey: "thread:pg-thread",
      inferenceProjection: {
        dropMessages: {
          olderThanMs: 172_800_000,
        },
      },
    });

    expect(updated.sessionId).toBe("session-alice");
    expect(updated.promptCacheKey).toBe("thread:pg-thread");
    expect(updated.inferenceProjection).toEqual({
      dropMessages: {
        olderThanMs: 172_800_000,
      },
    });
    expect((await store.getThread("pg-thread")).inferenceProjection).toEqual({
      dropMessages: {
        olderThanMs: 172_800_000,
      },
    });

    const clearedThinking = await store.updateThread("pg-thread", {
      thinking: null,
    });
    expect(clearedThinking.thinking).toBeUndefined();

    const clearedProjection = await store.updateThread("pg-thread", {
      inferenceProjection: null,
    });
    expect(clearedProjection.inferenceProjection).toBeUndefined();
    expect((await store.getThread("pg-thread")).inferenceProjection).toBeUndefined();

    const telegramInput = await store.enqueueInput("pg-thread", {
      message: stringToUserMessage("hello from telegram"),
      source: "telegram",
      channelId: "chat-1",
      externalMessageId: "telegram-1",
      metadata: {
        media: [
          {
            id: "media-1",
            localPath: "/tmp/panda/photo.jpg",
          },
        ],
      },
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
    expect((await store.listPendingInputs("pg-thread"))[0]?.metadata).toEqual({
      media: [
        {
          id: "media-1",
          localPath: "/tmp/panda/photo.jpg",
        },
      ],
    });
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
    expect(applied[0]?.metadata).toEqual({
      media: [
        {
          id: "media-1",
          localPath: "/tmp/panda/photo.jpg",
        },
      ],
    });
    expect(await store.hasPendingInputs("pg-thread")).toBe(false);
    expect(await store.listPendingInputs("pg-thread")).toHaveLength(0);

    const run = await store.createRun("pg-thread");
    await store.appendRuntimeMessage("pg-thread", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "openai-responses",
        model: "openai/gpt-5.1",
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
    expect((await store.loadTranscript("pg-thread"))[0]?.metadata).toEqual({
      media: [
        {
          id: "media-1",
          localPath: "/tmp/panda/photo.jpg",
        },
      ],
    });
    expect((await store.loadTranscript("pg-thread"))[3]?.metadata).toEqual({
      kind: "assistant-debug",
    });
    expect((await store.listRuns("pg-thread")).map((entry) => entry.status)).toEqual([
      "completed",
    ]);

    const summaries = await store.listThreadSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      thread: {
        id: "pg-thread",
        sessionId: "session-alice",
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

  it("discards unapplied wake and queued inputs", async () => {
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

    const {threadStore: store} = await createRuntimeStores(pool);

    await seedSession(pool, {
      sessionId: "session-reset",
      threadId: "pg-thread-reset",
    });
    await store.createThread({
      id: "pg-thread-reset",
      sessionId: "session-reset",
      context: {
        agentKey: "panda",
        sessionId: "session-reset",
      },
    });

    await store.enqueueInput("pg-thread-reset", {
      message: stringToUserMessage("wake me"),
      source: "telegram",
    });
    await store.enqueueInput("pg-thread-reset", {
      message: stringToUserMessage("queue me"),
      source: "tui",
    }, "queue");

    await expect(store.discardPendingInputs("pg-thread-reset")).resolves.toBe(2);
    await expect(store.hasPendingInputs("pg-thread-reset")).resolves.toBe(false);
    await expect(store.listPendingInputs("pg-thread-reset")).resolves.toEqual([]);
    await expect(store.loadTranscript("pg-thread-reset")).resolves.toEqual([]);
  });

  it("round-trips durable pending wakes", async () => {
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

    const {threadStore: store} = await createRuntimeStores(pool);

    await seedSession(pool, {
      sessionId: "session-pending-wake",
      threadId: "pg-thread-pending-wake",
    });
    await store.createThread({
      id: "pg-thread-pending-wake",
      sessionId: "session-pending-wake",
      context: {
        agentKey: "panda",
        sessionId: "session-pending-wake",
      },
    });

    await expect(store.hasPendingWake("pg-thread-pending-wake")).resolves.toBe(false);

    await store.requestWake("pg-thread-pending-wake");

    await expect(store.hasPendingWake("pg-thread-pending-wake")).resolves.toBe(true);
    await expect(store.consumePendingWake("pg-thread-pending-wake")).resolves.toBe(true);
    await expect(store.hasPendingWake("pg-thread-pending-wake")).resolves.toBe(false);
    await expect(store.consumePendingWake("pg-thread-pending-wake")).resolves.toBe(false);
  });

  it("round-trips background bash job metadata", async () => {
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

    const {threadStore: store} = await createRuntimeStores(pool);

    await seedSession(pool, {
      sessionId: "session-bash-job",
      threadId: "pg-thread-bash-job",
    });
    await store.createThread({
      id: "pg-thread-bash-job",
      sessionId: "session-bash-job",
      context: {
        agentKey: "panda",
        sessionId: "session-bash-job",
      },
    });
    const run = await store.createRun("pg-thread-bash-job");

    const created = await store.createBashJob({
      id: "00000000-0000-4000-8000-000000000001",
      threadId: "pg-thread-bash-job",
      runId: run.id,
      command: "sleep 1 && printf hi",
      mode: "local",
      initialCwd: "/workspace",
      trackedEnvKeys: ["TEST_VAR"],
    });

    expect(created).toMatchObject({
      threadId: "pg-thread-bash-job",
      runId: run.id,
      status: "running",
      trackedEnvKeys: ["TEST_VAR"],
    });

    const finished = await store.updateBashJob(created.id, {
      status: "completed",
      finalCwd: "/workspace/nested",
      finishedAt: created.startedAt + 250,
      durationMs: 250,
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      stdoutChars: 5,
      stderrChars: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutPersisted: true,
      stderrPersisted: false,
      stdoutPath: "/tmp/stdout.txt",
      trackedEnvKeys: ["TEST_VAR"],
    });

    expect(finished).toMatchObject({
      status: "completed",
      finalCwd: "/workspace/nested",
      stdout: "hello",
      stdoutPersisted: true,
      stdoutPath: "/tmp/stdout.txt",
    });
    expect(await store.getBashJob(created.id)).toMatchObject({
      status: "completed",
      stdout: "hello",
    });
    expect(await store.listBashJobs("pg-thread-bash-job")).toHaveLength(1);
  });

  it("marks orphaned running background bash jobs as lost", async () => {
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

    const {threadStore: store} = await createRuntimeStores(pool);

    await seedSession(pool, {
      sessionId: "session-lost-job",
      threadId: "pg-thread-lost-job",
    });
    await store.createThread({
      id: "pg-thread-lost-job",
      sessionId: "session-lost-job",
      context: {
        agentKey: "panda",
        sessionId: "session-lost-job",
      },
    });
    const created = await store.createBashJob({
      id: "00000000-0000-4000-8000-000000000002",
      threadId: "pg-thread-lost-job",
      command: "sleep 5",
      mode: "local",
      initialCwd: "/workspace",
    });

    expect(await store.markRunningBashJobsLost("runtime restarted")).toBe(1);

    const lost = await store.getBashJob(created.id);
    expect(lost.status).toBe("lost");
    expect(lost.statusReason).toBe("runtime restarted");
    expect(lost.finishedAt).toBeDefined();
  });

  it("rejects threads without a session id instead of silently creating one", async () => {
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

    const {threadStore: store} = await createRuntimeStores(pool);

    await expect(store.createThread({
      id: "pg-thread-missing-session",
      sessionId: "   ",
      context: {
        agentKey: "panda",
      },
    })).rejects.toThrow("Thread pg-thread-missing-session is missing sessionId.");
  });
});
