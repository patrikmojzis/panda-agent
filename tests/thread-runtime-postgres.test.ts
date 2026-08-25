import {EventEmitter} from "node:events";

import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {stringToUserMessage} from "../src/index.js";
import {observePostgresPool} from "../src/app/runtime/database.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";
import type {ThreadMessageRecord} from "../src/domain/threads/runtime/types.js";
import {buildThreadRuntimeTableNames} from "../src/domain/threads/runtime/postgres-shared.js";
import {parseInputRow, parseMessageRow, parseToolJobRow,} from "../src/domain/threads/runtime/postgres-rows.js";
import {
    backfillWorkerMetadataFromLegacyThreadContext,
    buildThreadRuntimeSchemaSql,
    ensurePostgresThreadRuntimeSchema,
    migrateSessionRuntimeConfigFromThreadRows,
} from "../src/domain/threads/runtime/postgres-schema.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {
  seedAppliedThreadInput,
  seedPendingThreadInput,
  seedRuntimeMessage,
} from "./helpers/thread-runtime-fixtures.js";
import {
  serializeThreadRuntimeJsonb,
  THREAD_RUNTIME_JSONB_NUL_PLACEHOLDER,
} from "../src/domain/threads/runtime/postgres-jsonb-safety.js";

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

async function loadTranscriptHistory(
  store: PostgresThreadRuntimeStore,
  threadId: string,
) {
  const pages: ThreadMessageRecord[][] = [];
  let beforeSequence: number | undefined;
  do {
    const page = await store.listTranscriptPage(threadId, {
      beforeSequence,
      limit: 500,
    });
    pages.unshift([...page.records]);
    beforeSequence = page.nextBeforeSequence;
  } while (beforeSequence !== undefined);
  return pages.flat();
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

  it("loads only the newest run for refresh callers", async () => {
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      expect(text).toContain("ORDER BY started_at DESC");
      expect(text).toContain("LIMIT 1");
      expect(values).toEqual(["thread-latest-run"]);
      return {
        rows: [{
          id: "run-latest",
          thread_id: "thread-latest-run",
          owner_source: null,
          owner_key: null,
          owner_holder_id: null,
          status: "completed",
          started_at: new Date(2),
          finished_at: new Date(3),
          abort_requested_at: null,
          abort_reason: null,
          error: null,
        }],
      };
    });
    const store = new PostgresThreadRuntimeStore({
      pool: createQueryOnlyThreadRuntimePool(query, "getLatestRun must not acquire a client"),
    });

    await expect(store.getLatestRun("thread-latest-run")).resolves.toMatchObject({
      id: "run-latest",
      threadId: "thread-latest-run",
      status: "completed",
    });
    expect(query).toHaveBeenCalledOnce();
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
    const appliedMigrations = new Set<string>();
    let markerInsertCount = 0;
    let candidateSelectCount = 0;
    let updateCount = 0;
    const pool = createQueryOnlyThreadRuntimePool(async (text, values) => {
      if (text.includes("FROM") && text.includes("thread_runtime_migrations")) {
        return { rows: appliedMigrations.has(String(values?.[0])) ? [{ "?column?": 1 }] : [] };
      }

      if (text.includes("INSERT INTO") && text.includes("thread_runtime_migrations")) {
        markerInsertCount += 1;
        appliedMigrations.add(String(values?.[0]));
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
    await ensurePostgresThreadRuntimeSchema(pool);
    await ensurePostgresThreadRuntimeSchema(pool);

    expect(candidateSelectCount).toBe(1);
    expect(updateCount).toBe(1);
    expect(markerInsertCount).toBe(2);
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
      await ensurePostgresThreadRuntimeSchema(pool);
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

    const {agentStore, sessionStore, threadStore: store} = await createRuntimeStores(pool);
    await agentStore.bootstrapAgent({
      agentKey: "other-agent",
      displayName: "Other Agent",
    });
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

    const shellStatesTable = buildThreadRuntimeTableNames().shellStates;
    await pool.query(`
      INSERT INTO ${shellStatesTable} (
        session_id,
        thread_id,
        execution_environment_id,
        cwd,
        env,
        updated_at
      ) VALUES
        ('session-shell-state', 'thread-shell-state', 'default', '/workspace/default-old', '{"FOO":"old"}'::jsonb, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
        ('session-shell-state', 'thread-shell-state', 'env-one', '/workspace/env-one', '{"FOO":"env-one"}'::jsonb, TIMESTAMPTZ '2026-01-01 00:01:00+00'),
        ('session-shell-state', 'replacement-thread', 'default', '/workspace/default-new', '{"FOO":"new"}'::jsonb, TIMESTAMPTZ '2026-01-01 00:02:00+00'),
        ('other-shell-state', 'other-thread', 'default', '/workspace/other', '{"FOO":"other"}'::jsonb, TIMESTAMPTZ '2026-01-01 00:03:00+00')
    `);

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

  it("persists threads and session runtime configuration", async () => {
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

    const summaries = await store.listThreadSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries.find((summary) => summary.thread.id === "pg-thread")).toMatchObject({
      thread: {
        id: "pg-thread",
        sessionId: "session-alice",
      },
      messageCount: 0,
      pendingInputCount: 0,
    });
  });

  it("lists channel messages scoped by session and connector route metadata", async () => {
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
      agentKey: "other-agent",
      displayName: "Other Agent",
    });
    await sessionStore.createSession({
      id: "session-1",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "thread-1",
    });
    await sessionStore.createSession({
      id: "session-2",
      agentKey: "other-agent",
      kind: "main",
      currentThreadId: "thread-2",
    });
    await store.createThread({id: "thread-1", sessionId: "session-1"});
    await store.createThread({id: "thread-2", sessionId: "session-2"});

    await seedAppliedThreadInput(pool, {
      threadId: "thread-1",
      message: stringToUserMessage("visible"),
      source: "telegram",
      channelId: "chat-1",
      externalMessageId: "message-1",
      metadata: {
        route: {
          source: "telegram",
          connectorKey: "bot-1",
          externalConversationId: "chat-1",
        },
        telegram: {
          media: [
            {
              id: "media-1",
              source: "telegram",
              connectorKey: "bot-1",
              mimeType: "image/png",
              sizeBytes: 12,
              localPath: "/tmp/media-1.png",
              originalFilename: "photo.png",
              createdAt: 1_764_000_000_000,
            },
          ],
        },
      },
    });
    await seedAppliedThreadInput(pool, {
      threadId: "thread-2",
      message: stringToUserMessage("other session"),
      source: "telegram",
      channelId: "chat-1",
      externalMessageId: "message-2",
      metadata: {
        route: {
          source: "telegram",
          connectorKey: "bot-1",
          externalConversationId: "chat-1",
        },
      },
    });
    await seedAppliedThreadInput(pool, {
      threadId: "thread-1",
      message: stringToUserMessage("other connector"),
      source: "telegram",
      channelId: "chat-1",
      externalMessageId: "message-3",
      metadata: {
        route: {
          source: "telegram",
          connectorKey: "bot-2",
          externalConversationId: "chat-1",
        },
      },
    });
    await expect(store.listChannelMessages({
      sessionId: "session-1",
      source: "telegram",
      connectorKey: "bot-1",
      channelId: "chat-1",
      limit: 10,
    })).resolves.toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        source: "telegram",
        channelId: "chat-1",
        externalMessageId: "message-1",
      }),
    ]);

    await expect(store.findChannelMedia({
      sessionId: "session-1",
      source: "telegram",
      connectorKey: "bot-1",
      channelId: "chat-1",
      mediaId: "media-1",
    })).resolves.toMatchObject({
      message: {
        threadId: "thread-1",
        externalMessageId: "message-1",
      },
      media: {
        id: "media-1",
        localPath: "/tmp/media-1.png",
      },
    });
    await expect(store.findChannelMedia({
      sessionId: "session-2",
      source: "telegram",
      connectorKey: "bot-1",
      channelId: "chat-1",
      mediaId: "media-1",
    })).resolves.toBeNull();
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
    await seedRuntimeMessage(pool, {
      threadId: "pg-thread-bash-nul",
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
    });

    const [persisted] = await loadTranscriptHistory(store, "pg-thread-bash-nul");
    const message = persisted?.message as {details?: {stdout?: unknown; stderr?: unknown}} | undefined;
    expect(message?.details?.stdout).toBe("hello␀stdout");
    expect(message?.details?.stderr).toBe("warn␀stderr");
    expect(JSON.stringify(persisted?.message)).not.toContain("\\u0000");
  });

  it("sanitizes actual NULs before runtime JSONB persistence", () => {
    const inputMessage = stringToUserMessage(`hello${NUL}input`);
    const inputMetadata = {
      label: `meta${NUL}data`,
      nested: {
        [`key${NUL}name`]: `value${NUL}text`,
      },
    };
    const serialized = serializeThreadRuntimeJsonb({
      message: inputMessage,
      metadata: inputMetadata,
    });
    expect(JSON.parse(serialized.json)).toEqual({
      message: expect.objectContaining({content: `hello${NUL_PLACEHOLDER}input`}),
      metadata: {
      label: `meta${NUL_PLACEHOLDER}data`,
      nested: {
        [`key${NUL_PLACEHOLDER}name`]: `value${NUL_PLACEHOLDER}text`,
      },
      },
    });
    expect(serialized.nulCount).toBe(4);
    expect(inputMessage.content).toBe(`hello${NUL}input`);
    expect(inputMetadata.label).toBe(`meta${NUL}data`);
    expect(Object.keys(inputMetadata.nested)).toEqual([`key${NUL}name`]);
    expect(serialized.json).not.toContain("\\u0000");
    expect(serialized.json).not.toContain(NUL);
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
    db.public.registerFunction({
      name: "json_build_object",
      args: [DataType.text, DataType.text, DataType.text, DataType.text],
      returns: DataType.jsonb,
      implementation: (firstKey: string, firstValue: string, secondKey: string, secondValue: string) => ({
        [firstKey]: firstValue,
        [secondKey]: secondValue,
      }),
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

    await store.requestWake("pg-thread-pending-wake");
    const wakeState = await pool.query(`
      SELECT pending_wake_generation
      FROM "runtime"."session_runtime_config"
      WHERE session_id = 'session-pending-wake'
    `);
    expect(Number(wakeState.rows[0]?.pending_wake_generation)).toBe(2);

    await store.createThread({
      id: "pg-thread-after-reset",
      sessionId: "session-pending-wake",
      replacesThreadId: "pg-thread-pending-wake",
    });
    await pool.query(`
      UPDATE ${SESSION_TABLE}
      SET current_thread_id = 'pg-thread-after-reset'
      WHERE id = 'session-pending-wake'
    `);
    await expect(store.requestWake("pg-thread-pending-wake")).rejects.toThrow(
      "Unknown thread pg-thread-pending-wake",
    );
  });

  it("rejects malformed persisted tool-job timestamps", () => {
    expect(() => parseToolJobRow({
      id: "job-1",
      thread_id: "thread-1",
      run_id: null,
      parent_tool_call_id: null,
      command_ordinal: null,
      kind: "bash",
      status: "running",
      summary: "sleep 5",
      started_at: "2026-05-01T12:00:00.000Z",
      finished_at: null,
      duration_ms: null,
      result: null,
      error: null,
      status_reason: null,
      progress: null,
    })).toThrow(
      "Thread runtime tool job started_at must be a valid timestamp.",
    );
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
    await seedPendingThreadInput(pool, {
      threadId: "pg-thread-bad-input-mode",
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
    const jobId = "00000000-0000-4000-8000-000000000003";
    await pool.query(`
      INSERT INTO "runtime"."tool_jobs" (
        id,
        thread_id,
        kind,
        status,
        summary,
        started_at
      ) VALUES ($1, $2, 'bash', 'completed', 'sleep 5', NOW())
    `, [jobId, "pg-thread-bad-tool-status"]);
    await pool.query(`
      UPDATE "runtime"."tool_jobs"
      SET status = 'ghost'
      WHERE id = $1
    `, [jobId]);

    await expect(store.getToolJob(jobId)).rejects.toThrow("Unsupported thread tool job status ghost");
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
      connector_key: "",
      message,
      metadata: null,
      source: "user",
      channel_id: null,
      external_message_id: null,
      actor_id: null,
      identity_id: null,
      created_at: new Date(1),
      applied_at: null,
      applied_run_id: null,
      discarded_at: null,
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
