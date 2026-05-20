import {EventEmitter} from "node:events";

import {describe, expect, it, vi} from "vitest";

import {
  listenPostgresChannel,
  startPostgresListener,
  type PostgresListenSnapshot,
} from "../src/lib/postgres-listen.js";
import type {PgListenClient, PgPoolLike} from "../src/lib/postgres-query.js";
import {waitFor} from "./helpers/wait-for.js";

class FakeListenClient extends EventEmitter {
  readonly query = vi.fn(async (_sql: string) => ({rows: []}));
  readonly release = vi.fn();
}

function asListenClient(client: FakeListenClient): PgListenClient {
  return client as unknown as PgListenClient;
}

function createPool(clients: FakeListenClient[]): PgPoolLike<PgListenClient> & {connect: ReturnType<typeof vi.fn>} {
  return {
    connect: vi.fn(async () => {
      const client = clients.shift();
      if (!client) {
        throw new Error("No fake LISTEN client available.");
      }

      return asListenClient(client);
    }),
    query: vi.fn(async () => ({rows: []})),
  };
}

describe("Postgres LISTEN helpers", () => {
  it("releases the client and rejects when initial LISTEN setup fails", async () => {
    const client = new FakeListenClient();
    client.query.mockRejectedValueOnce(new Error("listen failed"));
    const pool = createPool([client]);

    await expect(startPostgresListener({
      pool,
      label: "test listener",
      channels: [{
        channel: "runtime_events",
        label: "runtime callback",
        parse: () => true,
        listener: () => undefined,
      }],
    })).rejects.toThrow("listen failed");

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith("LISTEN runtime_events");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("routes parsed notifications and closes an active listener idempotently", async () => {
    const client = new FakeListenClient();
    const pool = createPool([client]);
    const received = vi.fn();

    const handle = await startPostgresListener({
      pool,
      label: "multi listener",
      channels: [
        {
          channel: "runtime_events",
          label: "runtime callback",
          parse: (payload) => payload ? JSON.parse(payload) as {id: string} : null,
          listener: received,
        },
        {
          channel: "channel_events",
          label: "channel callback",
          parse: (payload) => payload ? JSON.parse(payload) as {id: string} : null,
          listener: received,
        },
      ],
    });

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "LISTEN runtime_events");
    expect(client.query).toHaveBeenNthCalledWith(2, "LISTEN channel_events");
    expect(handle.getSnapshot()).toMatchObject({
      status: "listening",
      listening: true,
      channels: ["runtime_events", "channel_events"],
    });

    client.emit("notification", {
      channel: "runtime_events",
      payload: JSON.stringify({id: "runtime-1"}),
    });
    client.emit("notification", {
      channel: "channel_events",
      payload: JSON.stringify({id: "channel-1"}),
    });
    client.emit("notification", {
      channel: "ignored_events",
      payload: JSON.stringify({id: "ignored"}),
    });

    await waitFor(() => {
      expect(received).toHaveBeenCalledTimes(2);
    });
    expect(received).toHaveBeenNthCalledWith(1, {id: "runtime-1"});
    expect(received).toHaveBeenNthCalledWith(2, {id: "channel-1"});

    await handle.close();
    await handle.close();

    expect(client.query).toHaveBeenNthCalledWith(3, "UNLISTEN channel_events");
    expect(client.query).toHaveBeenNthCalledWith(4, "UNLISTEN runtime_events");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(handle.getSnapshot()).toMatchObject({
      status: "closed",
      listening: false,
    });
  });

  it("reports post-start errors, releases the old client, and reconnects all channels", async () => {
    const firstClient = new FakeListenClient();
    const secondClient = new FakeListenClient();
    const pool = createPool([firstClient, secondClient]);
    const stateChanges: PostgresListenSnapshot[] = [];
    const onError = vi.fn();

    const handle = await startPostgresListener({
      pool,
      label: "self-healing listener",
      reconnectDelayMs: 1,
      channels: [
        {
          channel: "runtime_events",
          label: "runtime callback",
          parse: () => true,
          listener: () => undefined,
        },
        {
          channel: "channel_events",
          label: "channel callback",
          parse: () => true,
          listener: () => undefined,
        },
      ],
      onError,
      onStateChange: (snapshot) => {
        stateChanges.push(snapshot);
      },
    });

    firstClient.emit("error", new Error("socket died"));

    await waitFor(() => {
      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(secondClient.query).toHaveBeenNthCalledWith(1, "LISTEN runtime_events");
      expect(secondClient.query).toHaveBeenNthCalledWith(2, "LISTEN channel_events");
    });
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({message: "socket died"}));
      expect(stateChanges.some((snapshot) => snapshot.status === "reconnecting" && !snapshot.listening)).toBe(true);
    });

    expect(firstClient.release).toHaveBeenCalledTimes(1);
    expect(handle.getSnapshot()).toMatchObject({
      status: "listening",
      listening: true,
      lastError: "socket died",
    });

    await handle.close();
    expect(secondClient.release).toHaveBeenCalledTimes(1);
  });

  it("handles end events like reconnectable listener loss", async () => {
    const firstClient = new FakeListenClient();
    const secondClient = new FakeListenClient();
    const pool = createPool([firstClient, secondClient]);

    const handle = await startPostgresListener({
      pool,
      label: "ending listener",
      reconnectDelayMs: 1,
      channels: [{
        channel: "runtime_events",
        label: "runtime callback",
        parse: () => true,
        listener: () => undefined,
      }],
    });

    firstClient.emit("end");

    await waitFor(() => {
      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(secondClient.query).toHaveBeenCalledWith("LISTEN runtime_events");
    });
    expect(firstClient.release).toHaveBeenCalledTimes(1);
    expect(handle.getSnapshot()).toMatchObject({
      status: "listening",
      listening: true,
      lastError: "Postgres LISTEN client ended.",
    });

    await handle.close();
  });

  it("cancels pending reconnect on close without releasing the dead client twice", async () => {
    const firstClient = new FakeListenClient();
    const secondClient = new FakeListenClient();
    const pool = createPool([firstClient, secondClient]);

    const handle = await startPostgresListener({
      pool,
      label: "closing listener",
      reconnectDelayMs: 50,
      channels: [{
        channel: "runtime_events",
        label: "runtime callback",
        parse: () => true,
        listener: () => undefined,
      }],
    });

    firstClient.emit("error", new Error("network gone"));
    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(firstClient.release).toHaveBeenCalledTimes(1);
    expect(secondClient.release).not.toHaveBeenCalled();
  });

  it("keeps listenPostgresChannel source-compatible for single-channel callers", async () => {
    const client = new FakeListenClient();
    const pool = createPool([client]);
    const listener = vi.fn();

    const close = await listenPostgresChannel({
      pool,
      channel: "runtime_events",
      label: "runtime callback",
      parse: (payload) => payload ?? null,
      listener,
    });

    client.emit("notification", {
      channel: "runtime_events",
      payload: "hello",
    });

    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith("hello");
    });
    await close();

    expect(client.query).toHaveBeenNthCalledWith(1, "LISTEN runtime_events");
    expect(client.query).toHaveBeenNthCalledWith(2, "UNLISTEN runtime_events");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
