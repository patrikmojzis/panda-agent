import type {CommandDescriptor} from "../../domain/commands/types.js";
import {DEFAULT_AGENT_COMMAND_CATALOG} from "./agent-command-modules.js";

/**
 * Compatibility projection for callers that only need model-facing command
 * metadata. New command wiring should prefer DEFAULT_AGENT_COMMAND_CATALOG.
 */
export const DEFAULT_AGENT_COMMAND_DESCRIPTORS: readonly CommandDescriptor[] =
  DEFAULT_AGENT_COMMAND_CATALOG.descriptors();
