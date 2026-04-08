import type { Tool } from "../agent-core/tool.js";
import { BashTool } from "./tools/bash-tool.js";
import { MediaTool } from "./tools/media-tool.js";

export function buildPandaTools(extraTools: ReadonlyArray<Tool> = []): ReadonlyArray<Tool> {
  return [new BashTool(), new MediaTool(), ...extraTools];
}
