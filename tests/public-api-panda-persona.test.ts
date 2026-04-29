import {describe, expect, it} from "vitest";

import * as personaExports from "../src/panda/index.js";

const EXPECTED_PERSONA_EXPORTS = [
  "AgentPromptTool",
  "AgentProfileContext",
  "AgentSkillTool",
  "BackgroundJobCancelTool",
  "BackgroundJobStatusTool",
  "BackgroundJobWaitTool",
  "BashTool",
  "BraveSearchTool",
  "BrowserTool",
  "CalendarAgendaContext",
  "CalendarTool",
  "ClearEnvValueTool",
  "DEFAULT_AGENT_LLM_CONTEXT_SECTIONS",
  "DateTimeContext",
  "EnvironmentContext",
  "GlobFilesTool",
  "GrepFilesTool",
  "ImageGenerateTool",
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
  "TelepathyScreenshotTool",
  "ThinkingSetTool",
  "WatchCreateTool",
  "WatchDisableTool",
  "WatchSchemaGetTool",
  "WatchUpdateTool",
  "WebFetchTool",
  "WebResearchTool",
  "WhisperTool",
  "WikiTool",
  "buildBackgroundJobOutput",
  "buildBackgroundJobPayload",
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
