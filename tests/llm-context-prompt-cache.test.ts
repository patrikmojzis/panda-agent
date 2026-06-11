import {describe, expect, it} from "vitest";
import type {AssistantMessage} from "@earendil-works/pi-ai";

import {Agent, LlmContext, Thread} from "../src/index.js";
import type {LlmRuntime, LlmRuntimeRequest} from "../src/kernel/agent/runtime.js";

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{type: "text", text}],
    api: "openai-responses",
    model: "openai/gpt-5.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

class VersionedContext extends LlmContext {
  override name = "Versioned";

  constructor(private readonly readVersion: () => string) {
    super();
  }

  async getContent(): Promise<string> {
    return `version ${this.readVersion()}`;
  }

  override async getSnapshot() {
    const version = this.readVersion();
    return {
      content: `version ${version}`,
      promptCacheKeyPart: `version:${version}`,
    };
  }
}

class CapturingRuntime implements LlmRuntime {
  readonly requests: LlmRuntimeRequest[] = [];

  async complete(request: LlmRuntimeRequest): Promise<AssistantMessage> {
    this.requests.push(request);
    return assistant("ok");
  }

  stream(): never {
    throw new Error("stream not used");
  }
}

describe("LLM context prompt-cache parts", () => {
  it("changes the provider prompt-cache key when a context cache part changes", async () => {
    let version = "one";
    const runtime = new CapturingRuntime();
    const thread = new Thread({
      agent: new Agent({name: "cache-test", instructions: "Use context."}),
      messages: [],
      promptCacheKey: "thread:cache-test",
      llmContexts: [new VersionedContext(() => version)],
      runtime,
    });

    for await (const _event of thread.run()) {
      // drain
    }
    version = "two";
    for await (const _event of thread.run()) {
      // drain
    }

    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[0]?.promptCacheKey).toBeDefined();
    expect(runtime.requests[1]?.promptCacheKey).toBeDefined();
    expect(runtime.requests[0]?.promptCacheKey).not.toBe(runtime.requests[1]?.promptCacheKey);
    expect(runtime.requests[0]?.promptCacheKey?.length).toBeLessThanOrEqual(64);
    expect(runtime.requests[1]?.promptCacheKey?.length).toBeLessThanOrEqual(64);
    expect(runtime.requests[0]?.context.systemPrompt).toContain("version one");
    expect(runtime.requests[1]?.context.systemPrompt).toContain("version two");
  });
});
