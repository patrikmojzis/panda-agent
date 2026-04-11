import {afterEach, describe, expect, it} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";
import {DataType, newDb} from "pg-mem";

import {Agent, RunContext, stringToUserMessage, ToolError,} from "../src/index.js";
import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {
    CredentialCrypto,
    CredentialResolver,
    CredentialService,
    PostgresCredentialStore,
} from "../src/domain/credentials/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {ThreadRuntimeCoordinator} from "../src/domain/threads/runtime/index.js";
import {ClearEnvValueTool, SetEnvValueTool} from "../src/personas/panda/index.js";
import type {PandaSessionContext} from "../src/personas/panda/types.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

describe("Env value tools", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createHarness() {
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

    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const credentialStore = new PostgresCredentialStore({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await credentialStore.ensureSchema();

    await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      documents: {},
    });

    const crypto = new CredentialCrypto("tool-test-master-key");
    const service = new CredentialService({
      store: credentialStore,
      crypto,
    });
    const resolver = new CredentialResolver({
      store: credentialStore,
      crypto,
    });

    return {
      credentialStore,
      resolver,
      service,
    };
  }

  function createContext(): PandaSessionContext {
    return {
      agentKey: "panda",
      identityId: "alice-id",
      shell: {
        cwd: process.cwd(),
        env: {},
      },
    };
  }

  function createRunContext(
    context: PandaSessionContext,
    tool: Agent,
  ): RunContext<PandaSessionContext> {
    return new RunContext({
      agent: tool,
      turn: 1,
      maxTurns: 5,
      messages: [],
      context,
    });
  }

  function createAssistantMessage(
    content: AssistantMessage["content"],
  ): AssistantMessage {
    return {
      role: "assistant",
      content,
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
      stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
  }

  function createMockRuntime(...responses: AssistantMessage[]) {
    return {
      complete: async () => {
        const next = responses.shift();
        if (!next) {
          throw new Error("No more runtime responses queued.");
        }

        return next;
      },
      stream: () => {
        throw new Error("Streaming was not expected in this test.");
      },
    };
  }

  class LeaseManager {
    async tryAcquire(threadId: string) {
      return {
        threadId,
        release: async () => {},
      };
    }
  }

  it("defaults to relationship scope and allows explicit agent scope", async () => {
    const {credentialStore, resolver, service} = await createHarness();
    const setTool = new SetEnvValueTool({service});
    const clearTool = new ClearEnvValueTool({service});
    const agent = new Agent({
      name: "tool-agent",
      instructions: "Use tools.",
      tools: [setTool, clearTool],
    });

    await setTool.run(
      {
        key: "NOTION_API_KEY",
        value: "relationship-secret",
      },
      createRunContext(createContext(), agent),
    );
    await setTool.run(
      {
        key: "SLACK_BOT_TOKEN",
        value: "agent-secret",
        scope: "agent",
      },
      createRunContext(createContext(), agent),
    );

    await expect(credentialStore.getCredentialExact("NOTION_API_KEY", {
      scope: "relationship",
      agentKey: "panda",
      identityId: "alice-id",
    })).resolves.toMatchObject({
      scope: "relationship",
    });
    await expect(credentialStore.getCredentialExact("SLACK_BOT_TOKEN", {
      scope: "agent",
      agentKey: "panda",
    })).resolves.toMatchObject({
      scope: "agent",
    });
    await expect(resolver.resolveEnvironment({
      agentKey: "panda",
      identityId: "alice-id",
    })).resolves.toEqual({
      NOTION_API_KEY: "relationship-secret",
      SLACK_BOT_TOKEN: "agent-secret",
    });
  });

  it("rejects identity scope from the agent tool surface", async () => {
    const {service} = await createHarness();
    const setTool = new SetEnvValueTool({service});
    const agent = new Agent({
      name: "tool-agent",
      instructions: "Use tools.",
      tools: [setTool],
    });

    await expect(setTool.run(
      {
        key: "OPENAI_API_KEY",
        value: "sk-live-123",
        scope: "identity",
      } as never,
      createRunContext(createContext(), agent),
    )).rejects.toBeInstanceOf(ToolError);
  });

  it("redacts secret tool call arguments before they hit the transcript", async () => {
    const {service} = await createHarness();
    const runtime = createMockRuntime(
      createAssistantMessage([{
        type: "toolCall",
        id: "call_set_1",
        name: "set_env_value",
        arguments: {
          key: "OPENAI_API_KEY",
          value: "sk-live-123456",
        },
      }]),
      createAssistantMessage([{type: "text", text: "Saved it."}]),
    );
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-credentials-redaction",
      agentKey: "panda",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new LeaseManager(),
      resolveDefinition: async () => ({
        agent: new Agent({
          name: "panda",
          instructions: "Use tools.",
          tools: [new SetEnvValueTool({service})],
        }),
        context: {
          ...createContext(),
          identityId: "local",
        },
        runtime,
      }),
    });

    await coordinator.submitInput("thread-credentials-redaction", {
      message: stringToUserMessage("Save my key"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-credentials-redaction");

    const transcript = await store.loadTranscript("thread-credentials-redaction");
    const assistant = transcript[1]?.message;
    const toolResult = transcript[2]?.message;

    expect(assistant?.role).toBe("assistant");
    const firstAssistantBlock = assistant && "content" in assistant ? assistant.content[0] : undefined;
    expect(firstAssistantBlock).toMatchObject({
      type: "toolCall",
      name: "set_env_value",
      arguments: {
        key: "OPENAI_API_KEY",
        value: "[redacted]",
      },
    });

    const toolResultText = JSON.stringify(toolResult);
    expect(toolResultText).not.toContain("sk-live-123456");
    expect(toolResultText).toContain("OPENAI_API_KEY");
  });
});
