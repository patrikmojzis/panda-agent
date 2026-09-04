import {afterEach, describe, expect, it, vi} from "vitest";

import {Agent} from "../src/kernel/agent/agent.js";
import {Thread as CoreThread} from "../src/kernel/agent/thread.js";
import {ThreadRuntimeCoordinator as CoreThreadRuntimeCoordinator} from "../src/domain/threads/runtime/coordinator.js";
import {Thread} from "../src/app/sdk/agent.js";
import {ThreadRuntimeCoordinator} from "../src/app/sdk/thread-runtime.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

describe("configured SDK model defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the package Thread convenience constructor", () => {
    vi.stubEnv("DEFAULT_MODEL", "openai-codex/gpt-6-astra");

    const thread = new Thread({agent: new Agent({name: "test", instructions: "Test"})});

    expect(thread.model).toBe("openai-codex/gpt-6-astra");
    expect(thread).toBeInstanceOf(CoreThread);
  });

  it.each([CoreThread, Thread])("constructs %p with an explicit model despite invalid defaults", (Constructor) => {
    vi.stubEnv("DEFAULT_MODEL", "invalid-unused-default");

    const thread = new Constructor({
      agent: new Agent({name: "test", instructions: "Test"}),
      model: "openai/gpt-5.4",
    });

    expect(thread.model).toBe("openai/gpt-5.4");
  });

  it.each([CoreThreadRuntimeCoordinator, ThreadRuntimeCoordinator])(
    "resolves explicit coordinator models independently of ambient defaults through %p",
    async (Coordinator) => {
      vi.stubEnv("DEFAULT_MODEL", "invalid-unused-default");
      const store = new TestThreadRuntimeStore();
      const thread = await store.createThread({id: "thread-explicit", sessionId: "session-explicit"});
      const coordinator = new Coordinator({
        store,
        maxConcurrentRuns: 1,
        resolveDefinition: () => ({
          agent: new Agent({name: "test", instructions: "Test"}),
          model: "openai/gpt-5.4",
        }),
      });

      await expect(coordinator.resolveThreadRunConfig(thread)).resolves.toMatchObject({model: "openai/gpt-5.4"});
    },
  );

  it("resolves an unpinned definition at use time without pinning the definition", async () => {
    const store = new TestThreadRuntimeStore();
    const thread = await store.createThread({id: "thread-default", sessionId: "session-default"});
    const definition = Object.freeze({
      agent: new Agent({name: "test", instructions: "Test"}),
      model: undefined,
    });
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      maxConcurrentRuns: 1,
      resolveDefinition: () => definition,
    });
    vi.stubEnv("DEFAULT_MODEL", "openai-codex/gpt-6-astra");
    await expect(coordinator.resolveThreadRunConfig(thread)).resolves.toMatchObject({model: "openai-codex/gpt-6-astra"});

    vi.stubEnv("DEFAULT_MODEL", "anthropic-oauth/claude-opus-4-7");
    await expect(coordinator.resolveThreadRunConfig(thread)).resolves.toMatchObject({model: "anthropic-oauth/claude-opus-4-7"});
    expect(definition.model).toBeUndefined();
  });
});
