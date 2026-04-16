import {describe, expect, it} from "vitest";

import * as pandaPersona from "../src/personas/panda/index.js";

const EXPECTED_PERSONA_EXPORTS = [
  "AgentDocumentTool",
  "AgentMemoryContext",
  "AgentSkillTool",
  "BashJobCancelTool",
  "BashJobStatusTool",
  "BashJobWaitTool",
  "BashTool",
  "BraveSearchTool",
  "BrowserTool",
  "ClearEnvValueTool",
  "DEFAULT_PANDA_LLM_CONTEXT_SECTIONS",
  "DateTimeContext",
  "EnvironmentContext",
  "GlobFilesTool",
  "GrepFilesTool",
  "MediaTool",
  "OutboundTool",
  "PANDA_PROMPT",
  "PANDA_SUBAGENT_ROLE_POLICIES",
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
  "WatchUpdateTool",
  "WebFetchTool",
  "WebResearchTool",
  "WhisperTool",
  "buildBashJobPayload",
  "buildPandaLlmContexts",
  "buildPandaTools",
  "filterToolsForSubagentRole",
  "getPandaSubagentRolePolicy",
  "resolveDefaultPandaModelSelector",
] as const;

const FORBIDDEN_PERSONA_EXPORTS = [
  "PandaSubagentRunInput",
  "PandaSubagentRunResult",
  "PandaSubagentService",
  "PandaSubagentServiceOptions",
  "summarizeMessageText",
] as const;

describe("panda persona public API", () => {
  it("matches the intentional persona export surface", () => {
    expect(Object.keys(pandaPersona).sort()).toEqual([...EXPECTED_PERSONA_EXPORTS]);
  });

  it("does not leak persona wiring helpers", () => {
    for (const exportName of FORBIDDEN_PERSONA_EXPORTS) {
      expect(pandaPersona).not.toHaveProperty(exportName);
    }
  });
});
