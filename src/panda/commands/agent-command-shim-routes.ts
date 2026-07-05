import {
  type CommandRouteProjection,
} from "../../domain/commands/modules.js";
import {DEFAULT_AGENT_COMMAND_CATALOG} from "./agent-command-modules.js";

export type AgentCommandShimRoute = CommandRouteProjection;

/**
 * Compatibility projection for the generated shim route block.
 *
 * The native shell parser is still handwritten, but generic help/json routes
 * now follow the command module catalog instead of a second manual table.
 */
export const DEFAULT_AGENT_COMMAND_SHIM_ROUTES: readonly AgentCommandShimRoute[] =
  DEFAULT_AGENT_COMMAND_CATALOG.routes();
