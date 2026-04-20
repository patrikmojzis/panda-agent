import {describe, expect, it} from "vitest";

import * as personaExports from "../src/panda/index.js";

const EXPECTED_PERSONA_EXPORTS = [
  "AgentPromptTool",
  "AgentProfileContext",
  "AgentSkillTool",
  "BashJobCancelTool",
  "BashJobStatusTool",
  "BashJobWaitTool",
  "BashTool",
  "BraveSearchTool",
  "BrowserTool",
  "ClearEnvValueTool",
  "DEFAULT_AGENT_LLM_CONTEXT_SECTIONS",
  "DateTimeContext",
  "EnvironmentContext",
  "GlobFilesTool",
  "GrepFilesTool",
  "MediaTool",
  "MessageAgentTool",
  "OutboundTool",
  "DEFAULT_AGENT_INSTRUCTIONS",
  "PostgresReadonlyQueryTool",
  "ReadFileTool",
  "ScheduledTaskCancelTool",
  "ScheduledTaskCreateTool",
  "ScheduledTaskUpdateTool",
  "SetEnvValueTool",
  "SpawnSubagentTool",
  "ThinkingSetTool",
  "WatchCreateTool",
  "WatchDisableTool",
  "WatchSchemaGetTool",
  "WatchUpdateTool",
  "WebFetchTool",
  "WebResearchTool",
  "WhisperTool",
  "WikiTool",
  "buildBashJobPayload",
  "buildDefaultAgentLlmContexts",
  "buildDefaultAgentTools",
  "resolveDefaultAgentModelSelector",
] as const;

const FORBIDDEN_PERSONA_EXPORTS = [
  "DefaultAgentSubagentRunInput",
  "DefaultAgentSubagentRunResult",
  "DefaultAgentSubagentService",
  "DefaultAgentSubagentServiceOptions",
  "summarizeMessageText",
] as const;

describe("panda persona public API", () => {
  it("matches the intentional persona export surface", () => {
    expect(Object.keys(personaExports).sort()).toEqual([...EXPECTED_PERSONA_EXPORTS].sort());
  });

  it("does not leak persona wiring helpers", () => {
    for (const exportName of FORBIDDEN_PERSONA_EXPORTS) {
      expect(personaExports).not.toHaveProperty(exportName);
    }
  });
});
