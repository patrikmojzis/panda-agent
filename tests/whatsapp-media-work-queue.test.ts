import {describe, expect, it, vi} from "vitest";

import {
  WhatsAppMediaPolicyError,
  WhatsAppMediaWorkQueue,
} from "../src/integrations/channels/whatsapp/media-work-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return {promise, resolve};
}

describe("WhatsApp media work queue", () => {
  it("bounds active and waiting media across callers", async () => {
    const queue = new WhatsAppMediaWorkQueue({concurrency: 2, queueMax: 1});
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let maxActive = 0;
    const run = (index: number) => queue.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gates[index]!.promise;
      active -= 1;
      return index;
    });

    const first = run(0);
    const second = run(1);
    const third = run(2);
    await expect(run(2)).rejects.toMatchObject({reason: "media_queue_full"});
    expect(queue.snapshot()).toEqual({active: 2, queued: 1, rejected: 1});

    gates[0]!.resolve();
    await expect(first).resolves.toBe(0);
    await vi.waitFor(() => expect(queue.snapshot().active).toBe(2));
    gates[1]!.resolve();
    gates[2]!.resolve();
    await expect(Promise.all([second, third])).resolves.toEqual([1, 2]);
    expect(maxActive).toBe(2);
    await queue.close();
  });

  it("removes aborted queued work without consuming a permit", async () => {
    const queue = new WhatsAppMediaWorkQueue({concurrency: 1, queueMax: 1});
    const gate = deferred();
    const active = queue.run(async () => gate.promise);
    const controller = new AbortController();
    const queued = queue.run(async () => undefined, {signal: controller.signal});

    controller.abort();
    await expect(queued).rejects.toMatchObject({reason: "media_aborted"});
    expect(queue.snapshot().queued).toBe(0);
    gate.resolve();
    await active;
    await queue.close();
  });

  it("close aborts active work and rejects new work", async () => {
    const queue = new WhatsAppMediaWorkQueue({concurrency: 1, queueMax: 1});
    const active = queue.run(async (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    }));

    const closing = queue.close();
    await expect(active).rejects.toBeInstanceOf(WhatsAppMediaPolicyError);
    await closing;
    await expect(queue.run(async () => undefined)).rejects.toMatchObject({reason: "media_aborted"});
  });

  it("single-flights concurrent redelivery of the same media event", async () => {
    const queue = new WhatsAppMediaWorkQueue({concurrency: 2, queueMax: 2});
    const gate = deferred();
    const task = vi.fn(async () => {
      await gate.promise;
      return "stored";
    });

    const first = queue.run(task, {singleFlightKey: "whatsapp_message:request-1"});
    const duplicate = queue.run(task, {singleFlightKey: "whatsapp_message:request-1"});
    expect(task).toHaveBeenCalledOnce();
    gate.resolve();
    await expect(Promise.all([first, duplicate])).resolves.toEqual(["stored", "stored"]);
    expect(task).toHaveBeenCalledOnce();
    await queue.close();
  });
});
