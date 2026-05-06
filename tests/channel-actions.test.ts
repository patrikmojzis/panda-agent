import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import type {ChannelTypingRequest} from "../src/domain/channels/index.js";
import {ChannelActionWorker, PostgresChannelActionStore,} from "../src/domain/channels/actions/index.js";
import type {
    ActionNotification,
    ActionWorkerLookup,
    ChannelActionInput,
    ChannelActionRecord,
} from "../src/domain/channels/actions/types.js";

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

    expect(client.off).toHaveBeenCalledTimes(1);
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
    await store.ensureSchema();

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

    const sent = await store.markActionSent(action.id);
    expect(sent).toMatchObject({
      id: action.id,
      status: "sent",
    });
  });

  it("marks abandoned sending actions as failed", async () => {
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
    await store.ensureSchema();

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
    const recovered = await store.failSendingActions({
      channel: "telegram",
      connectorKey: "bot-1",
    }, "worker died");

    expect(recovered).toBe(1);

    const rows = await pool.query(
      `SELECT status, last_error FROM "runtime"."channel_actions" WHERE id = $1`,
      [action.id],
    );
    expect(rows.rows[0]).toMatchObject({
      status: "failed",
      last_error: "worker died",
    });
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

      if (text.includes("FOR UPDATE SKIP LOCKED")) {
        expect(values).toEqual(["telegram", "bot-1"]);
        throw parserError;
      }

      if (text.includes("FOR UPDATE")) {
        expect(values).toEqual(["telegram", "bot-1"]);
        return {rows: [pendingRow]};
      }

      if (text.includes("RETURNING *")) {
        expect(values).toEqual(["action-1"]);
        return {rows: [sendingRow]};
      }

      throw new Error(`Unexpected query in test: ${text}`);
    });

    const release = vi.fn();
    const client = {
      query,
      release,
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
    };

    const store = new PostgresChannelActionStore({pool: pool as any});
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
      createdAt: this.counter,
      updatedAt: this.counter,
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
    action.attemptCount += 1;
    return action;
  }

  async markActionSent(id: string): Promise<ChannelActionRecord> {
    const action = this.getAction(id);
    action.status = "sent";
    return action;
  }

  async markActionFailed(id: string, error: string): Promise<ChannelActionRecord> {
    const action = this.getAction(id);
    action.status = "failed";
    action.lastError = error;
    return action;
  }

  async failSendingActions(lookup: ActionWorkerLookup, error: string): Promise<number> {
    let count = 0;
    for (const action of this.actions) {
      if (
        action.status === "sending"
        && action.channel === lookup.channel
        && action.connectorKey === lookup.connectorKey
      ) {
        action.status = "failed";
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

  private getAction(id: string): ChannelActionRecord {
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
    await worker.stop();

    expect(dispatch).toHaveBeenCalledTimes(1);
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
    await worker.stop();

    expect(dispatch).toHaveBeenCalledTimes(1);
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
    await worker.stop();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(store.listener).toBeNull();
  });
});
