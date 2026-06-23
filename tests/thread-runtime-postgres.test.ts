import {EventEmitter} from "node:events";

import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {stringToUserMessage} from "../src/index.js";
import {observePostgresPool} from "../src/app/runtime/database.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";
import {buildThreadRuntimeTableNames} from "../src/domain/threads/runtime/postgres-shared.js";
import {parseInputRow, parseMessageRow, parseToolJobRow,} from "../src/domain/threads/runtime/postgres-rows.js";
import {
    backfillWorkerMetadataFromLegacyThreadContext,
    buildThreadRuntimeSchemaSql,
    migrateSessionRuntimeConfigFromThreadRows,
} from "../src/domain/threads/runtime/postgres-schema.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {THREAD_RUNTIME_JSONB_NUL_PLACEHOLDER,} from "../src/domain/threads/runtime/postgres-jsonb-safety.js";

const NUL = "\0";
const NUL_PLACEHOLDER = THREAD_RUNTIME_JSONB_NUL_PLACEHOLDER;

type ThreadRuntimePool = ConstructorParameters<typeof PostgresThreadRuntimeStore>[0]["pool"];

function createQueryOnlyThreadRuntimePool(
  query: ThreadRuntimePool["query"],
  message: string,
): ThreadRuntimePool {
  return {
    query,
    connect: async () => {
      throw new Error(message);
    },
  };
}

describe("PostgresThreadRuntimeStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  const SESSION_TABLE = "\"runtime\".\"agent_sessions\"";
  const MESSAGES_TABLE = buildThreadRuntimeTableNames().messages;

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

  it("backfills legacy set_env_value assistant tool-call values during schema ensure", async () => {
    let persistedMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_set_env",
          name: "set_env_value",
          arguments: {
            key: "OPENAI_API_KEY",
            value: "sk-legacy-secret",
          },
        },
        {
          type: "toolCall",
          id: "call_bash",
          name: "bash",
          arguments: {
            command: "printf ok",
          },
        },
      ],
      timestamp: Date.now(),
    };
    let migrationApplied = false;
    let markerInsertCount = 0;
    let candidateSelectCount = 0;
    let updateCount = 0;
    const pool = createQueryOnlyThreadRuntimePool(async (text, values) => {
      if (text.includes("FROM") && text.includes("thread_runtime_migrations")) {
        return { rows: migrationApplied ? [{ "?column?": 1 }] : [] };
      }

      if (text.includes("INSERT INTO") && text.includes("thread_runtime_migrations")) {
        markerInsertCount += 1;
        migrationApplied = true;
        return { rows: [] };
      }

      if (text.includes("SELECT id, message") && text.includes(MESSAGES_TABLE)) {
        candidateSelectCount += 1;
        expect(text).toContain("message->>'content' LIKE '%set_env_value%'");
        expect(text).toContain("message->>'content' LIKE '%value%'");
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000001",
            message: persistedMessage,
          }],
        };
      }

      if (text.includes("UPDATE") && text.includes(MESSAGES_TABLE) && text.includes("SET message")) {
        updateCount += 1;
        persistedMessage = JSON.parse(String(values?.[1]));
        return { rows: [] };
      }

      if (text.includes("COUNT(*)::INTEGER AS count")) {
        return { rows: [{ count: 0 }] };
      }

      return { rows: [] };
    }, "connect was not expected for schema ensure");
    const store = new PostgresThreadRuntimeStore({pool});

    await store.ensureSchema();
    await store.ensureSchema();

    expect(candidateSelectCount).toBe(1);
    expect(updateCount).toBe(1);
    expect(markerInsertCount).toBe(1);
    expect(persistedMessage).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "set_env_value",
          arguments: {
            key: "OPENAI_API_KEY",
            value: "[redacted]",
          },
        },
        {
          type: "toolCall",
          name: "bash",
          arguments: {
            command: "printf ok",
          },
        },
      ],
    });
    expect(JSON.stringify(persistedMessage)).not.toContain("sk-legacy-secret");
  });

  it("does not log expected pool errors when ensuring a clean migrated thread schema", async () => {
    class CleanMigratedSchemaPool extends EventEmitter {
      totalCount = 0;
      idleCount = 0;
      waitingCount = 0;
      readonly queryTexts: string[] = [];

      connect(): Promise<never> {
        return Promise.reject(new Error("connect was not expected for clean schema ensure"));
      }

      query(text: string): Promise<{rows: Array<Record<string, unknown>>}> {
        this.queryTexts.push(text);
        if (/SELECT\s+"(?:system_prompt|max_turns|temperature|context|model|thinking|pending_wake_at|prompt_cache_key|inference_projection)"/.test(text)) {
          return Promise.reject(new Error("legacy column does not exist"));
        }

        if (text.includes("information_schema.columns")) {
          return Promise.resolve({
            rows: [
              {table_schema: "runtime", column_name: "id"},
              {table_schema: "runtime", column_name: "session_id"},
              {table_schema: "runtime", column_name: "runtime_state"},
              {table_schema: "runtime", column_name: "created_at"},
              {table_schema: "runtime", column_name: "updated_at"},
            ],
          });
        }

        if (text.includes("COUNT(*)::INTEGER AS count")) {
          return Promise.resolve({rows: [{count: 0}]});
        }

        if (text.includes("FROM") && text.includes("thread_runtime_migrations")) {
          return Promise.resolve({rows: [{"?column?": 1}]});
        }

        return Promise.resolve({rows: []});
      }
    }

    const pool = new CleanMigratedSchemaPool();
    const log = vi.fn();
    const observer = observePostgresPool({
      pool,
      applicationName: "thread-runtime-test",
      log,
    });

    try {
      const store = new PostgresThreadRuntimeStore({pool});
      await store.ensureSchema();
    } finally {
      observer.stop();
    }

    expect(pool.queryTexts.some((text) => text.includes("information_schema.columns"))).toBe(true);
    expect(log).not.toHaveBeenCalledWith("postgres_pool_error", expect.anything());
  });

  it("loads latest shell sessions by session and execution environment", async () => {
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

    const {sessionStore, threadStore: store} = await createRuntimeStores(pool);
    await seedSession(pool, {
      sessionId: "session-shell-state",
      threadId: "thread-shell-state",
    });
    await store.createThread({
      id: "thread-shell-state",
      sessionId: "session-shell-state",
    });
    await store.createThread({
      id: "replacement-thread",
      sessionId: "session-shell-state",
    });
    await sessionStore.createSession({
      id: "other-shell-state",
      agentKey: "panda",
      kind: "worker",
      currentThreadId: "other-thread",
    });
    await store.createThread({
      id: "other-thread",
      sessionId: "other-shell-state",
    });

    await store.upsertShellSession({
      sessionId: "session-shell-state",
      threadId: "thread-shell-state",
      executionEnvironmentId: "default",
      shellSession: {
        cwd: "/workspace/default-old",
        env: {FOO: "old"},
      },
    });
    await store.upsertShellSession({
      sessionId: "session-shell-state",
      threadId: "thread-shell-state",
      executionEnvironmentId: "env-one",
      shellSession: {
        cwd: "/workspace/env-one",
        env: {FOO: "env-one"},
      },
    });
    await store.upsertShellSession({
      sessionId: "session-shell-state",
      threadId: "replacement-thread",
      executionEnvironmentId: "default",
      shellSession: {
        cwd: "/workspace/default-new",
        env: {FOO: "new"},
      },
    });
    await store.upsertShellSession({
      sessionId: "other-shell-state",
      threadId: "other-thread",
      executionEnvironmentId: "default",
      shellSession: {
        cwd: "/workspace/other",
        env: {FOO: "other"},
      },
    });

    const shellStatesTable = buildThreadRuntimeTableNames().shellStates;
    await pool.query(`
      UPDATE ${shellStatesTable}
      SET updated_at = $4
      WHERE session_id = $1
        AND thread_id = $2
        AND execution_environment_id = $3
    `, ["session-shell-state", "thread-shell-state", "default", new Date("2026-01-01T00:00:00.000Z")]);
    await pool.query(`
      UPDATE ${shellStatesTable}
      SET updated_at = $4
      WHERE session_id = $1
        AND thread_id = $2
        AND execution_environment_id = $3
    `, ["session-shell-state", "thread-shell-state", "env-one", new Date("2026-01-01T00:01:00.000Z")]);
    await pool.query(`
      UPDATE ${shellStatesTable}
      SET updated_at = $4
      WHERE session_id = $1
        AND thread_id = $2
        AND execution_environment_id = $3
    `, ["session-shell-state", "replacement-thread", "default", new Date("2026-01-01T00:02:00.000Z")]);

    expect(await store.listShellSessions({
      sessionId: "session-shell-state",
    })).toEqual({
      default: {cwd: "/workspace/default-new", env: {FOO: "new"}},
      "env-one": {cwd: "/workspace/env-one", env: {FOO: "env-one"}},
    });
    expect(await store.listShellSessions({
      sessionId: "other-shell-state",
    })).toEqual({
      default: {cwd: "/workspace/other", env: {FOO: "other"}},
    });
  });

  it("persists threads, pending inputs, transcript messages, and runs", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    db.public.registerFunction({
      name: "jsonb_set",
      args: [DataType.jsonb, DataType.text, DataType.jsonb],
      returns: DataType.jsonb,
      implementation: (target: unknown, path: string, value: unknown) => {
        const base = typeof target === "string" ? JSON.parse(target) : target;
        const key = path.replace(/[{}]/g, "").split(",")[0] || "worker";
        const parsedValue = typeof value === "string"
          ? (() => {
            try {
              return JSON.parse(value);
            } catch {
              return value;
            }
          })()
          : value;
        return {
          ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}),
          [key]: parsedValue,
        };
      },
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const {agentStore, identityStore, sessionStore, threadStore: store} = await createRuntimeStores(pool);

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
    await agentStore.bootstrapAgent({
      agentKey: "panda-local",
      displayName: "Panda Local",
    });

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
    });

    expect(created.sessionId).toBe("session-alice");
    expect(created).not.toHaveProperty("context");
    expect(created).not.toHaveProperty("systemPrompt");
    expect(created).not.toHaveProperty("maxTurns");
    expect(created).not.toHaveProperty("temperature");

    const runtimeConfig = await sessionStore.updateSessionRuntimeConfig({
      sessionId: "session-alice",
      model: "openai/gpt-5.1",
      thinking: "medium",
      inferenceProjection: {
        dropThinking: {
          preserveRecentUserTurns: 2,
        },
      },
    });
    expect(runtimeConfig.model).toBe("openai/gpt-5.1");
    expect(runtimeConfig.thinking).toBe("medium");
    expect(runtimeConfig.thinkingConfigured).toBe(true);
    expect(runtimeConfig.inferenceProjection).toEqual({
      dropThinking: {
        preserveRecentUserTurns: 2,
      },
    });

    await store.createThread({
      id: "pg-thread-local",
      sessionId: "session-local",
    });

    const aliceSummaries = await store.listThreadSummaries(undefined, "session-alice");
    expect(aliceSummaries).toHaveLength(1);
    expect(aliceSummaries[0]?.thread.id).toBe("pg-thread");

    const localSummaries = await store.listThreadSummaries(undefined, "session-local");
    expect(localSummaries).toHaveLength(1);
    expect(localSummaries[0]?.thread.id).toBe("pg-thread-local");

    const updatedRuntimeConfig = await sessionStore.updateSessionRuntimeConfig({
      sessionId: "session-alice",
      inferenceProjection: {
        dropMessages: {
          olderThanMs: 172_800_000,
        },
      },
    });
    expect(updatedRuntimeConfig.inferenceProjection).toEqual({
      dropMessages: {
        olderThanMs: 172_800_000,
      },
    });

    const clearedRuntimeConfig = await sessionStore.updateSessionRuntimeConfig({
      sessionId: "session-alice",
      model: null,
      thinking: null,
      inferenceProjection: null,
    });
    expect(clearedRuntimeConfig.model).toBeUndefined();
    expect(clearedRuntimeConfig.thinking).toBeUndefined();
    expect(clearedRuntimeConfig.thinkingConfigured).toBe(true);
    expect(clearedRuntimeConfig.inferenceProjection).toBeUndefined();

    const defaultThinkingRuntimeConfig = await sessionStore.updateSessionRuntimeConfig({
      sessionId: "session-alice",
      thinkingConfigured: false,
    });
    expect(defaultThinkingRuntimeConfig.thinking).toBeUndefined();
    expect(defaultThinkingRuntimeConfig.thinkingConfigured).toBe(false);

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



  it("migrates session runtime config off legacy thread columns and drops them", async () => {
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

    const {agentStore, sessionStore, threadStore: store} = await createRuntimeStores(pool);
    await agentStore.bootstrapAgent({
      agentKey: "panda-worker",
      displayName: "Panda Worker",
    });
    await seedSession(pool, {
      sessionId: "legacy-session",
      threadId: "legacy-thread",
    });
    await seedSession(pool, {
      sessionId: "legacy-worker-session",
      threadId: "legacy-worker-thread",
      agentKey: "panda-worker",
    });
    await pool.query(`UPDATE ${SESSION_TABLE} SET kind = 'worker' WHERE id = $1`, ["legacy-worker-session"]);
    await store.createThread({id: "legacy-thread", sessionId: "legacy-session"});
    await store.createThread({id: "legacy-worker-thread", sessionId: "legacy-worker-session"});

    const threadTable = buildThreadRuntimeTableNames().threads;
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN model TEXT`);
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN thinking TEXT`);
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN pending_wake_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN prompt_cache_key TEXT`);
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN inference_projection JSONB`);
    await pool.query(`
      UPDATE ${threadTable}
      SET model = 'openai/gpt-5.1',
          thinking = 'medium',
          pending_wake_at = NOW(),
          prompt_cache_key = 'thread:' || id,
          inference_projection = $2::jsonb
      WHERE id = $1
    `, [
      "legacy-thread",
      JSON.stringify({dropThinking: {preserveRecentUserTurns: 3}}),
    ]);
    await pool.query(`
      UPDATE ${threadTable}
      SET thinking = 'xhigh',
          prompt_cache_key = 'thread:' || id
      WHERE id = $1
    `, ["legacy-worker-thread"]);

    await migrateSessionRuntimeConfigFromThreadRows(pool, buildThreadRuntimeTableNames());

    await expect(sessionStore.getSessionRuntimeConfig("legacy-session")).resolves.toMatchObject({
      sessionId: "legacy-session",
      model: "openai/gpt-5.1",
      thinking: "medium",
      thinkingConfigured: true,
      inferenceProjection: {dropThinking: {preserveRecentUserTurns: 3}},
    });
    await expect(store.hasPendingWake("legacy-thread")).resolves.toBe(true);
    await expect(sessionStore.getSessionRuntimeConfig("legacy-worker-session")).resolves.toMatchObject({
      sessionId: "legacy-worker-session",
      thinkingConfigured: false,
    });

    const columns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'runtime'
        AND table_name = 'threads'
        AND column_name IN ('model', 'thinking', 'pending_wake_at', 'prompt_cache_key', 'inference_projection')
    `);
    expect(columns.rows).toEqual([]);
  });

  it("backfills legacy worker context before dropping thread context", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    db.public.registerFunction({
      name: "jsonb_set",
      args: [DataType.jsonb, DataType.text, DataType.jsonb],
      returns: DataType.jsonb,
      implementation: (target: unknown, path: string, value: unknown) => {
        const base = typeof target === "string" ? JSON.parse(target) : target;
        const key = path.replace(/[{}]/g, "").split(",")[0] || "worker";
        const parsedValue = typeof value === "string"
          ? (() => {
            try {
              return JSON.parse(value);
            } catch {
              return value;
            }
          })()
          : value;
        return {
          ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}),
          [key]: parsedValue,
        };
      },
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const {sessionStore, threadStore: store} = await createRuntimeStores(pool);
    await sessionStore.createSession({
      id: "legacy-worker-session",
      agentKey: "panda",
      kind: "worker",
      currentThreadId: "legacy-worker-thread",
    });
    await store.createThread({
      id: "legacy-worker-thread",
      sessionId: "legacy-worker-session",
    });
    await sessionStore.createSession({
      id: "existing-worker-session",
      agentKey: "panda",
      kind: "worker",
      currentThreadId: "existing-worker-thread",
      metadata: {
        worker: {
          role: "existing",
        },
      },
    });
    await store.createThread({
      id: "existing-worker-thread",
      sessionId: "existing-worker-session",
    });

    const threadTable = buildThreadRuntimeTableNames().threads;
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN context JSONB`);
    await pool.query(`
      UPDATE ${threadTable}
      SET context = $2::jsonb
      WHERE id = $1
    `, [
      "legacy-worker-thread",
      JSON.stringify({
        worker: {
          role: "research",
          task: "Inspect the package graph.",
          context: "Keep it read-only.",
          parentSessionId: "parent-session",
        },
      }),
    ]);
    await pool.query(`
      UPDATE ${threadTable}
      SET context = $2::jsonb
      WHERE id = $1
    `, [
      "existing-worker-thread",
      JSON.stringify({
        worker: {
          role: "legacy-should-not-overwrite",
        },
      }),
    ]);

    await backfillWorkerMetadataFromLegacyThreadContext(
      pool,
      buildThreadRuntimeTableNames(),
      new Set(["context"]),
    );
    const schemaSql = buildThreadRuntimeSchemaSql(buildThreadRuntimeTableNames(), '"runtime"."identities"');
    const cleanupSql = schemaSql.slice(
      0,
      schemaSql.indexOf(`CREATE TABLE IF NOT EXISTS ${buildThreadRuntimeTableNames().messages}`),
    );
    await pool.query(cleanupSql);

    await expect(sessionStore.getSession("legacy-worker-session")).resolves.toMatchObject({
      metadata: {
        worker: {
          role: "research",
          task: "Inspect the package graph.",
          context: "Keep it read-only.",
          parentSessionId: "parent-session",
        },
      },
    });
    await expect(sessionStore.getSession("existing-worker-session")).resolves.toMatchObject({
      metadata: {
        worker: {
          role: "existing",
        },
      },
    });

    const columns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'runtime'
        AND table_name = 'threads'
        AND column_name = 'context'
    `);
    expect(columns.rows).toEqual([]);
  });

  it("drops legacy scalar thread baggage columns during schema ensure", async () => {
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
      sessionId: "scalar-baggage-session",
      threadId: "scalar-baggage-thread",
    });
    await store.createThread({id: "scalar-baggage-thread", sessionId: "scalar-baggage-session"});

    const threadTable = buildThreadRuntimeTableNames().threads;
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN system_prompt JSONB`);
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN max_turns INTEGER`);
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN temperature DOUBLE PRECISION`);
    await pool.query(`
      UPDATE ${threadTable}
      SET system_prompt = $2::jsonb,
          max_turns = 5,
          temperature = 0.7
      WHERE id = $1
    `, [
      "scalar-baggage-thread",
      JSON.stringify(["legacy persisted prompt"]),
    ]);

    const schemaSql = buildThreadRuntimeSchemaSql(buildThreadRuntimeTableNames(), '"runtime"."identities"');
    expect(schemaSql).toContain("DROP COLUMN IF EXISTS system_prompt");
    expect(schemaSql).toContain("DROP COLUMN IF EXISTS max_turns");
    expect(schemaSql).toContain("DROP COLUMN IF EXISTS temperature");
    expect(schemaSql).toContain("DROP COLUMN IF EXISTS context");
    const cleanupSql = schemaSql.slice(
      0,
      schemaSql.indexOf(`CREATE TABLE IF NOT EXISTS ${buildThreadRuntimeTableNames().messages}`),
    );
    await pool.query(cleanupSql);

    const columns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'runtime'
        AND table_name = 'threads'
        AND column_name IN ('system_prompt', 'max_turns', 'temperature')
    `);
    expect(columns.rows).toEqual([]);
    await expect(store.getThread("scalar-baggage-thread")).resolves.not.toHaveProperty("systemPrompt");
  });

  it("merges legacy thread runtime fields into existing partial session runtime config rows", async () => {
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

    const {sessionStore, threadStore: store} = await createRuntimeStores(pool);
    await seedSession(pool, {
      sessionId: "partial-config-session",
      threadId: "partial-config-thread",
    });
    await store.createThread({id: "partial-config-thread", sessionId: "partial-config-session"});
    await sessionStore.updateSessionRuntimeConfig({
      sessionId: "partial-config-session",
      model: "openai/gpt-5.1",
      thinking: null,
    });

    const threadTable = buildThreadRuntimeTableNames().threads;
    const pendingWakeAt = Date.parse("2035-01-02T03:04:05.000Z");
    const legacyProjection = {dropThinking: {preserveRecentUserTurns: 4}};
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN model TEXT`);
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN thinking TEXT`);
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN pending_wake_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN prompt_cache_key TEXT`);
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN inference_projection JSONB`);
    await pool.query(`
      UPDATE ${threadTable}
      SET model = 'openai/gpt-5.2',
          thinking = 'high',
          pending_wake_at = $2,
          prompt_cache_key = 'thread:' || id,
          inference_projection = $3::jsonb
      WHERE id = $1
    `, [
      "partial-config-thread",
      new Date(pendingWakeAt),
      JSON.stringify(legacyProjection),
    ]);

    await migrateSessionRuntimeConfigFromThreadRows(pool, buildThreadRuntimeTableNames());

    const migratedConfig = await sessionStore.getSessionRuntimeConfig("partial-config-session");
    expect(migratedConfig).toMatchObject({
      sessionId: "partial-config-session",
      model: "openai/gpt-5.1",
      thinkingConfigured: true,
      inferenceProjection: legacyProjection,
      pendingWakeAt,
    });
    expect(migratedConfig.thinking).toBeUndefined();
    await expect(store.hasPendingWake("partial-config-thread")).resolves.toBe(true);
  });

  it("refuses to drop custom legacy prompt cache keys", async () => {
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
      sessionId: "custom-cache-session",
      threadId: "custom-cache-thread",
    });
    await store.createThread({id: "custom-cache-thread", sessionId: "custom-cache-session"});
    const threadTable = buildThreadRuntimeTableNames().threads;
    await pool.query(`ALTER TABLE ${threadTable} ADD COLUMN prompt_cache_key TEXT`);
    await pool.query(`UPDATE ${threadTable} SET prompt_cache_key = 'custom:key' WHERE id = $1`, [
      "custom-cache-thread",
    ]);

    await expect(
      migrateSessionRuntimeConfigFromThreadRows(pool, buildThreadRuntimeTableNames()),
    ).rejects.toThrow(
      "Cannot drop runtime.threads.prompt_cache_key while custom key exists on thread custom-cache-thread.",
    );
  });


  it("persists bash tool results with sanitized NUL output previews", async () => {
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
      sessionId: "session-bash-nul",
      threadId: "pg-thread-bash-nul",
    });
    await store.createThread({
      id: "pg-thread-bash-nul",
      sessionId: "session-bash-nul",
    });
    const run = await store.createRun("pg-thread-bash-nul");

    await store.appendRuntimeMessage("pg-thread-bash-nul", {
      message: {
        role: "toolResult",
        toolCallId: "call-bash-nul",
        toolName: "bash",
        content: [{ type: "text", text: "{\"stdout\":\"hello␀stdout\"}" }],
        details: {
          stdout: "hello␀stdout",
          stderr: "warn␀stderr",
          exitCode: 0,
          timedOut: false,
        },
        isError: false,
        timestamp: Date.now(),
      },
      source: "tool:bash",
      runId: run.id,
    });

    const [persisted] = await store.loadTranscript("pg-thread-bash-nul");
    const message = persisted?.message as {details?: {stdout?: unknown; stderr?: unknown}} | undefined;
    expect(message?.details?.stdout).toBe("hello␀stdout");
    expect(message?.details?.stderr).toBe("warn␀stderr");
    expect(JSON.stringify(persisted?.message)).not.toContain("\\u0000");
  });

  it("sanitizes actual NULs in runtime input and message JSONB fields", async () => {
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
      sessionId: "session-jsonb-nul",
      threadId: "pg-thread-jsonb-nul",
    });
    await store.createThread({
      id: "pg-thread-jsonb-nul",
      sessionId: "session-jsonb-nul",
    });

    const inputMessage = stringToUserMessage(`hello${NUL}input`);
    const inputMetadata = {
      label: `meta${NUL}data`,
      nested: {
        [`key${NUL}name`]: `value${NUL}text`,
      },
    };

    const queued = await store.enqueueInput("pg-thread-jsonb-nul", {
      message: inputMessage,
      source: "telegram",
      metadata: inputMetadata,
    });

    expect((queued.input.message as {content?: unknown}).content).toBe(`hello${NUL_PLACEHOLDER}input`);
    expect(queued.input.metadata).toEqual({
      label: `meta${NUL_PLACEHOLDER}data`,
      nested: {
        [`key${NUL_PLACEHOLDER}name`]: `value${NUL_PLACEHOLDER}text`,
      },
    });
    expect(inputMessage.content).toBe(`hello${NUL}input`);
    expect(inputMetadata.label).toBe(`meta${NUL}data`);
    expect(Object.keys(inputMetadata.nested)).toEqual([`key${NUL}name`]);

    const applied = await store.applyPendingInputs("pg-thread-jsonb-nul");
    expect((applied[0]?.message as {content?: unknown} | undefined)?.content).toBe(`hello${NUL_PLACEHOLDER}input`);
    expect(applied[0]?.metadata).toEqual({
      label: `meta${NUL_PLACEHOLDER}data`,
      nested: {
        [`key${NUL_PLACEHOLDER}name`]: `value${NUL_PLACEHOLDER}text`,
      },
    });

    const run = await store.createRun("pg-thread-jsonb-nul");
    const assistantMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: `assistant${NUL}reply` }],
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
    };
    const assistantMetadata = {
      note: `assistant${NUL}meta`,
    };

    await store.appendRuntimeMessage("pg-thread-jsonb-nul", {
      message: assistantMessage,
      metadata: assistantMetadata,
      source: "assistant",
      runId: run.id,
    });

    const transcript = await store.loadTranscript("pg-thread-jsonb-nul");
    const persistedAssistant = transcript[1]?.message as {content?: Array<{text?: string}>} | undefined;
    expect(persistedAssistant?.content?.[0]?.text).toBe(`assistant${NUL_PLACEHOLDER}reply`);
    expect(transcript[1]?.metadata).toEqual({
      note: `assistant${NUL_PLACEHOLDER}meta`,
    });
    expect(assistantMessage.content[0]?.text).toBe(`assistant${NUL}reply`);
    expect(assistantMetadata.note).toBe(`assistant${NUL}meta`);
    expect(JSON.stringify(transcript)).not.toContain("\\u0000");
    expect(JSON.stringify(transcript)).not.toContain(NUL);
  });

  it("rejects malformed persisted thread summary counts", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM \"runtime\".\"threads\"") && !sql.includes("COUNT(*)")) {
        return {
          rows: [{
            id: "thread-1",
            session_id: "session-1",
            runtime_state: null,
            inference_projection: null,
            prompt_cache_key: null,
            model: null,
            thinking: null,
            created_at: new Date(1),
            updated_at: new Date(1),
          }],
        };
      }

      if (sql.includes("message_count")) {
        return {rows: [{thread_id: "thread-1", message_count: "many"}]};
      }

      if (sql.includes("pending_input_count")) {
        return {rows: []};
      }

      return {rows: []};
    });
    const store = new PostgresThreadRuntimeStore({
      pool: createQueryOnlyThreadRuntimePool(query, "connect should not be used by summary reads"),
    });

    await expect(store.listThreadSummaries()).rejects.toThrow(
      "Thread runtime summary message_count must be a non-negative safe integer.",
    );
  });

  it("accepts postgres bigint-shaped thread summary counts", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM \"runtime\".\"threads\"") && !sql.includes("COUNT(*)")) {
        return {
          rows: [{
            id: "thread-1",
            session_id: "session-1",
            runtime_state: null,
            inference_projection: null,
            prompt_cache_key: null,
            model: null,
            thinking: null,
            created_at: new Date(1),
            updated_at: new Date(1),
          }],
        };
      }

      if (sql.includes("message_count")) {
        return {rows: [{thread_id: "thread-1", message_count: "4"}]};
      }

      if (sql.includes("pending_input_count")) {
        return {rows: [{thread_id: "thread-1", pending_input_count: "0"}]};
      }

      return {rows: []};
    });
    const store = new PostgresThreadRuntimeStore({
      pool: createQueryOnlyThreadRuntimePool(query, "connect should not be used by summary reads"),
    });

    await expect(store.listThreadSummaries()).resolves.toEqual([
      expect.objectContaining({
        messageCount: 4,
        pendingInputCount: 0,
      }),
    ]);
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

  it("rejects malformed promoted input thread ids before notifying threads", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        thread_id: "",
      }],
    }));
    const store = new PostgresThreadRuntimeStore({
      pool: createQueryOnlyThreadRuntimePool(query, "connect should not be used by queued input promotion"),
    });

    await expect(store.promoteQueuedInputs()).rejects.toThrow(
      "Thread runtime input thread id must not be empty.",
    );
    expect(query).toHaveBeenCalledTimes(1);
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
    });
    const run = await store.createRun("pg-thread-bash-job");

    const created = await store.createToolJob({
      id: "00000000-0000-4000-8000-000000000001",
      threadId: "pg-thread-bash-job",
      runId: run.id,
      kind: "bash",
      summary: "sleep 1 && printf hi",
      result: {
        command: "sleep 1 && printf hi",
        mode: "local",
        initialCwd: "/workspace",
        trackedEnvKeys: ["TEST_VAR"],
      },
    });

    expect(created).toMatchObject({
      threadId: "pg-thread-bash-job",
      runId: run.id,
      status: "running",
      result: {
        trackedEnvKeys: ["TEST_VAR"],
      },
    });

    const finished = await store.updateToolJob(created.id, {
      status: "completed",
      finishedAt: created.startedAt + 250,
      durationMs: 250,
      result: {
        command: "sleep 1 && printf hi",
        mode: "local",
        initialCwd: "/workspace",
        finalCwd: "/workspace/nested",
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
      },
    });

    expect(finished).toMatchObject({
      status: "completed",
      result: {
        finalCwd: "/workspace/nested",
        stdout: "hello",
        stdoutPersisted: true,
        stdoutPath: "/tmp/stdout.txt",
      },
    });
    expect(await store.getToolJob(created.id)).toMatchObject({
      status: "completed",
      result: {
        stdout: "hello",
      },
    });
    expect(await store.listToolJobs("pg-thread-bash-job")).toHaveLength(1);
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
    });
    const created = await store.createToolJob({
      id: "00000000-0000-4000-8000-000000000002",
      threadId: "pg-thread-lost-job",
      kind: "bash",
      summary: "sleep 5",
    });

    expect(await store.markRunningToolJobsLost("runtime restarted")).toBe(1);

    const lost = await store.getToolJob(created.id);
    expect(lost.status).toBe("lost");
    expect(lost.statusReason).toBe("runtime restarted");
    expect(lost.finishedAt).toEqual(expect.any(Number));
  });

  it("rejects malformed running tool-job rows before startup loss recovery", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: "job-1",
        thread_id: "thread-1",
        started_at: "2026-05-01T12:00:00.000Z",
      }],
    }));
    const store = new PostgresThreadRuntimeStore({
      pool: createQueryOnlyThreadRuntimePool(query, "connect should not be used by loss recovery"),
    });

    await expect(store.markRunningToolJobsLost("runtime restarted")).rejects.toThrow(
      "Thread runtime tool job started_at must be a valid timestamp.",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported persisted input delivery modes", async () => {
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
      sessionId: "session-bad-input-mode",
      threadId: "pg-thread-bad-input-mode",
    });
    await store.createThread({
      id: "pg-thread-bad-input-mode",
      sessionId: "session-bad-input-mode",
    });
    await store.enqueueInput("pg-thread-bad-input-mode", {
      message: stringToUserMessage("bad mode"),
      source: "tui",
    });
    await pool.query(`
      UPDATE "runtime"."inputs"
      SET delivery_mode = 'sleep'
      WHERE thread_id = $1
    `, ["pg-thread-bad-input-mode"]);

    await expect(store.listPendingInputs("pg-thread-bad-input-mode")).rejects.toThrow(
      "Unsupported thread input delivery mode sleep",
    );
  });

  it("rejects unsupported persisted tool job statuses", async () => {
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
      sessionId: "session-bad-tool-status",
      threadId: "pg-thread-bad-tool-status",
    });
    await store.createThread({
      id: "pg-thread-bad-tool-status",
      sessionId: "session-bad-tool-status",
    });
    const job = await store.createToolJob({
      id: "00000000-0000-4000-8000-000000000003",
      threadId: "pg-thread-bad-tool-status",
      kind: "bash",
      summary: "sleep 5",
    });
    await pool.query(`
      UPDATE "runtime"."tool_jobs"
      SET status = 'ghost'
      WHERE id = $1
    `, [job.id]);

    await expect(store.getToolJob(job.id)).rejects.toThrow("Unsupported thread tool job status ghost");
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
    })).rejects.toThrow("Thread pg-thread-missing-session is missing sessionId.");
  });

  it("parses pg bigint runtime counters without coercing scalar columns", () => {
    const message = stringToUserMessage("hello");
    const messageRow = {
      id: "message-1",
      thread_id: "thread-1",
      sequence: "42",
      origin: "input",
      message,
      metadata: null,
      source: "user",
      channel_id: null,
      external_message_id: null,
      actor_id: null,
      identity_id: null,
      run_id: null,
      created_at: new Date(1),
    };
    expect(parseMessageRow(messageRow)).toMatchObject({
      sequence: 42,
    });
    expect(() => parseMessageRow({
      ...messageRow,
      message: {role: "system"},
    })).toThrow("Thread runtime message has unsupported role system.");
    expect(parseInputRow({
      id: "input-1",
      thread_id: "thread-1",
      input_order: "7",
      delivery_mode: "wake",
      message,
      metadata: null,
      source: "user",
      channel_id: null,
      external_message_id: null,
      actor_id: null,
      identity_id: null,
      created_at: new Date(1),
      applied_at: null,
    })).toMatchObject({
      order: 7,
    });
    expect(parseToolJobRow({
      id: "job-1",
      thread_id: "thread-1",
      run_id: null,
      kind: "bash",
      status: "completed",
      summary: null,
      started_at: new Date(1),
      finished_at: null,
      duration_ms: "123",
      result: null,
      error: null,
      status_reason: null,
      progress: null,
    })).toMatchObject({
      durationMs: 123,
    });

    expect(() => parseToolJobRow({
      id: "job-1",
      thread_id: "thread-1",
      run_id: null,
      kind: "bash",
      status: "completed",
      summary: {bad: true},
      started_at: new Date(1),
      finished_at: null,
      duration_ms: null,
      result: null,
      error: null,
      status_reason: null,
      progress: null,
    })).toThrow("Thread runtime tool job summary must be a string.");
  });
});
