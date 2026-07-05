import {describe, expect, it} from "vitest";

import * as personaExports from "../src/panda/index.js";

const EXPECTED_PERSONA_EXPORTS = [
  "AgentProfileContext",
  "BackgroundJobCancelTool",
  "BackgroundJobStatusTool",
  "BackgroundJobWaitTool",
  "BashTool",
  "BrowserTool",
  "CommandCatalogContext",
  "DEFAULT_AGENT_LLM_CONTEXT_SECTIONS",
  "DEFAULT_AGENT_COMMAND_CATALOG",
  "DEFAULT_AGENT_COMMAND_MODULES",
  "DateTimeContext",
  "EnvironmentContext",
  "MediaTool",
  "PairedIdentitiesContext",
  "DEFAULT_AGENT_INSTRUCTIONS",
  "SessionPromptsContext",
  "SubagentsContext",
  "ThinkingSetTool",
  "agentCommandPolicy",
  "buildBackgroundJobOutput",
  "buildBackgroundJobPayload",
  "buildDefaultAgentCommandModules",
  "buildDefaultAgentLlmContexts",
  "buildDefaultAgentTools",
  "createDefaultAgentCommandCatalog",
  "resolveDefaultAgentModelSelector",
] as const;

describe("panda persona public API", () => {
  it("matches the intentional persona export surface", () => {
    expect(Object.keys(personaExports).sort()).toEqual([...EXPECTED_PERSONA_EXPORTS].sort());
  });
});
