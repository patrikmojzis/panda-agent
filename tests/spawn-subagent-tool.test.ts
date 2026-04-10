import {describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";

import {
    Agent,
    type LlmRuntime,
    type LlmRuntimeRequest,
    type PandaSessionContext,
    type ResolvedThreadDefinition,
    RunContext,
    SpawnSubagentTool,
    stringToUserMessage,
    type ThreadRecord,
    Tool,
    ToolError,
    z,
} from "../src/index.js";
import {PandaSubagentService} from "../src/features/panda/subagents/service.js";

class FakeBashTool extends Tool<typeof FakeBashTool.schema, PandaSessionContext> {
  static schema = z.object({
    command: z.string(),
  });

  name = "bash";
  description = "Fake bash";
  schema = FakeBashTool.schema;

  async handle(args: z.output<typeof FakeBashTool.schema>): Promise<{ command: string }> {
    return {
      command: args.command,
    };
  }
}

class FakeAgentDocumentTool extends Tool<typeof FakeAgentDocumentTool.schema, PandaSessionContext> {
  static schema = z.object({
    target: z.string(),
  });

  name = "agent_document";
  description = "Blocked in explore";
  schema = FakeAgentDocumentTool.schema;

  async handle(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

class FakeOutboundTool extends Tool<typeof FakeOutboundTool.schema, PandaSessionContext> {
  static schema = z.object({
    message: z.string(),
  });

  name = "outbound";
  description = "Blocked in explore";
  schema = FakeOutboundTool.schema;

  async handle(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

function createAssistantMessage(
  content: AssistantMessage["content"],
): AssistantMessage {
  const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";

  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function createThreadRecord(): ThreadRecord {
    return {
      id: "thread-1",
      identityId: "alice-id",
      agentKey: "panda",
      model: "openai/gpt-5.1",
      context: {
        cwd: "/workspace/panda",
        identityId: "alice-id",
      identityHandle: "alice",
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function createParentRunContext(agent: Agent, overrides: Partial<PandaSessionContext> = {}): RunContext<PandaSessionContext> {
  return new RunContext({
    agent,
    turn: 1,
    maxTurns: 5,
    messages: [stringToUserMessage("parent transcript secret")],
    context: {
      threadId: "thread-1",
      agentKey: "panda",
      identityId: "alice-id",
      identityHandle: "alice",
      cwd: "/workspace/panda",
      subagentDepth: 0,
      ...overrides,
    },
  });
}

describe("SpawnSubagentTool", () => {
  it("runs a fresh scoped child and returns a structured result", async () => {
    const requests: LlmRuntimeRequest[] = [];
    const runtime: LlmRuntime = {
      complete: vi.fn().mockImplementation(async (request: LlmRuntimeRequest) => {
        requests.push(request);
        if (requests.length === 1) {
          return createAssistantMessage([{
            type: "toolCall",
            id: "call_1",
            name: "bash",
            arguments: {
              command: "pwd",
            },
          }]);
        }

        return createAssistantMessage([{
          type: "text",
          text: "Investigated the repo and found the answer.",
        }]);
      }),
      stream: vi.fn(() => {
        throw new Error("stream not expected");
      }),
    };
    const threadRecord = createThreadRecord();
    const service = new PandaSubagentService({
      store: {
        getThread: vi.fn(async () => threadRecord),
      } as any,
      resolveDefinition: vi.fn(async () => ({
        agent: new Agent({
          name: "panda",
          instructions: "Parent Panda instructions",
        }),
        systemPrompt: "Parent system prompt",
        runtime,
        model: "openai/gpt-parent",
      } satisfies ResolvedThreadDefinition)),
      maxSubagentDepth: 1,
    });
    const tool = new SpawnSubagentTool({ service });
    const agent = new Agent({
      name: "panda",
      instructions: "Parent Panda instructions",
      tools: [
        tool,
        new FakeBashTool(),
        new FakeAgentDocumentTool(),
        new FakeOutboundTool(),
      ],
    });

    const result = await tool.run({
      role: "explore",
      task: "Inspect the codebase for subagent hooks.",
      context: "Focus on runtime wiring.",
      model: "openai/gpt-child",
    }, createParentRunContext(agent));

    expect(result).toMatchObject({
      details: {
        role: "explore",
        finalMessage: "Investigated the repo and found the answer.",
        toolCallCount: 1,
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.providerName).toBe("openai");
    expect(requests[0]?.modelId).toBe("gpt-child");
    expect(requests[0]?.context.messages).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.context.messages)).toContain("Inspect the codebase for subagent hooks.");
    expect(JSON.stringify(requests[0]?.context.messages)).toContain("Focus on runtime wiring.");
    expect(JSON.stringify(requests[0]?.context.messages)).not.toContain("parent transcript");
    expect(requests[0]?.context.systemPrompt).toContain("You are Panda's explore subagent.");
    expect(requests[0]?.context.systemPrompt).toContain("**Current DateTime:**");
    expect(requests[0]?.context.systemPrompt).toContain("**Environment Overview:**");
    expect(requests[0]?.context.systemPrompt).not.toContain("**Agent Workspace:**");
    expect(requests[0]?.context.tools?.map((toolDef) => toolDef.name)).toEqual(["bash"]);
  });

  it("enforces the configured subagent depth limit", async () => {
    const service = new PandaSubagentService({
      store: {
        getThread: vi.fn(async () => createThreadRecord()),
      } as any,
      resolveDefinition: vi.fn(async () => ({
        agent: new Agent({
          name: "panda",
          instructions: "Parent Panda instructions",
        }),
      } satisfies ResolvedThreadDefinition)),
      maxSubagentDepth: 1,
    });
    const tool = new SpawnSubagentTool({ service });
    const agent = new Agent({
      name: "panda",
      instructions: "Parent Panda instructions",
      tools: [tool, new FakeBashTool()],
    });

    await expect(tool.run({
      role: "explore",
      task: "Inspect.",
    }, createParentRunContext(agent, {
      subagentDepth: 1,
    }))).rejects.toBeInstanceOf(ToolError);
  });

  it("wraps child runtime failures as tool errors", async () => {
    const runtime: LlmRuntime = {
      complete: vi.fn(async () => {
        throw new Error("model exploded");
      }),
      stream: vi.fn(() => {
        throw new Error("stream not expected");
      }),
    };
    const service = new PandaSubagentService({
      store: {
        getThread: vi.fn(async () => createThreadRecord()),
      } as any,
      resolveDefinition: vi.fn(async () => ({
        agent: new Agent({
          name: "panda",
          instructions: "Parent Panda instructions",
        }),
        runtime,
      } satisfies ResolvedThreadDefinition)),
      maxSubagentDepth: 1,
    });
    const tool = new SpawnSubagentTool({ service });
    const agent = new Agent({
      name: "panda",
      instructions: "Parent Panda instructions",
      tools: [tool, new FakeBashTool()],
    });

    await expect(tool.run({
      role: "explore",
      task: "Inspect.",
    }, createParentRunContext(agent))).rejects.toThrow("Subagent failed: model exploded");
  });
});
