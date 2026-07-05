import {describe, expect, it} from "vitest";

import {buildDefaultAgentToolsetsFromRegistry, createDefaultAgentToolRegistry,} from "../src/panda/definition.js";
import {
  DEFAULT_AGENT_SUBAGENT_ROLES,
  getDefaultAgentSubagentRolePolicy,
} from "../src/panda/subagents/policy.js";

describe("default agent subagent policy", () => {
  function createBaseToolsets() {
    return buildDefaultAgentToolsetsFromRegistry(createDefaultAgentToolRegistry());
  }

  it("maps roles to explicit specialist toolsets", () => {
    expect(getDefaultAgentSubagentRolePolicy("workspace")).toMatchObject({
      toolset: "workspace",
      thinking: "low",
    });
    expect(getDefaultAgentSubagentRolePolicy("memory")).toMatchObject({
      toolset: "memory",
      thinking: "medium",
    });
    expect(getDefaultAgentSubagentRolePolicy("browser")).toMatchObject({
      toolset: "browser",
      thinking: "medium",
    });
    expect(getDefaultAgentSubagentRolePolicy("skill_maintainer")).toMatchObject({
      toolset: "skill_maintainer",
      thinking: "medium",
    });
  });

  it("marks the old worker toolset as non-runtime by excluding it from every role policy", () => {
    for (const role of DEFAULT_AGENT_SUBAGENT_ROLES) {
      expect(getDefaultAgentSubagentRolePolicy(role).toolset).not.toBe("worker");
    }
  });

  it("builds the workspace toolset with media only", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.workspace.map((tool) => tool.name)).toEqual([
      "view_media",
    ]);
  });

  it("keeps command-backed memory out of the native memory toolset", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.memory.map((tool) => tool.name)).toEqual([]);
  });

  it("gives the browser subagent browser plus media artifact inspection", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.browser.map((tool) => tool.name)).toEqual([
      "view_media",
      "browser",
    ]);
  });

  it("gives the skill maintainer media artifact inspection natively", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.skill_maintainer.map((tool) => tool.name)).toEqual([
      "view_media",
    ]);
  });
});
