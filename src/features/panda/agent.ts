import { Agent, type AgentOptions } from "../agent-core/agent.js";
import type { ToolDefinition } from "../agent-core/types.js";
import type { Tool } from "../agent-core/tool.js";
import { buildPandaPrompt } from "./prompts.js";
import { BashTool, type BashToolOptions } from "./tools/bash-tool.js";

export interface PandaAgentOptions<TOutput = unknown> extends Omit<AgentOptions<TOutput>, "tools"> {
  tools?: ReadonlyArray<Tool | ToolDefinition>;
  includeBashTool?: boolean;
  bashTool?: BashTool;
  bashToolOptions?: BashToolOptions;
  promptAdditions?: string | string[];
}

export function createPandaAgent<TOutput = unknown>(
  options: PandaAgentOptions<TOutput> = {},
): Agent<TOutput> {
  const builtInTools =
    options.includeBashTool === false
      ? []
      : [options.bashTool ?? new BashTool(options.bashToolOptions)];

  return new Agent({
    name: options.name ?? "panda",
    instructions: options.instructions ?? buildPandaPrompt(options.promptAdditions),
    model: options.model ?? "gpt-5.1",
    tools: [...builtInTools, ...(options.tools ?? [])],
    outputSchema: options.outputSchema,
    temperature: options.temperature,
    reasoningEffort: options.reasoningEffort,
  });
}
