import {describe, expect, it} from "vitest";

import type {SubagentProfileRecord} from "../src/domain/subagents/types.js";
import {SubagentsContext} from "../src/panda/contexts/subagents-context.js";

const NOW = new Date("2026-05-08T12:00:00.000Z").getTime();

function profile(slug = "workspace"): SubagentProfileRecord {
  return {
    slug,
    description: `${slug} profile`,
    prompt: `${slug} prompt body must not render`,
    toolGroups: ["core"],
    transcriptMode: "none",
    source: "builtin",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("SubagentsContext", () => {
  it("renders only the stable available profile catalog", async () => {
    const context = new SubagentsContext({
      subagentProfiles: {
        listProfiles: async () => [
          profile("workspace"),
          {...profile("custom"), source: "custom", agentKey: "panda"},
        ],
      },
      agentKey: "panda",
    });

    const first = await context.getContent();
    const second = await context.getContent();

    expect(first).toBe(second);
    expect(first).toContain("Available subagent profiles:");
    expect(first).toContain("workspace (builtin): workspace profile");
    expect(first).toContain("custom (custom): custom profile");
    expect(first).not.toContain("prompt body must not render");
    expect(first).not.toContain("Agent workspace subagents:");
    expect(first).not.toContain("Isolated environment subagents:");
    expect(first).not.toContain("Subagents omitted from default context:");
    expect(first).not.toContain("last activity");
    expect(first).not.toContain("2026-");
  });

  it("caps profiles without reading runtime inventory", async () => {
    const profiles = Array.from({length: 3}, (_, index) => profile(`profile_${index}`));
    const context = new SubagentsContext({
      subagentProfiles: {listProfiles: async () => profiles},
      agentKey: "panda",
      maxProfiles: 2,
    });

    const rendered = await context.getContent();

    expect(rendered).toContain("profile_0");
    expect(rendered).toContain("profile_1");
    expect(rendered).not.toContain("profile_2");
    expect(rendered).toContain("1 additional profiles omitted");
  });
});
