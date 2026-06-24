import {describe, expect, it} from "vitest";
import {buildDefaultAgentLlmContexts, gatherContexts} from "../src/index.js";
import {resolveSessionPromptCacheKey, resolveThreadPromptCacheKey} from "../src/domain/threads/runtime/prompt-cache-key.js";
import type {SessionPromptRecord} from "../src/domain/sessions/index.js";

const basePrompt: SessionPromptRecord = {
  sessionId: "session-a",
  slug: "brief",
  content: "Always follow the deploy checklist.",
  createdAt: 1,
  updatedAt: 2,
};

const memoryPrompt: SessionPromptRecord = {
  sessionId: "session-a",
  slug: "memory",
  content: "The deploy window is Fridays.",
  createdAt: 1,
  updatedAt: 2,
};

const heartbeatPrompt: SessionPromptRecord = {
  sessionId: "session-a",
  slug: "heartbeat",
  content: "Check in.",
  createdAt: 1,
  updatedAt: 2,
};

const agentStore = {
  listAgentSkills: async () => [],
};

describe("SessionPromptsContext", () => {
  it("renders after the shared agent profile and only for the current session", async () => {
    const sessionStore = {
      listSessionPrompts: async (sessionId: string) => sessionId === "session-a" ? [basePrompt, memoryPrompt] : [],
    };

    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {cwd: "/workspace", agentKey: "panda", sessionId: "session-a", threadId: "thread-a", subagentDepth: 0},
      agentKey: "panda",
      agentStore,
      sessionStore,
      sections: ["skills", "session_prompts"],
    }));

    expect(dump).toContain("**Agent Profile:**");
    expect(dump).toContain("**Session Prompts:**");
    expect(dump).toContain("[brief]\nAlways follow the deploy checklist.");
    expect(dump).toContain("[memory]\nThe deploy window is Fridays.");
    expect(dump.indexOf("**Agent Profile:**")).toBeLessThan(dump.indexOf("**Session Prompts:**"));

    const otherDump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {cwd: "/workspace", agentKey: "panda", sessionId: "session-b", threadId: "thread-b", subagentDepth: 0},
      agentKey: "panda",
      agentStore,
      sessionStore,
      sections: ["skills", "session_prompts"],
    }));
    expect(otherDump).toContain("**Agent Profile:**");
    expect(otherDump).not.toContain("**Session Prompts:**");
    expect(otherDump).not.toContain("deploy checklist");
  });

  it("changes the prompt cache key when any rendered session prompt is set or edited", () => {
    const base = resolveThreadPromptCacheKey("thread-one");
    const first = resolveSessionPromptCacheKey(base, [basePrompt, memoryPrompt, heartbeatPrompt]);
    const editedSameTimestamp = resolveSessionPromptCacheKey(base, [{
      ...basePrompt,
      content: "Use the edited checklist.",
    }, memoryPrompt, heartbeatPrompt]);
    const editedTimestamp = resolveSessionPromptCacheKey(base, [{
      ...basePrompt,
      updatedAt: 3,
    }, memoryPrompt, heartbeatPrompt]);
    const heartbeatEdited = resolveSessionPromptCacheKey(base, [
      basePrompt,
      memoryPrompt,
      {
        ...heartbeatPrompt,
        content: "Edited heartbeat.",
        updatedAt: 3,
      },
    ]);

    expect(resolveSessionPromptCacheKey(base, null)).toBe(base);
    expect(first).not.toBe(base);
    expect(editedSameTimestamp).not.toBe(first);
    expect(editedTimestamp).not.toBe(first);
    expect(heartbeatEdited).toBe(first);
  });

  it("keeps session prompt cache keys within the provider limit", () => {
    const base = resolveThreadPromptCacheKey("00000000-0000-4000-8000-000000000000");
    const withSessionPrompt = resolveSessionPromptCacheKey(base, [basePrompt, memoryPrompt]);

    expect(withSessionPrompt.length).toBeLessThanOrEqual(64);
  });

  it("bounds explicit prompt cache keys before provider dispatch", () => {
    const longStoredKey = `thread:${"stored-thread-key-".repeat(5)}`;
    const base = resolveThreadPromptCacheKey("thread-one", longStoredKey);
    const withSessionPrompt = resolveSessionPromptCacheKey(base, [basePrompt]);

    expect(base.length).toBeLessThanOrEqual(64);
    expect(withSessionPrompt.length).toBeLessThanOrEqual(64);
    expect(base).not.toBe(longStoredKey);
    expect(resolveSessionPromptCacheKey(longStoredKey, null).length).toBeLessThanOrEqual(64);
  });
});
