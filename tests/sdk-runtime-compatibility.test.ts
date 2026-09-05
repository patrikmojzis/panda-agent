import {EventEmitter} from "node:events";

import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@earendil-works/pi-ai";

import {Agent, createRuntime, RunPipeline, stringToUserMessage, Thread, type LlmRuntime, type ThreadOptions} from "../src/index.js";
import {ThreadRuntimeCoordinator, type ResolvedThreadDefinition, type ThreadRuntimeCoordinatorOptions} from "../src/app/sdk/thread-runtime.js";
import {bootstrapRuntime} from "../src/app/runtime/runtime-bootstrap.js";
import {createCommandCatalog} from "../src/domain/commands/modules.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

vi.mock("../src/app/runtime/runtime-bootstrap.js", () => ({bootstrapRuntime: vi.fn()}));

const forms = ["plain", "inherited", "non-enumerable", "private-getters"] as const;
type Form = typeof forms[number];

function configuration<T extends object>(values: T, form: Form): T {
  if (form === "plain") return Object.freeze(values);
  if (form === "inherited") return Object.freeze(Object.create(values));
  if (form === "non-enumerable") {
    return Object.freeze(Object.defineProperties({}, Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, {value}]),
    ))) as T;
  }
  class PrivateConfiguration {
    #values = values as Record<string, unknown>;
    get agent() { return this.#values.agent; }
    get model() { return this.#values.model; }
    get thinking() { return this.#values.thinking; }
    get runtime() { return this.#values.runtime; }
    get context() { return this.#values.context; }
    get messages() { return this.#values.messages; }
    get runPipelines() { return this.#values.runPipelines; }
    get store() { return this.#values.store; }
    get resolveDefinition() { return this.#values.resolveDefinition; }
    get maxConcurrentRuns() { return this.#values.maxConcurrentRuns; }
  }
  return Object.freeze(new PrivateConfiguration()) as T;
}

function fakeRuntime(): LlmRuntime {
  return {
    async complete(): Promise<AssistantMessage> {
      return {
        role: "assistant", content: [{type: "text", text: "done"}],
        api: "openai-responses", provider: "openai", model: "gpt-5.4", stopReason: "stop", timestamp: Date.now(),
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
      };
    },
    async *stream() { throw new Error("Unexpected streaming request."); },
  };
}

async function runCoordinator(coordinator: ThreadRuntimeCoordinator, store: TestThreadRuntimeStore): Promise<void> {
  await coordinator.handleStoreNotificationStatus("listening");
  await coordinator.start({source: "panda-core", connectorKey: "test", holderId: "sdk-compatibility"});
  await coordinator.submitInput("sdk-thread", {message: stringToUserMessage("hello"), source: "tui"});
  await coordinator.waitForIdle("sdk-thread");
  expect((await store.listRuns("sdk-thread")).map((run) => run.status)).toEqual(["completed"]);
}

afterEach(() => vi.unstubAllEnvs());

describe("configured SDK constructors", () => {
  it.each(forms)("reads frozen %s Thread options without losing configuration", async (form) => {
    vi.stubEnv("DEFAULT_MODEL", "openai/gpt-5.4");
    const agent = new Agent({name: "configured", instructions: "reply"});
    const context = {label: "caller context"};
    const message = stringToUserMessage("hello");
    const options = configuration<ThreadOptions>({agent, context, messages: [message], model: undefined, thinking: "low", runtime: fakeRuntime()}, form);
    const thread = new Thread(options);
    expect(thread.agent).toBe(agent);
    expect(thread.context).toBe(context);
    expect(thread.messages).toEqual([message]);
    expect(thread.model).toBe("openai/gpt-5.4");
    expect(thread.thinking).toBe("low");
    expect(await thread.runToCompletion()).toMatchObject({content: [{type: "text", text: "done"}]});
    expect(options.model).toBeUndefined();
    expect(Object.isFrozen(options)).toBe(true);
  });

  it("retains Thread subclass construction and does not widen subclass instanceof", () => {
    vi.stubEnv("DEFAULT_MODEL", "invalid-unused-default");
    class CustomThread extends Thread<{label: string}> {
      #label = "subclass";
      readLabel() { return this.#label; }
    }
    const options = Object.freeze({agent: new Agent(), model: "openai/gpt-5.4", context: {label: "context"}});
    const custom = new CustomThread(options);
    expect(custom).toBeInstanceOf(CustomThread);
    expect(custom).toBeInstanceOf(Thread);
    expect(custom.constructor).toBe(CustomThread);
    expect(custom.readLabel()).toBe("subclass");
    expect(new Thread(options)).not.toBeInstanceOf(CustomThread);
  });

  it.each(forms)("runs with frozen %s coordinator options and definitions", async (form) => {
    vi.stubEnv("DEFAULT_MODEL", "openai/gpt-5.4");
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "sdk-thread", sessionId: "sdk-session"});
    const context = {label: "durable context"};
    let completedTurns = 0;
    class Pipeline extends RunPipeline {
      async preflight(thread: Thread) {
        expect(thread).toBeInstanceOf(Thread);
        expect(thread.context).toMatchObject(context);
        expect(thread.model).toBe("openai/gpt-5.4");
      }
      async postflight(thread: Thread) {
        expect(thread).toBeInstanceOf(Thread);
        completedTurns += 1;
      }
    }
    const definition = configuration<ResolvedThreadDefinition>({
      agent: new Agent({name: "durable", instructions: "reply"}), context, model: undefined, thinking: "high",
      runtime: fakeRuntime(), runPipelines: [new Pipeline()],
    }, form);
    const options = configuration<ThreadRuntimeCoordinatorOptions>({store, maxConcurrentRuns: 1, resolveDefinition: () => definition}, form);
    const coordinator = new ThreadRuntimeCoordinator(options);
    try {
      expect(await coordinator.resolveThreadRunConfig("sdk-thread")).toMatchObject({model: "openai/gpt-5.4", thinking: "high"});
      await runCoordinator(coordinator, store);
      expect(completedTurns).toBeGreaterThan(0);
      expect(definition.model).toBeUndefined();
    } finally {
      await coordinator.stop();
    }
  });

  it("retains coordinator subclass construction without recognizing ordinary coordinators as subclasses", async () => {
    class CustomCoordinator extends ThreadRuntimeCoordinator {
      #label = "subclass";
      readLabel() { return this.#label; }
    }
    const options = {store: new TestThreadRuntimeStore(), maxConcurrentRuns: 1,
      resolveDefinition: () => ({agent: new Agent(), model: "openai/gpt-5.4"})};
    const custom = new CustomCoordinator(options);
    const ordinary = new ThreadRuntimeCoordinator(options);
    try {
      expect(custom).toBeInstanceOf(CustomCoordinator);
      expect(custom).toBeInstanceOf(ThreadRuntimeCoordinator);
      expect(custom.constructor).toBe(CustomCoordinator);
      expect(custom.readLabel()).toBe("subclass");
      expect(ordinary).not.toBeInstanceOf(CustomCoordinator);
    } finally {
      await custom.stop();
      await ordinary.stop();
    }
  });
});

describe("createRuntime definition compatibility", () => {
  it.each(forms)("preserves %s definitions through its real coordinator and public pipeline", async (form) => {
    vi.stubEnv("DEFAULT_MODEL", "openai/gpt-5.4");
    const store = new TestThreadRuntimeStore();
    await store.createThread({id: "sdk-thread", sessionId: "sdk-session"});
    const client = Object.assign(new EventEmitter(), {query: async () => ({rows: []}), release() {}});
    const pool = {connect: async () => client, query: async () => ({rows: []})};
    vi.mocked(bootstrapRuntime).mockResolvedValue({
      pool, notificationPool: pool, store, commandCatalog: createCommandCatalog([]),
      commandExecutor: {registerCommands() {}}, backgroundJobService: {setBackgroundCompletionHandler() {}},
      close: async () => {},
    } as Awaited<ReturnType<typeof bootstrapRuntime>>);
    let completedTurns = 0;
    class Pipeline extends RunPipeline {
      async preflight(thread: Thread) { expect(thread).toBeInstanceOf(Thread); }
      async postflight() { completedTurns += 1; }
    }
    const definition = configuration<ResolvedThreadDefinition>({agent: new Agent(), model: undefined, thinking: "high",
      runtime: fakeRuntime(), runPipelines: [new Pipeline()]}, form);
    const runtime = await createRuntime({dbUrl: "postgres://unused", resolveDefinition: () => definition});
    try {
      expect(runtime.coordinator).toBeInstanceOf(ThreadRuntimeCoordinator);
      expect(await runtime.coordinator.resolveThreadRunConfig("sdk-thread")).toMatchObject({model: "openai/gpt-5.4", thinking: "high"});
      await runCoordinator(runtime.coordinator, store);
      expect(completedTurns).toBeGreaterThan(0);
      expect(definition.model).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});
