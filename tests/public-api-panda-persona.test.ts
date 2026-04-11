import {describe, expect, it} from "vitest";

import * as pandaPersona from "../src/personas/panda/index.js";

const EXPECTED_PERSONA_EXPORTS = [
  "AgentDocumentTool",
  "AgentMemoryContext",
  "BashTool",
  "BraveSearchTool",
  "ClearEnvValueTool",
  "DEFAULT_PANDA_LLM_CONTEXT_SECTIONS",
  "DateTimeContext",
  "EnvironmentContext",
  "MediaTool",
  "OutboundTool",
  "PANDA_PROMPT",
  "PANDA_SUBAGENT_ROLE_POLICIES",
  "PostgresReadonlyQueryTool",
  "ScheduledTaskCancelTool",
  "ScheduledTaskCreateTool",
  "ScheduledTaskUpdateTool",
  "SetEnvValueTool",
  "SpawnSubagentTool",
  "WebFetchTool",
  "WebResearchTool",
  "WhisperTool",
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
