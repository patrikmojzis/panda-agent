import type {CommandPolicyDescriptor} from "../../domain/commands/types.js";
import type {SubagentToolGroup} from "../../domain/subagents/tool-groups.js";

export type AgentCommandToolGroup = SubagentToolGroup;

export type AgentCommandPolicyInput = Omit<CommandPolicyDescriptor, "capability" | "toolGroups">;

export type AgentCommandPolicy = Omit<CommandPolicyDescriptor, "capability"> & {
  toolGroups: readonly AgentCommandToolGroup[];
};

/** Build generic command policy metadata from Panda-local tool groups. */
export function agentCommandPolicy(
  toolGroups: readonly AgentCommandToolGroup[],
  policy: AgentCommandPolicyInput = {},
): AgentCommandPolicy {
  return {toolGroups, ...policy};
}
