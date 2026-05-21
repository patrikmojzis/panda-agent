import {describe, expect, it} from "vitest";
import {buildDefaultAgentLlmContexts, gatherContexts} from "../src/index.js";
import {resolveSessionPromptCacheKey, resolveThreadPromptCacheKey} from "../src/domain/threads/runtime/prompt-cache-key.js";
import type {SessionPromptRecord} from "../src/domain/sessions/index.js";

const basePrompt: SessionPromptRecord = {
  sessionId: "session-a",
  slug: "session",
  content: "Always follow the deploy checklist.",
  createdAt: 1,
  updatedAt: 2,
};

const agentStore = {
  readAgentPrompt: async () => ({
    agentKey: "panda",
    slug: "agent" as const,
    content: "Shared agent prompt.",
    createdAt: 1,
    updatedAt: 1,
  }),
  listAgentSkills: async () => [],
};

describe("SessionBriefingContext", () => {
  it("renders after the shared agent profile and only for the current session", async () => {
    const sessionStore = {
      readSessionPrompt: async (sessionId: string) => sessionId === "session-a" ? basePrompt : null,
    };

    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {cwd: "/workspace", agentKey: "panda", sessionId: "session-a", threadId: "thread-a", subagentDepth: 0},
      agentKey: "panda",
      agentStore,
      sessionStore,
      sections: ["prompts", "session_briefing"],
    }));

    expect(dump).toContain("**Agent Profile:**");
    expect(dump).toContain("Shared agent prompt.");
    expect(dump).toContain("**Session Briefing:**");
    expect(dump).toContain("[session]\nAlways follow the deploy checklist.");
    expect(dump.indexOf("**Agent Profile:**")).toBeLessThan(dump.indexOf("**Session Briefing:**"));

    const otherDump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {cwd: "/workspace", agentKey: "panda", sessionId: "session-b", threadId: "thread-b", subagentDepth: 0},
      agentKey: "panda",
      agentStore,
      sessionStore,
      sections: ["prompts", "session_briefing"],
    }));
    expect(otherDump).toContain("**Agent Profile:**");
    expect(otherDump).not.toContain("**Session Briefing:**");
    expect(otherDump).not.toContain("deploy checklist");
  });

  it("changes the prompt cache key when a session briefing is set or edited", () => {
    const base = resolveThreadPromptCacheKey("thread-one");
    const first = resolveSessionPromptCacheKey(base, basePrompt);
    const editedSameTimestamp = resolveSessionPromptCacheKey(base, {
      ...basePrompt,
      content: "Use the edited checklist.",
    });
    const editedTimestamp = resolveSessionPromptCacheKey(base, {
      ...basePrompt,
      updatedAt: 3,
    });

    expect(resolveSessionPromptCacheKey(base, null)).toBe(base);
    expect(first).not.toBe(base);
    expect(editedSameTimestamp).not.toBe(first);
    expect(editedTimestamp).not.toBe(first);
  });
});
