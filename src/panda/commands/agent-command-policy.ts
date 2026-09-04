import type {CommandPolicyDescriptor} from "../../domain/commands/types.js";
import type {CommandCatalog} from "../../domain/commands/modules.js";
import type {ExecutionToolPolicy} from "../../domain/execution-environments/types.js";
import {resolveCommandLeaseAuthority} from "../../domain/execution-environments/command-authority.js";
import type {SubagentToolGroup} from "../../domain/subagents/tool-groups.js";

export type AgentCommandToolGroup = SubagentToolGroup;

export type AgentCommandPolicyInput = Omit<CommandPolicyDescriptor, "toolGroups">;

export type AgentCommandPolicy = CommandPolicyDescriptor & {
  toolGroups: readonly AgentCommandToolGroup[];
};

/** Build generic command policy metadata from Panda-local tool groups. */
export function agentCommandPolicy(
  toolGroups: readonly AgentCommandToolGroup[],
  policy: AgentCommandPolicyInput = {},
): AgentCommandPolicy {
  return {toolGroups, ...policy};
}

/** Project opted-in command capabilities while keeping native tool policy local to Panda. */
export function createDefaultExecutionToolPolicy(catalog: Pick<CommandCatalog, "modules">): ExecutionToolPolicy {
  const policy: ExecutionToolPolicy = {
    allowedTools: [...new Set([
      "bash",
      "background_job_cancel",
      "background_job_status",
      "background_job_wait",
      "view_media",
      ...catalog.modules
        .filter((module) => module.policy.defaultAllowed === true)
        .map((module) => module.policy.capability ?? module.descriptor.name),
    ])],
    agentSkill: {allowedOperations: ["load", "set", "patch", "delete"]},
    bash: {allowed: true},
    postgresReadonly: {allowed: true},
  };
  // Check with every execution gate open: a missing identity or disabled integration
  // must not hide a shared-capability eligibility conflict until later at runtime.
  const admitted = new Set(resolveCommandLeaseAuthority({
    commandCatalog: catalog,
    toolPolicy: policy,
    credentialMutationAllowed: true,
    readonlyPostgresCommandAllowed: true,
    identityScoped: true,
  }));
  for (const module of catalog.modules) {
    if (module.policy.defaultAllowed !== true && admitted.has(module.descriptor.name)) {
      throw new Error(
        `Default command eligibility conflict: ${module.descriptor.name} is not opted in, but its capability ${module.policy.capability ?? module.descriptor.name} is granted by the fallback policy.`,
      );
    }
  }
  return policy;
}
