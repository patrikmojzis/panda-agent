import {describe, expect, it, vi} from "vitest";

import type {RuntimeRequestRecord} from "../src/domain/threads/requests/index.js";
import {RuntimeRequestDrain} from "../src/app/runtime/request-drain.js";
import {sleep, waitFor} from "./helpers/wait-for.js";

function deferred(): {promise: Promise<void>; resolve(): void} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

function requestRecord(id: string): RuntimeRequestRecord {
  const now = Date.now();
  return {
    id,
    kind: "tui_input",
    status: "pending",
    payload: {
      actorId: "operator",
      externalMessageId: `message-${id}`,
      text: "hello",
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("RuntimeRequestDrain", () => {
  it("claims and completes pending runtime requests", async () => {
    const pending = [requestRecord("first"), requestRecord("second")];
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      processRequest: vi.fn(async (request) => ({processed: request.id})),
    });

    drain.start();

    await waitFor(() => {
      expect(requests.completeRequest).toHaveBeenCalledTimes(2);
    });
    await drain.stop();

    expect(requests.completeRequest).toHaveBeenNthCalledWith(1, "first", {processed: "first"});
    expect(requests.completeRequest).toHaveBeenNthCalledWith(2, "second", {processed: "second"});
    expect(requests.failRequest).not.toHaveBeenCalled();
  });

  it("marks failed requests and keeps draining the queue", async () => {
    const pending = [requestRecord("bad"), requestRecord("good")];
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      processRequest: vi.fn(async (request) => {
        if (request.id === "bad") {
          throw new Error("bad request");
        }

        return "ok";
      }),
    });

    drain.start();

    await waitFor(() => {
      expect(requests.failRequest).toHaveBeenCalledWith("bad", "bad request");
      expect(requests.completeRequest).toHaveBeenCalledWith("good", "ok");
    });
    await drain.stop();
  });

  it("waits for active work and does not claim more requests after stop", async () => {
    const active = deferred();
    const order: string[] = [];
    const pending = [requestRecord("first"), requestRecord("second")];
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      completeRequest: vi.fn(async (id: string) => {
        order.push(`complete-${id}`);
      }),
      failRequest: vi.fn(async () => undefined),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      processRequest: vi.fn(async (request) => {
        order.push(`process-start-${request.id}`);
        if (request.id === "first") {
          await active.promise;
        }
        order.push(`process-end-${request.id}`);
        return request.id;
      }),
    });

    drain.start();
    await waitFor(() => {
      expect(order).toEqual(["process-start-first"]);
    });

    const stopPromise = drain.stop();
    await sleep(20);
    expect(order).toEqual(["process-start-first"]);

    active.resolve();
    await stopPromise;
    await sleep(20);

    expect(order).toEqual([
      "process-start-first",
      "process-end-first",
      "complete-first",
    ]);
    expect(requests.claimNextPendingRequest).toHaveBeenCalledTimes(1);
    expect(requests.failRequest).not.toHaveBeenCalled();
  });
});
