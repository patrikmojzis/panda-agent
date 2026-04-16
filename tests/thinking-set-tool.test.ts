import {describe, expect, it, vi} from "vitest";

import {Agent, RunContext, ThinkingSetTool, ToolError,} from "../src/index.js";
import type {PandaSessionContext} from "../src/personas/panda/types.js";
import type {ThinkingLevel} from "@mariozechner/pi-ai";

function createHarness(options: {
  context?: Partial<PandaSessionContext>;
  thinking?: ThinkingLevel;
} = {}) {
  let liveThinking = options.thinking;

  const run = new RunContext<PandaSessionContext>({
    agent: new Agent({
      name: "panda",
      instructions: "Use tools.",
    }),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context: {
      agentKey: "panda",
      sessionId: "session-main",
      threadId: "thread-1",
      ...options.context,
    },
    getThinking: () => liveThinking,
    setThinking: (next) => {
      liveThinking = next;
    },
  });

  return {
    run,
    getThinking: () => liveThinking,
  };
}

describe("ThinkingSetTool", () => {
  it("updates only live thinking when persist is omitted", async () => {
    const persistence = {
      updateThreadThinking: vi.fn(),
    };
    const tool = new ThinkingSetTool({persistence});
    const harness = createHarness({
      context: {
        threadId: "thread-1",
      },
      thinking: "low",
    });

    const result = await tool.run({
      level: "high",
    }, harness.run);

    expect(harness.getThinking()).toBe("high");
    expect(persistence.updateThreadThinking).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      details: {
        requestedLevel: "high",
        liveThinking: "high",
        persistRequested: false,
        persisted: false,
      },
    });
  });

  it("persists the stored thread thinking before updating live thinking", async () => {
    const persistence = {
      updateThreadThinking: vi.fn(async (_threadId: string, thinking: ThinkingLevel | null) => ({
        thinking: thinking ?? undefined,
      })),
    };
    const tool = new ThinkingSetTool({persistence});
    const harness = createHarness({
      context: {
        threadId: "thread-1",
      },
      thinking: "low",
    });

    const result = await tool.run({
      level: "high",
      persist: true,
      reason: "Tool output showed the task is harder.",
    }, harness.run);

    expect(persistence.updateThreadThinking).toHaveBeenCalledWith("thread-1", "high");
    expect(harness.getThinking()).toBe("high");
    expect(result).toMatchObject({
      details: {
        requestedLevel: "high",
        liveThinking: "high",
        persistRequested: true,
        persisted: true,
        storedThinking: "high",
        reason: "Tool output showed the task is harder.",
      },
    });
  });

  it("maps off to cleared live thinking and null persistence", async () => {
    const persistence = {
      updateThreadThinking: vi.fn(async () => ({
        thinking: undefined,
      })),
    };
    const tool = new ThinkingSetTool({persistence});
    const harness = createHarness({
      context: {
        threadId: "thread-1",
      },
      thinking: "medium",
    });

    const result = await tool.run({
      level: "off",
      persist: true,
    }, harness.run);

    expect(persistence.updateThreadThinking).toHaveBeenCalledWith("thread-1", null);
    expect(harness.getThinking()).toBeUndefined();
    expect(result).toMatchObject({
      details: {
        requestedLevel: "off",
        liveThinking: null,
        persistRequested: true,
        persisted: true,
        storedThinking: null,
      },
    });
  });

  it("requires threadId when persistence is requested", async () => {
    const tool = new ThinkingSetTool({
      persistence: {
        updateThreadThinking: vi.fn(),
      },
    });

    await expect(tool.run({
      level: "high",
      persist: true,
    }, createHarness({
      context: {
        threadId: "",
      },
      thinking: "medium",
    }).run)).rejects.toThrow("Persisting thinking requires threadId");
  });

  it("leaves live thinking unchanged when persistence fails", async () => {
    const tool = new ThinkingSetTool({
      persistence: {
        updateThreadThinking: vi.fn(async () => {
          throw new Error("db exploded");
        }),
      },
    });
    const harness = createHarness({
      context: {
        threadId: "thread-1",
      },
      thinking: "medium",
    });

    await expect(tool.run({
      level: "high",
      persist: true,
    }, harness.run)).rejects.toBeInstanceOf(ToolError);
    expect(harness.getThinking()).toBe("medium");
  });

  it("fails when live thinking control is unavailable", async () => {
    const tool = new ThinkingSetTool();
    const run = new RunContext<PandaSessionContext>({
      agent: new Agent({
        name: "panda",
        instructions: "Use tools.",
      }),
      turn: 1,
      maxTurns: 5,
      messages: [],
      context: {
        agentKey: "panda",
        sessionId: "session-main",
        threadId: "thread-1",
      },
    });

    await expect(tool.run({
      level: "high",
    }, run)).rejects.toThrow("Thinking control is unavailable");
  });

  it("does not persist when live thinking control is unavailable", async () => {
    const persistence = {
      updateThreadThinking: vi.fn(),
    };
    const tool = new ThinkingSetTool({persistence});
    const run = new RunContext<PandaSessionContext>({
      agent: new Agent({
        name: "panda",
        instructions: "Use tools.",
      }),
      turn: 1,
      maxTurns: 5,
      messages: [],
      context: {
        agentKey: "panda",
        sessionId: "session-main",
        threadId: "thread-1",
      },
    });

    await expect(tool.run({
      level: "high",
      persist: true,
    }, run)).rejects.toThrow("Live thinking control is unavailable");
    expect(persistence.updateThreadThinking).not.toHaveBeenCalled();
  });
});
