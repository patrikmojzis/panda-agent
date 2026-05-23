import {describe, expect, it, vi} from "vitest";

import {
  Agent,
  type DefaultAgentSessionContext,
  RunContext,
  ToolError,
} from "../src/index.js";
import {
  TodoUpdateTool,
  type TodoUpdateToolOptions,
} from "../src/panda/tools/todo-update-tool.js";

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "todo-update-test-agent",
      instructions: "Use tools.",
    }),
    turn: 0,
    maxTurns: 10,
    messages: [],
    context,
  });
}

function createStoreMock(): TodoUpdateToolOptions["store"] {
  return {
    replaceSessionTodo: vi.fn(async (input) => input.items.length === 0 ? null : ({
      sessionId: input.sessionId,
      items: input.items,
      itemsHash: "hash",
      createdAt: 1,
      updatedAt: 1,
    })),
  };
}

describe("todo_update Panda tool", () => {
  const context: DefaultAgentSessionContext = {
    agentKey: "panda",
    sessionId: "session-main",
    threadId: "thread-main",
  };

  it("replaces the current session todo list without accepting a session id", async () => {
    const store = createStoreMock();
    const tool = new TodoUpdateTool({store});

    const result = await tool.run({
      items: [
        {status: "in_progress", content: "Inspect code"},
        {status: "done", content: "Read plan"},
      ],
    }, createRunContext(context));

    expect(result).toEqual({
      updated: true,
      cleared: false,
      itemCount: 2,
      openItemCount: 1,
      doneItemCount: 1,
    });
    expect(store.replaceSessionTodo).toHaveBeenCalledWith({
      sessionId: "session-main",
      items: [
        {status: "in_progress", content: "Inspect code"},
        {status: "done", content: "Read plan"},
      ],
    });
  });

  it("clears the todo context with an empty list", async () => {
    const store = createStoreMock();
    const tool = new TodoUpdateTool({store});

    await expect(tool.run({items: []}, createRunContext(context))).resolves.toEqual({
      updated: true,
      cleared: true,
      itemCount: 0,
      openItemCount: 0,
      doneItemCount: 0,
    });
    expect(store.replaceSessionTodo).toHaveBeenCalledWith({
      sessionId: "session-main",
      items: [],
    });
  });

  it("rejects stale sessionId and invalid item fields instead of silently dropping them", async () => {
    const store = createStoreMock();
    const tool = new TodoUpdateTool({store});

    await expect(tool.run({
      sessionId: "other-session",
      items: [],
    }, createRunContext(context))).rejects.toBeInstanceOf(ToolError);
    await expect(tool.run({
      items: [{status: "waiting", content: "Nope"}],
    }, createRunContext(context))).rejects.toBeInstanceOf(ToolError);
    await expect(tool.run({
      items: [{status: "pending", content: ""}],
    }, createRunContext(context))).rejects.toBeInstanceOf(ToolError);
    await expect(tool.run({
      items: [{status: "pending", content: "x", priority: "high"}],
    }, createRunContext(context))).rejects.toBeInstanceOf(ToolError);
    expect(store.replaceSessionTodo).not.toHaveBeenCalled();
  });

  it("requires runtime session scope", async () => {
    const tool = new TodoUpdateTool({store: createStoreMock()});

    await expect(tool.run({items: []}, createRunContext({
      agentKey: "panda",
      sessionId: "",
      threadId: "thread-main",
    }))).rejects.toBeInstanceOf(ToolError);
  });
});
