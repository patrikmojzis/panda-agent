import {describe, expect, it, vi} from "vitest";

import {gatherContexts} from "../src/index.js";
import {gatherContextsForRuntime} from "../src/kernel/agent/llm-context.js";
import {SessionTodoContext} from "../src/panda/contexts/session-todo-context.js";
import type {SessionTodoRecord} from "../src/domain/sessions/todos.js";
import {renderSessionTodoContext} from "../src/prompts/contexts/session-todo.js";

function buildTodo(overrides: Partial<SessionTodoRecord> = {}): SessionTodoRecord {
  return {
    sessionId: "session-main",
    items: [
      {status: "in_progress", content: "Inspect context assembly"},
      {status: "pending", content: "Add tests"},
      {status: "blocked", content: "Wait for approval"},
      {status: "done", content: "Read plan"},
    ],
    itemsHash: "hash-one",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("SessionTodoContext", () => {
  it("renders an ordered compact checklist for the current session", async () => {
    const store = {
      readSessionTodo: vi.fn(async () => buildTodo()),
    };
    const dump = await gatherContexts([
      new SessionTodoContext({store, sessionId: "session-main"}),
    ]);

    expect(store.readSessionTodo).toHaveBeenCalledWith("session-main");
    expect(dump).toContain("**Todo Context:**");
    expect(dump).toContain("TODO:");
    expect(dump).toContain("- [in_progress] Inspect context assembly");
    expect(dump).toContain("- [pending] Add tests");
    expect(dump).toContain("- [blocked] Wait for approval");
    expect(dump).toContain("- [done] Read plan");
  });

  it("omits the context when there is no todo state", async () => {
    const context = new SessionTodoContext({
      store: {
        readSessionTodo: vi.fn(async () => null),
      },
      sessionId: "session-main",
    });

    await expect(context.getContent()).resolves.toBe("");
    await expect(gatherContexts([context])).resolves.toBe("");
  });

  it("caps done-heavy lists and emits omitted counts", () => {
    const content = renderSessionTodoContext({
      items: Array.from({length: 7}, (_, index) => ({
        status: "done" as const,
        content: `completed ${index + 1}`,
      })),
    });

    expect(content).toContain("TODO:");
    expect(content).not.toContain("completed 1");
    expect(content).not.toContain("completed 2");
    expect(content).toContain("completed 3");
    expect(content).toContain("completed 7");
    expect(content).toContain("2 done todo item(s) omitted");
  });

  it("provides a prompt-cache part that changes with todo state", async () => {
    const first = await gatherContextsForRuntime([
      new SessionTodoContext({
        store: {readSessionTodo: async () => buildTodo()},
        sessionId: "session-main",
      }),
    ]);
    const second = await gatherContextsForRuntime([
      new SessionTodoContext({
        store: {readSessionTodo: async () => buildTodo({itemsHash: "hash-two", updatedAt: 3})},
        sessionId: "session-main",
      }),
    ]);

    expect(first.promptCacheKeyParts).toEqual(["todo:hash-one:2"]);
    expect(second.promptCacheKeyParts).toEqual(["todo:hash-two:3"]);
    expect(second.promptCacheKeyParts).not.toEqual(first.promptCacheKeyParts);
  });
});
