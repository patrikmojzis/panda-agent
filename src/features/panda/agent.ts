import { Agent, type AgentOptions } from "../agent-core/agent.js";
import type { Tool } from "../agent-core/tool.js";
import { buildPandaPrompt } from "./prompts.js";
import { BashTool } from "./tools/bash-tool.js";
import { MediaTool } from "./tools/media-tool.js";

export interface PandaAgentOptions<TOutput = unknown> extends Omit<AgentOptions<TOutput>, "tools"> {
  tools?: ReadonlyArray<Tool>;
  promptAdditions?: string | string[];
}

export function createPandaAgent<TOutput = unknown>(
  options: PandaAgentOptions<TOutput> = {},
): Agent<TOutput> {
  return new Agent({
    name: options.name ?? "panda",
    instructions: options.instructions ?? buildPandaPrompt(options.promptAdditions),
    tools: [new BashTool(), new MediaTool(), ...(options.tools ?? [])],
    outputSchema: options.outputSchema,
  });
}
