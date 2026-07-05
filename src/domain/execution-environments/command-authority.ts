import type {CommandCatalog} from "../commands/modules.js";
import type {CommandName, CommandPolicyModule} from "../commands/types.js";
import {normalizeAgentSkillOperations} from "./policy.js";
import type {AgentSkillOperation, ExecutionToolPolicy} from "./types.js";

const DEFAULT_AGENT_SKILL_OPERATIONS: readonly AgentSkillOperation[] = ["load", "set", "patch", "delete"];

export interface ResolveCommandLeaseAuthorityInput {
  commandCatalog?: Pick<CommandCatalog, "modules">;
  commandModules?: readonly CommandPolicyModule[];
  toolPolicy?: ExecutionToolPolicy;
  credentialMutationAllowed?: boolean;
  readonlyPostgresCommandAllowed?: boolean;
  identityScoped?: boolean;
}

function agentSkillOperationAllowed(policy: ExecutionToolPolicy | undefined, operation: AgentSkillOperation): boolean {
  const configuredOperations = policy?.agentSkill?.allowedOperations;
  const operations = configuredOperations === undefined
    ? DEFAULT_AGENT_SKILL_OPERATIONS
    : normalizeAgentSkillOperations(configuredOperations);

  return operations.includes(operation);
}

function resolveCommandPolicyModules(
  input: Pick<ResolveCommandLeaseAuthorityInput, "commandCatalog" | "commandModules">,
): readonly CommandPolicyModule[] {
  if (input.commandCatalog && input.commandModules) {
    throw new Error("Pass either commandCatalog or commandModules, not both.");
  }
  if (input.commandCatalog) {
    return input.commandCatalog.modules;
  }

  return input.commandModules ?? [];
}

/**
 * Convert execution tool policy plus command policy metadata into executable command names.
 *
 * This module owns command authority only. It does not mint leases, verify
 * tokens, filter native tools, or know how commands are transported.
 */
export function resolveCommandLeaseAuthority(input: ResolveCommandLeaseAuthorityInput): readonly CommandName[] {
  const policy = input.toolPolicy;
  const allowedTools = new Set(policy?.allowedTools ?? []);
  return resolveCommandPolicyModules(input).flatMap((module) => {
    const modulePolicy = module.policy;
    if (!modulePolicy) {
      return [];
    }
    const capability = modulePolicy.capability ?? module.descriptor.name;
    if (!allowedTools.has(capability)) {
      return [];
    }
    if (modulePolicy.requiresIdentity === true && input.identityScoped !== true) {
      return [];
    }
    if (modulePolicy.requiresCredentialMutation === true && input.credentialMutationAllowed !== true) {
      return [];
    }
    if (
      modulePolicy.requiresReadonlyPostgres === true
      && (
        input.readonlyPostgresCommandAllowed !== true
        || policy?.postgresReadonly?.allowed !== true
      )
    ) {
      return [];
    }
    if (
      modulePolicy.requiredAgentSkillOperation
      && !agentSkillOperationAllowed(policy, modulePolicy.requiredAgentSkillOperation)
    ) {
      return [];
    }

    return [module.descriptor.name];
  });
}
