import {describe, expect, it} from "vitest";

import {DrainLoop} from "../src/lib/drain-loop.js";
import {sleep, waitFor} from "./helpers/wait-for.js";

function deferred(): {promise: Promise<void>; resolve(): void} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

describe("DrainLoop", () => {
  it("coalesces concurrent triggers into one follow-up drain", async () => {
    const firstDrain = deferred();
    let drainCount = 0;
    const loop = new DrainLoop({
      label: "test drain",
      async drain() {
        drainCount += 1;
        if (drainCount === 1) {
          await firstDrain.promise;
        }
      },
    });

    loop.start();
    await waitFor(() => {
      expect(drainCount).toBe(1);
    });

    const firstTrigger = loop.trigger();
    const secondTrigger = loop.trigger();
    expect(drainCount).toBe(1);

    firstDrain.resolve();
    await Promise.all([firstTrigger, secondTrigger]);

    expect(drainCount).toBe(2);
    await loop.stop();
  });

  it("waits for the active drain and suppresses pending reruns on stop", async () => {
    const firstDrain = deferred();
    let drainCount = 0;
    const loop = new DrainLoop({
      label: "test drain",
      async drain() {
        drainCount += 1;
        if (drainCount === 1) {
          await firstDrain.promise;
        }
      },
    });

    loop.start();
    await waitFor(() => {
      expect(drainCount).toBe(1);
    });
    const pendingTrigger = loop.trigger();

    const stopped = loop.stop();
    firstDrain.resolve();
    await Promise.all([pendingTrigger, stopped]);
    await sleep(20);

    expect(drainCount).toBe(1);
    expect(loop.isStopped).toBe(true);
  });
});
