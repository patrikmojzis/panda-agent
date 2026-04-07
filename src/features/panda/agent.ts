import { Agent, type AgentOptions } from "../agent-core/agent.js";
import type { Tool } from "../agent-core/tool.js";
import { buildPandaPrompt } from "./prompts.js";
import { BashTool, type BashToolOptions } from "./tools/bash-tool.js";
import { MediaTool, type MediaToolOptions } from "./tools/media-tool.js";

export interface PandaAgentOptions<TOutput = unknown> extends Omit<AgentOptions<TOutput>, "tools"> {
  tools?: ReadonlyArray<Tool>;
  includeBashTool?: boolean;
  bashTool?: BashTool;
  bashToolOptions?: BashToolOptions;
  includeMediaTool?: boolean;
  mediaTool?: MediaTool;
  mediaToolOptions?: MediaToolOptions;
  promptAdditions?: string | string[];
}

export function createPandaAgent<TOutput = unknown>(
  options: PandaAgentOptions<TOutput> = {},
): Agent<TOutput> {
  const builtInTools: Tool[] = [];
  if (options.includeBashTool !== false) {
    builtInTools.push(options.bashTool ?? new BashTool(options.bashToolOptions));
  }

  if (options.includeMediaTool !== false) {
    builtInTools.push(options.mediaTool ?? new MediaTool(options.mediaToolOptions));
  }

  return new Agent({
    name: options.name ?? "panda",
    instructions: options.instructions ?? buildPandaPrompt(options.promptAdditions),
    tools: [...builtInTools, ...(options.tools ?? [])],
    outputSchema: options.outputSchema,
  });
}
