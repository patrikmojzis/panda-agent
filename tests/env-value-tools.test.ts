import {afterEach, describe, expect, it} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";
import {DataType, newDb} from "pg-mem";

import {Agent, RunContext, stringToUserMessage} from "../src/index.js";
import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {
    CredentialCrypto,
    CredentialResolver,
    CredentialService,
    PostgresCredentialStore,
} from "../src/domain/credentials/index.js";
import {ThreadRuntimeCoordinator} from "../src/domain/threads/runtime/index.js";
import {ClearEnvValueTool, SetEnvValueTool} from "../src/panda/index.js";
import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";
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

    const agentStore = new PostgresAgentStore({pool});
    const credentialStore = new PostgresCredentialStore({pool});
    await agentStore.ensureAgentTableSchema();
    await credentialStore.ensureSchema();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
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

  function createContext(overrides: Partial<DefaultAgentSessionContext> = {}): DefaultAgentSessionContext {
    return {
      agentKey: "panda",
      currentInput: {
        source: "tui",
        identityId: "alice-id",
      },
      shell: {
        cwd: process.cwd(),
        env: {},
      },
      ...overrides,
    };
  }

  function createRunContext(
    context: DefaultAgentSessionContext,
    tool: Agent,
  ): RunContext<DefaultAgentSessionContext> {
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

  it("stores and clears agent credentials", async () => {
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
        value: "notion-secret",
      },
      createRunContext(createContext(), agent),
    );
    await setTool.run(
      {
        key: "SLACK_BOT_TOKEN",
        value: "slack-secret",
      },
      createRunContext(createContext(), agent),
    );
    await clearTool.run(
      {
        key: "SLACK_BOT_TOKEN",
      },
      createRunContext(createContext(), agent),
    );

    await expect(credentialStore.getCredential("NOTION_API_KEY", {
      agentKey: "panda",
    })).resolves.toMatchObject({
      agentKey: "panda",
    });
    await expect(credentialStore.getCredential("SLACK_BOT_TOKEN", {
      agentKey: "panda",
    })).resolves.toBeNull();
    await expect(resolver.resolveEnvironment({
      agentKey: "panda",
    })).resolves.toEqual({
      NOTION_API_KEY: "notion-secret",
    });
  });

  it("allows credential writes with no active identity", async () => {
    const {credentialStore, service} = await createHarness();
    const setTool = new SetEnvValueTool({service});
    const clearTool = new ClearEnvValueTool({service});
    const agent = new Agent({
      name: "tool-agent",
      instructions: "Use tools.",
      tools: [setTool, clearTool],
    });

    await setTool.run(
      {
        key: "OPENAI_API_KEY",
        value: "agent-secret",
      },
      createRunContext(createContext({currentInput: undefined}), agent),
    );
    await clearTool.run(
      {
        key: "OPENAI_API_KEY",
      },
      createRunContext(createContext({currentInput: undefined}), agent),
    );

    await expect(credentialStore.getCredential("OPENAI_API_KEY", {
      agentKey: "panda",
    })).resolves.toBeNull();
  });

  it("blocks credential mutation in constrained execution environments", async () => {
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
        value: "nope",
      },
      createRunContext(createContext({
        executionEnvironment: {
          id: "worker-env",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          executionMode: "remote",
          runnerUrl: "http://worker:8080",
          credentialPolicy: {
            mode: "allowlist",
            envKeys: [],
          },
          skillPolicy: {
            mode: "allowlist",
            skillKeys: [],
          },
          toolPolicy: {},
          source: "binding",
        },
      }), agent),
    )).rejects.toThrow("Credential mutation is not allowed");
  });

  it("returns reserved env key errors as tool results so the run can recover", async () => {
    const {service} = await createHarness();
    const runtime = createMockRuntime(
      createAssistantMessage([{
        type: "toolCall",
        id: "call_set_reserved",
        name: "set_env_value",
        arguments: {
          key: "PANDA_CAPITAL_GITHUB_PAT",
          value: "github_pat_secret",
        },
      }]),
      createAssistantMessage([{type: "text", text: "Use GITHUB_PAT instead."}]),
      createAssistantMessage([{type: "text", text: "Nothing else to do."}]),
    );
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-credentials-tool-error",
      sessionId: "session-credentials-tool-error",
      context: {
        sessionId: "session-credentials-tool-error",
        agentKey: "panda",
      },
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
        },
        runtime,
      }),
    });

    await coordinator.submitInput("thread-credentials-tool-error", {
      message: stringToUserMessage("Save this token"),
      source: "tui",
      identityId: "alice-id",
    });
    await coordinator.waitForIdle("thread-credentials-tool-error");

    const runs = await store.listRuns("thread-credentials-tool-error");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "completed",
    });

    const transcript = await store.loadTranscript("thread-credentials-tool-error");
    const toolResult = transcript.find((record) => record.message.role === "toolResult")?.message;

    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolName: "set_env_value",
      isError: true,
    });
    expect(JSON.stringify(toolResult)).toContain(
      "Credential env key PANDA_CAPITAL_GITHUB_PAT is reserved for runtime configuration.",
    );
    expect(JSON.stringify(toolResult)).not.toContain("github_pat_secret");
  });

  it("requires agentKey in runtime context", async () => {
    const {service} = await createHarness();
    const setTool = new SetEnvValueTool({service});
    const agent = new Agent({
      name: "tool-agent",
      instructions: "Use tools.",
      tools: [setTool],
    });

    await expect(setTool.run(
      {
        key: "MISSING_AGENT_SECRET",
        value: "oops",
      },
      createRunContext(createContext({agentKey: ""}), agent),
    )).rejects.toThrow("Credential tools require agentKey");
  });

  it("keeps set_env_value call arguments in history but returns only confirmation facts", async () => {
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
      createAssistantMessage([{type: "text", text: "Nothing else to do."}]),
    );
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-credentials-redaction",
      sessionId: "session-credentials-redaction",
      context: {
        sessionId: "session-credentials-redaction",
        agentKey: "panda",
      },
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
        },
        runtime,
      }),
    });

    await coordinator.submitInput("thread-credentials-redaction", {
      message: stringToUserMessage("Save my key"),
      source: "tui",
      identityId: "alice-id",
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
        value: "sk-live-123456",
      },
    });

    const toolResultText = JSON.stringify(toolResult);
    expect(toolResultText).not.toContain("sk-live-123456");
    expect(toolResultText).toContain("OPENAI_API_KEY");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      details: {
        ok: true,
        envKey: "OPENAI_API_KEY",
        valueLength: 14,
      },
    });
    expect(toolResultText).not.toContain("agentKey");
    expect(toolResultText).not.toContain("updatedAt");
  });
});
