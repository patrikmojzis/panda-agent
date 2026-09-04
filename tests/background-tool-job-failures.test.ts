import {setImmediate} from "node:timers/promises";
import {describe, expect, it} from "vitest";

import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import type {ThreadToolJobUpdate} from "../src/domain/threads/runtime/types.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

class DelayedJobStore extends TestThreadRuntimeStore {
  override async updateToolJob(id: string, update: ThreadToolJobUpdate) {
    // Model a database round trip: a rejected job must be handled before this returns.
    await setImmediate();
    return super.updateToolJob(id, update);
  }
}

describe("background tool job failures", () => {
  it("contains immediate rejection during startup persistence and continues serving jobs", async () => {
    const store = new DelayedJobStore();
    await store.createThread({id: "thread-1", sessionId: "session-main"});
    const run = await store.createRun("thread-1");
    const service = new BackgroundToolJobService({store});
    try {
      const failed = await service.start({
        threadId: "thread-1", runId: run.id, kind: "image_generate", summary: "bad reference",
        start: () => ({done: Promise.reject(new Error("Invalid reference image"))}),
      });
      expect(await service.wait("thread-1", failed.id, 1_000)).toMatchObject({
        status: "failed", error: "Invalid reference image",
      });

      const next = await service.start({
        threadId: "thread-1", runId: run.id, kind: "image_generate", summary: "valid reference",
        start: () => ({done: Promise.resolve({status: "completed", result: {image: "ready"}})}),
      });
      expect(await service.wait("thread-1", next.id, 1_000)).toMatchObject({
        status: "completed", result: {image: "ready"},
      });
    } finally {
      await service.close();
    }
  });
});
