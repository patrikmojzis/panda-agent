import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import type {ChannelTypingRequest} from "../src/domain/channels/index.js";
import {ChannelActionWorker, parseActionNotification, PostgresChannelActionStore,} from "../src/domain/channels/actions/index.js";
import {ensurePostgresChannelActionSchema} from "../src/domain/channels/actions/postgres-schema.js";
import type {
    ActionNotification,
    ActionWorkerLookup,
    ChannelActionInput,
    ChannelActionRecord,
} from "../src/domain/channels/actions/types.js";
import {waitFor} from "./helpers/wait-for.js";

type ChannelActionPool = ConstructorParameters<typeof PostgresChannelActionStore>[0]["pool"];
type ChannelActionClient = Awaited<ReturnType<ChannelActionPool["connect"]>>;

function createTypingPayload(channel: string, connectorKey: string): ChannelTypingRequest {
  return {
    channel,
    target: {
      source: channel,
      connectorKey,
      externalConversationId: "chat-1",
    },
    phase: "start",
  };
}

describe("PostgresChannelActionStore", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  function persistedActionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "action-1",
      channel: "telegram",
      connector_key: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
      status: "pending",
      attempt_count: 0,
      last_error: null,
      claimed_at: null,
      completed_at: null,
      created_at: new Date(1),
      updated_at: new Date(1),
      ...overrides,
    };
  }

  it("parses only valid pending-action notifications", () => {
    expect(parseActionNotification(JSON.stringify({
      channel: " telegram ",
      connectorKey: " bot-1 ",
    }))).toEqual({
      channel: "telegram",
      connectorKey: "bot-1",
    });
    expect(parseActionNotification(JSON.stringify({
      channel: "",
      connectorKey: "bot-1",
    }))).toBeNull();
    expect(parseActionNotification(JSON.stringify([]))).toBeNull();
  });

  it("uses the notification pool for LISTEN clients", async () => {
    const queryPool = {
      connect: vi.fn(async () => {
        throw new Error("query pool should not be used for LISTEN");
      }),
      query: vi.fn(async () => ({rows: []})),
    };
    const client = {
      off: vi.fn(),
      on: vi.fn(),
      query: vi.fn(async () => ({rows: []})),
      release: vi.fn(),
    };
    const notificationPool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({rows: []})),
    };
    const store = new PostgresChannelActionStore({
      pool: queryPool,
      notificationPool,
    });

    const unsubscribe = await store.listenPendingActions(() => {});
    await unsubscribe();

    expect(queryPool.connect).not.toHaveBeenCalled();
    expect(notificationPool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "LISTEN runtime_channel_action_events");
    expect(client.query).toHaveBeenNthCalledWith(2, "UNLISTEN runtime_channel_action_events");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("releases the notification client when LISTEN setup fails", async () => {
    const queryPool = {
      connect: vi.fn(async () => {
        throw new Error("query pool should not be used for LISTEN");
      }),
      query: vi.fn(async () => ({rows: []})),
    };
    const client = {
      off: vi.fn(),
      on: vi.fn(),
      query: vi.fn(async () => ({rows: []})),
      release: vi.fn(),
    };
    client.query.mockRejectedValueOnce(new Error("listen blew up"));
    const store = new PostgresChannelActionStore({
      pool: queryPool,
      notificationPool: {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => ({rows: []})),
      },
    });

    await expect(store.listenPendingActions(() => {})).rejects.toThrow("listen blew up");

    expect(client.off).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("enqueues, claims, and completes actions", async () => {
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

    const store = new PostgresChannelActionStore({pool});
    await ensurePostgresChannelActionSchema(pool);

    const action = await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
    });

    expect(action.status).toBe("pending");

    const claimed = await store.claimNextPendingAction({
      channel: "telegram",
      connectorKey: "bot-1",
    });
    expect(claimed).toMatchObject({
      id: action.id,
      status: "sending",
      attemptCount: 1,
    });

    const sent = await store.markActionSent(action.id, claimed!.claimToken!);
    expect(sent).toMatchObject({
      id: action.id,
      status: "sent",
    });
  });

  it("persists deadlines and terminalizes already-expired actions without an attempt", async () => {
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

    const store = new PostgresChannelActionStore({pool});
    await ensurePostgresChannelActionSchema(pool);
    const futureExpiry = Date.now() + 60_000;
    const pending = await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
      expiresAt: futureExpiry,
    });
    const expired = await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
      expiresAt: Date.now() - 1,
    });

    expect(pending).toMatchObject({status: "pending", expiresAt: futureExpiry});
    expect(expired).toMatchObject({
      status: "expired",
      attemptCount: 0,
      lastError: "Action expired before dispatch.",
      completedAt: expect.any(Number),
    });
    await expect(store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
      expiresAt: Number.NaN,
    })).rejects.toThrow("Channel action expiresAt must be a finite timestamp.");
  });

  it("expires a stale head row and continues to the next dispatchable action", async () => {
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

    const store = new PostgresChannelActionStore({pool});
    await ensurePostgresChannelActionSchema(pool);
    await pool.query(`
      INSERT INTO "runtime"."channel_actions" (
        id, channel, connector_key, kind, payload, status, expires_at, created_at
      ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        'telegram',
        'bot-1',
        'typing',
        $1::jsonb,
        'pending',
        NOW() - INTERVAL '1 second',
        NOW() - INTERVAL '2 seconds'
      )
    `, [JSON.stringify(createTypingPayload("telegram", "bot-1"))]);
    const valid = await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_reaction",
      payload: {conversationId: "chat-1", messageId: "message-1", emoji: "👍"},
    });

    await expect(store.claimNextPendingAction({
      channel: "telegram",
      connectorKey: "bot-1",
    })).resolves.toMatchObject({id: valid.id, status: "sending", attemptCount: 1});
    await expect(pool.query(`
      SELECT status, attempt_count, last_error
      FROM "runtime"."channel_actions"
      WHERE id = '00000000-0000-0000-0000-000000000001'
    `)).resolves.toMatchObject({rows: [{
      status: "expired",
      attempt_count: 0,
      last_error: "Action expired before dispatch.",
    }]});
  });

  it("round-trips telegram reaction payloads through persisted actions", async () => {
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

    const store = new PostgresChannelActionStore({pool});
    await ensurePostgresChannelActionSchema(pool);

    const action = await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_reaction",
      payload: {
        conversationId: "chat-1",
        messageId: "message-1",
        emoji: "react",
        remove: false,
      },
    });

    const claimed = await store.claimNextPendingAction({
      channel: "telegram",
      connectorKey: "bot-1",
    });

    expect(claimed).toMatchObject({
      id: action.id,
      kind: "telegram_reaction",
      status: "sending",
      payload: {
        conversationId: "chat-1",
        messageId: "message-1",
        emoji: "react",
        remove: false,
      },
    });
  });

  it.each<ChannelActionInput>([
    {
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_edit",
      payload: {
        conversationId: "chat-1",
        messageId: "message-1",
        text: "updated",
      },
    },
    {
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_delete",
      payload: {
        conversationId: "chat-1",
        messageId: "message-1",
      },
    },
    {
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_pin",
      payload: {
        conversationId: "chat-1",
        messageId: "message-1",
        silent: true,
      },
    },
    {
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_unpin",
      payload: {
        conversationId: "chat-1",
        messageId: "message-1",
      },
    },
    {
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_sticker_send",
      payload: {
        conversationId: "chat-1",
        sticker: {
          type: "file_id",
          fileId: "sticker-file-id",
        },
      },
    },
    {
      channel: "discord",
      connectorKey: "discord-bot-1",
      kind: "discord_sticker_send",
      payload: {
        parentChannelId: "12345",
        threadId: "23456",
        guildId: "34567",
        replyToMessageId: "45678",
        stickerIds: ["56789", "67890"],
      },
    },
  ])("round-trips $kind payloads through persisted actions", async (input) => {
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

    const store = new PostgresChannelActionStore({pool});
    await ensurePostgresChannelActionSchema(pool);

    const action = await store.enqueueAction(input);
    const claimed = await store.claimNextPendingAction({
      channel: input.channel,
      connectorKey: input.connectorKey,
    });

    expect(claimed).toMatchObject({
      id: action.id,
      kind: input.kind,
      status: "sending",
      payload: input.payload,
    });
  });

  it("rejects malformed persisted action payloads before claiming them", async () => {
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

    const store = new PostgresChannelActionStore({pool});
    await ensurePostgresChannelActionSchema(pool);
    await pool.query(`
      INSERT INTO "runtime"."channel_actions" (
        id,
        channel,
        connector_key,
        kind,
        payload,
        status
      ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        'telegram',
        'bot-1',
        'typing',
        $1::jsonb,
        'pending'
      )
    `, [
      JSON.stringify({
        channel: "telegram",
        phase: "start",
        target: {
          source: "telegram",
          connectorKey: "bot-1",
        },
      }),
    ]);

    await expect(store.claimNextPendingAction({
      channel: "telegram",
      connectorKey: "bot-1",
    })).rejects.toThrow("Channel action typing payload target conversation id must not be empty.");

    const rows = await pool.query(
      `SELECT status, attempt_count FROM "runtime"."channel_actions" WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    expect(rows.rows[0]).toMatchObject({
      status: "pending",
      attempt_count: 0,
    });
  });

  it("rejects malformed persisted action identity fields", async () => {
    const store = new PostgresChannelActionStore({
      pool: {
        query: vi.fn(async () => ({
          rows: [persistedActionRow({connector_key: ""})],
        })),
        connect: vi.fn(),
      },
    });

    await expect(store.markActionSent("action-1", "claim-1")).rejects.toThrow(
      "Channel action connector key must not be empty.",
    );
  });

  it("rejects malformed persisted action counters and timestamps", async () => {
    const badCount = new PostgresChannelActionStore({
      pool: {
        query: vi.fn(async () => ({
          rows: [persistedActionRow({attempt_count: "many"})],
        })),
        connect: vi.fn(),
      },
    });
    await expect(badCount.markActionSent("action-1", "claim-1")).rejects.toThrow(
      "Channel action attempt count must be a non-negative integer.",
    );

    const badTimestamp = new PostgresChannelActionStore({
      pool: {
        query: vi.fn(async () => ({
          rows: [persistedActionRow({updated_at: "eventually"})],
        })),
        connect: vi.fn(),
      },
    });
    await expect(badTimestamp.markActionSent("action-1", "claim-1")).rejects.toThrow(
      "Channel action updated_at must be a finite timestamp.",
    );

    const badExpiry = new PostgresChannelActionStore({
      pool: {
        query: vi.fn(async () => ({
          rows: [persistedActionRow({expires_at: "eventually"})],
        })),
        connect: vi.fn(),
      },
    });
    await expect(badExpiry.markActionSent("action-1", "claim-1")).rejects.toThrow(
      "Channel action expires_at must be a finite timestamp.",
    );
  });

  it("preserves abandoned sending actions as unknown outcomes", async () => {
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

    const store = new PostgresChannelActionStore({pool});
    await ensurePostgresChannelActionSchema(pool);

    const action = await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
    });

    await store.claimNextPendingAction({
      channel: "telegram",
      connectorKey: "bot-1",
    });
    const recovered = await store.markSendingActionsUnknown({
      channel: "telegram",
      connectorKey: "bot-1",
    }, "worker died");

    expect(recovered).toBe(1);

    const rows = await pool.query(
      `SELECT status, last_error FROM "runtime"."channel_actions" WHERE id = $1`,
      [action.id],
    );
    expect(rows.rows[0]).toMatchObject({
      status: "unknown",
      last_error: "worker died",
    });
  });

  it("keeps idle reconciliation to one indexed query without a pool checkout", async () => {
    const query = vi.fn(async () => ({rows: []}));
    const connect = vi.fn();
    const store = new PostgresChannelActionStore({pool: {query, connect}});

    await expect(store.claimNextPendingAction({
      channel: "telegram",
      connectorKey: "bot-1",
    })).resolves.toBeNull();

    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toContain("status = 'pending'");
    expect(connect).not.toHaveBeenCalled();
  });

  it("prefers SKIP LOCKED and falls back only for parser-limited adapters", async () => {
    const parserError = new Error("Unexpected kw_skip token: \"skip\"");
    const pendingRow = {
      id: "action-1",
      channel: "telegram",
      connector_key: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
      status: "pending",
      attempt_count: 0,
      last_error: null,
      claimed_at: null,
      completed_at: null,
      expires_at: null,
      created_at: new Date(1),
      updated_at: new Date(1),
    } as const;
    const sendingRow = {
      ...pendingRow,
      status: "sending",
      attempt_count: 1,
      claimed_at: new Date(2),
      updated_at: new Date(2),
    } as const;

    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return {rows: []};
      }

      if (text.includes("SELECT id, session_id")) {
        expect(values).toEqual(["telegram", "bot-1"]);
        return {rows: [{id: "action-1", session_id: null, deadline_expired: false}]};
      }

      if (text.includes("FOR UPDATE SKIP LOCKED")) {
        expect(values).toEqual(["action-1"]);
        throw parserError;
      }

      if (text.includes("FOR UPDATE")) {
        expect(values).toEqual(["action-1"]);
        return {rows: [pendingRow]};
      }

      if (text.includes("RETURNING *")) {
        expect(values).toEqual(["action-1", expect.stringMatching(/^[0-9a-f-]{36}$/)]);
        return {rows: [{...sendingRow, claim_token: values?.[1]}]};
      }

      throw new Error(`Unexpected query in test: ${text}`);
    });

    const release = vi.fn();
    const client: ChannelActionClient = {
      query,
      release,
      on() {
        return this;
      },
      off() {
        return this;
      },
    };
    const pool: ChannelActionPool = {
      query: vi.fn(async () => ({rows: [{exists: 1}]})),
      connect: vi.fn(async () => client),
    };

    const store = new PostgresChannelActionStore({pool});
    const claimed = await store.claimNextPendingAction({
      channel: "telegram",
      connectorKey: "bot-1",
    });

    expect(claimed).toMatchObject({
      id: "action-1",
      status: "sending",
      attemptCount: 1,
    });
    expect(query.mock.calls.some(([text]) => String(text).includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("FOR UPDATE\n") && !String(text).includes("SKIP LOCKED"))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

class MemoryActionStore {
  actions: ChannelActionRecord[] = [];
  listener: ((notification: ActionNotification) => Promise<void> | void) | null = null;
  counter = 0;

  async enqueueAction(input: ChannelActionInput): Promise<ChannelActionRecord> {
    this.counter += 1;
    const action: ChannelActionRecord = {
      id: `action-${this.counter}`,
      status: "pending",
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...input,
    };
    this.actions.push(action);
    await this.listener?.({
      channel: input.channel,
      connectorKey: input.connectorKey,
    });
    return action;
  }

  async claimNextPendingAction(lookup: ActionWorkerLookup): Promise<ChannelActionRecord | null> {
    const action = this.actions.find((candidate) =>
      candidate.status === "pending"
      && candidate.channel === lookup.channel
      && candidate.connectorKey === lookup.connectorKey);
    if (!action) {
      return null;
    }

    action.status = "sending";
    action.claimToken = `claim-${action.id}`;
    action.attemptCount += 1;
    return action;
  }

  async markActionSent(id: string, _claimToken: string): Promise<ChannelActionRecord> {
    const action = await this.getAction(id);
    action.status = "sent";
    return action;
  }

  async markActionFailed(id: string, _claimToken: string, error: string): Promise<ChannelActionRecord> {
    const action = await this.getAction(id);
    action.status = "failed";
    action.lastError = error;
    return action;
  }

  async expireActionIfDue(id: string, _claimToken: string): Promise<ChannelActionRecord | null> {
    const action = await this.getAction(id);
    if (action.expiresAt === undefined || action.expiresAt > Date.now()) return null;
    action.status = "expired";
    action.attemptCount = Math.max(0, action.attemptCount - 1);
    action.lastError = "Action expired before dispatch.";
    return action;
  }

  async markActionUnknown(id: string, claimToken: string, error: string): Promise<ChannelActionRecord> {
    const action = await this.getAction(id);
    if (action.status === "sending" && action.claimToken === claimToken) {
      action.status = "unknown";
      action.lastError = error;
    }
    return action;
  }

  async markSendingActionsUnknown(lookup: ActionWorkerLookup, error: string): Promise<number> {
    let count = 0;
    for (const action of this.actions) {
      if (
        action.status === "sending"
        && action.channel === lookup.channel
        && action.connectorKey === lookup.connectorKey
      ) {
        action.status = "unknown";
        action.lastError = error;
        count += 1;
      }
    }

    return count;
  }

  async listenPendingActions(
    listener: (notification: ActionNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    this.listener = listener;
    return async () => {
      this.listener = null;
    };
  }

  async getAction(id: string): Promise<ChannelActionRecord> {
    const action = this.actions.find((candidate) => candidate.id === id);
    if (!action) {
      throw new Error(`Unknown action ${id}`);
    }

    return action;
  }
}

describe("ChannelActionWorker", () => {
  it("drains pending backlog on startup", async () => {
    const store = new MemoryActionStore();
    await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
    });

    const dispatch = vi.fn(async () => {});
    const worker = new ChannelActionWorker({
      store,
      lookup: {
        channel: "telegram",
        connectorKey: "bot-1",
      },
      dispatch,
    });

    await worker.start();
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    await worker.stop();

    expect(store.actions[0]).toMatchObject({
      status: "sent",
      attemptCount: 1,
    });
  });

  it("marks failures without retrying automatically", async () => {
    const store = new MemoryActionStore();
    await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
    });

    const dispatch = vi.fn(async () => {
      throw new Error("connector unavailable");
    });
    const worker = new ChannelActionWorker({
      store,
      lookup: {
        channel: "telegram",
        connectorKey: "bot-1",
      },
      dispatch,
    });

    await worker.start();
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    await worker.stop();

    expect(store.actions[0]).toMatchObject({
      status: "failed",
      lastError: "connector unavailable",
      attemptCount: 1,
    });
  });

  it("can start without owning the notification subscription", async () => {
    const store = new MemoryActionStore();
    await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
    });

    const dispatch = vi.fn(async () => {});
    const worker = new ChannelActionWorker({
      store,
      lookup: {
        channel: "telegram",
        connectorKey: "bot-1",
      },
      dispatch,
    });

    await worker.start({
      subscribeToNotifications: false,
    });
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    await worker.stop();

    expect(store.listener).toBeNull();
  });

  it("recovers a durable action by polling when no notification is delivered", async () => {
    const store = new MemoryActionStore();
    const dispatch = vi.fn(async () => {});
    const onEvent = vi.fn();
    const worker = new ChannelActionWorker({
      store,
      lookup: {channel: "telegram", connectorKey: "bot-1"},
      dispatch,
      onEvent,
      pollIntervalMs: 10,
    });

    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain("startup");
    const action = await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_reaction",
      payload: {conversationId: "chat-1", messageId: "message-1", emoji: "👍"},
    });
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await worker.stop();

    expect(store.actions[0]).toMatchObject({id: action.id, status: "sent", attemptCount: 1});
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "recovered_by_poll",
      action: expect.objectContaining({id: action.id}),
      cause: "poll",
    }));
  });

  it("expires a claimed action at the last responsible moment without connector dispatch", async () => {
    const store = new MemoryActionStore();
    await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "typing",
      payload: createTypingPayload("telegram", "bot-1"),
      expiresAt: 999,
    });
    const dispatch = vi.fn(async () => {});
    const onEvent = vi.fn();
    const worker = new ChannelActionWorker({
      store,
      lookup: {channel: "telegram", connectorKey: "bot-1"},
      dispatch,
      onEvent,
    });

    await worker.start();
    await waitFor(() => expect(store.actions[0]?.status).toBe("expired"));
    await worker.stop();

    expect(dispatch).not.toHaveBeenCalled();
    expect(store.actions[0]).toMatchObject({
      status: "expired",
      attemptCount: 0,
      lastError: "Action expired before dispatch.",
    });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "expired_before_dispatch",
      cause: "startup",
    }));
  });

  it("coalesces overlapping notification and poll wakes into one dispatch", async () => {
    const store = new MemoryActionStore();
    const dispatch = vi.fn(async () => {});
    const worker = new ChannelActionWorker({
      store,
      lookup: {channel: "telegram", connectorKey: "bot-1"},
      dispatch,
      pollIntervalMs: 60_000,
    });

    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain("startup");
    await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_reaction",
      payload: {conversationId: "chat-1", messageId: "message-1", emoji: "👍"},
    });
    await Promise.all([
      worker.triggerDrain("notification"),
      worker.triggerDrain("poll"),
    ]);
    await worker.stop();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(store.actions[0]).toMatchObject({status: "sent", attemptCount: 1});
  });

  it("cancels future polling after stop", async () => {
    const store = new MemoryActionStore();
    const dispatch = vi.fn(async () => {});
    const worker = new ChannelActionWorker({
      store,
      lookup: {channel: "telegram", connectorKey: "bot-1"},
      dispatch,
      pollIntervalMs: 10,
    });

    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain("startup");
    await worker.stop();
    await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_reaction",
      payload: {conversationId: "chat-1", messageId: "message-1", emoji: "👍"},
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(dispatch).not.toHaveBeenCalled();
    expect(store.actions[0]?.status).toBe("pending");
  });

  it("waits for an in-flight dispatch before stopping", async () => {
    const store = new MemoryActionStore();
    await store.enqueueAction({
      channel: "telegram",
      connectorKey: "bot-1",
      kind: "telegram_reaction",
      payload: {conversationId: "chat-1", messageId: "message-1", emoji: "👍"},
    });
    let releaseDispatch!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const dispatch = vi.fn(async () => dispatchStarted);
    const worker = new ChannelActionWorker({
      store,
      lookup: {channel: "telegram", connectorKey: "bot-1"},
      dispatch,
    });

    await worker.start();
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseDispatch();
    await stopping;

    expect(store.actions[0]?.status).toBe("sent");
  });
});

describe("action receipt settlement", () => {
  async function prepare() {
    const store = new MemoryActionStore();
    const action = await store.enqueueAction({
      channel: "telegram", connectorKey: "bot", kind: "telegram_reaction",
      payload: {conversationId: "chat", messageId: "message", emoji: "✅"},
    });
    const dispatch = vi.fn(async () => {});
    const onError = vi.fn();
    const options = {store, lookup: {channel: "telegram", connectorKey: "bot"}, dispatch, onError};
    return {store, action, dispatch, onError, options};
  }

  it.each(["write rejected", "acknowledgement lost"] as const)("settles one dispatch when its receipt %s", async (mode) => {
    const h = await prepare();
    const write = h.store.markActionSent.bind(h.store);
    vi.spyOn(h.store, "markActionSent").mockImplementationOnce(async (id, token) => {
      if (mode === "acknowledgement lost") await write(id, token);
      throw new Error("database response lost");
    });
    const worker = new ChannelActionWorker(h.options);
    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain();
    await worker.stop();
    expect(h.action).toMatchObject({status: "sent", attemptCount: 1});
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("preserves an unknown receipt through restart without dispatching again", async () => {
    const h = await prepare();
    vi.spyOn(h.store, "markActionSent").mockRejectedValue(new Error("receipt write unavailable"));
    const worker = new ChannelActionWorker(h.options);
    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain();
    await worker.stop();
    const restarted = new ChannelActionWorker(h.options);
    await restarted.start({subscribeToNotifications: false});
    await restarted.triggerDrain();
    await restarted.stop();
    expect(h.action).toMatchObject({status: "unknown", attemptCount: 1});
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining("sent receipt could not be confirmed")}), h.action.id);
  });

  it("does not call an interrupted sending action expired merely because its deadline passed", async () => {
    const h = await prepare();
    await h.store.claimNextPendingAction(h.options.lookup);
    h.action.expiresAt = Date.now() - 1;
    const worker = new ChannelActionWorker(h.options);
    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain();
    await worker.stop();
    expect(h.action).toMatchObject({status: "unknown", attemptCount: 1});
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
